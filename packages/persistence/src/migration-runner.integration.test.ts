import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './database.ts';
import { computeChecksum } from './migration-ledger.ts';
import { migrations } from './migrations/index.ts';
import {
  DEFAULT_ADVISORY_LOCK_KEY,
  MigrationChecksumMismatchError,
  MigrationLockTimeoutError,
  runMigrations,
  type Logger,
} from './migration-runner.ts';

/** Тесты полагаются на живой Docker daemon (`docker info`). Один контейнер на файл. */
const IMAGE = 'postgis/postgis:17-3.5';

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('runMigrations — integration (PostgreSQL/PostGIS через Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Kysely<Database>;

  /**
   * Независимая сессия (свой `Pool`, не соединение из pool-а `db`) — единственный способ
   * реально доказать, что advisory lock снят: `pg_advisory_lock` реентерабелен в пределах
   * ОДНОЙ сессии, поэтому проверка тем же `db` прошла бы даже с забытым `unlock`
   * (см. находку ревьюера: оба прогона `runMigrations` переиспользуют одно и то же connection
   * из pool-а, второй `pg_advisory_lock` реентерабельно проходит без освобождения первого).
   * `pg_try_advisory_lock` из независимой сессии — единственный источник истины: `true`
   * означает, что lock свободен ПРЯМО СЕЙЧАС, а не то, что его когда-то держала эта сессия.
   */
  async function assertAdvisoryLockIsFree(key: number): Promise<void> {
    const probe = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      max: 1,
    });
    try {
      const result = await probe.query<{ locked: boolean }>(
        'select pg_try_advisory_lock($1) as locked',
        [key],
      );
      expect(result.rows[0]?.locked).toBe(true);
      await probe.query('select pg_advisory_unlock($1)', [key]);
    } finally {
      await probe.end();
    }
  }

  beforeAll(async () => {
    // `postgis/postgis` публикует только linux/amd64 (нет arm64-манифеста); Docker Desktop
    // на Apple Silicon запускает его через эмуляцию — платформа фиксируется явно, чтобы
    // не зависеть от архитектуры host-машины.
    container = await new PostgreSqlContainer(IMAGE).withPlatform('linux/amd64').start();
    db = createDatabase({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
    });
  }, 180_000);

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it('применяет 0001_bootstrap на пустой БД: журнал миграций, расширение postgis, lock свободен после успеха', async () => {
    const report = await runMigrations({ db, migrations, logger: silentLogger });

    expect(report.skipped).toEqual([]);
    expect(report.applied).toHaveLength(1);
    expect(report.applied[0]?.id).toBe('0001');
    expect(report.applied[0]?.name).toBe('bootstrap');
    expect(report.applied[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.schemaVersion).toBe('0001');

    const rows = await db.selectFrom('schema_migrations').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('0001');
    expect(rows[0]?.name).toBe('bootstrap');

    const extensions = await sql<{ extname: string }>`
      select extname from pg_extension where extname = 'postgis'
    `.execute(db);
    expect(extensions.rows).toHaveLength(1);

    // BLOCKER-фикс: доказываем освобождение lock-а из НЕЗАВИСИМОЙ сессии, а не переиспользуя
    // соединение из пула `db` (см. комментарий на `assertAdvisoryLockIsFree`).
    await assertAdvisoryLockIsFree(DEFAULT_ADVISORY_LOCK_KEY);
  });

  it('повторный запуск ничего не применяет (идемпотентность)', async () => {
    const report = await runMigrations({ db, migrations, logger: silentLogger });

    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual([{ id: '0001', name: 'bootstrap' }]);
    expect(report.schemaVersion).toBe('0001');

    const rows = await db.selectFrom('schema_migrations').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('порча checksum в журнале приводит к MIGRATION_CHECKSUM_MISMATCH, ничего не меняет, lock свободен после ошибки', async () => {
    const validChecksum = computeChecksum(migrations[0]!);

    await db
      .updateTable('schema_migrations')
      .set({ checksum: 'corrupted-checksum' })
      .where('id', '=', '0001')
      .execute();

    await expect(runMigrations({ db, migrations, logger: silentLogger })).rejects.toThrow(
      MigrationChecksumMismatchError,
    );

    const rows = await db.selectFrom('schema_migrations').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.checksum).toBe('corrupted-checksum');

    // BLOCKER-фикс: runner не должен зависать: advisory lock снят даже после ошибки —
    // независимая сессия захватывает lock немедленно (а не ждёт того, кто его никогда не освободит).
    await assertAdvisoryLockIsFree(DEFAULT_ADVISORY_LOCK_KEY);

    // Второй вызов на всё ещё испорченном журнале падает так же (lock не остался занят
    // с прошлого раза — иначе этот вызов завис бы, а не упал с тем же MIGRATION_CHECKSUM_MISMATCH).
    await expect(runMigrations({ db, migrations, logger: silentLogger })).rejects.toThrow(
      MigrationChecksumMismatchError,
    );
    await assertAdvisoryLockIsFree(DEFAULT_ADVISORY_LOCK_KEY);

    // Возвращаем журнал в валидное состояние — иначе все последующие тесты файла тоже
    // видели бы испорченный checksum.
    await db
      .updateTable('schema_migrations')
      .set({ checksum: validChecksum })
      .where('id', '=', '0001')
      .execute();
  });

  it('MIGRATION_LOCK_TIMEOUT, если advisory lock занят другой сессией — без бесконечного ожидания', async () => {
    const holder = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
      max: 1,
    });

    try {
      // Держим lock из независимой сессии, как это делал бы завис-ший/долгий deploy.
      const lockResult = await holder.query<{ locked: boolean }>(
        'select pg_try_advisory_lock($1) as locked',
        [DEFAULT_ADVISORY_LOCK_KEY],
      );
      expect(lockResult.rows[0]?.locked).toBe(true);

      const start = Date.now();
      await expect(
        runMigrations({
          db,
          migrations,
          logger: silentLogger,
          // Маленькие значения — тест не должен ждать реальный production-budget (~5с).
          advisoryLockAttempts: 3,
          advisoryLockRetryDelayMs: 50,
        }),
      ).rejects.toThrow(MigrationLockTimeoutError);
      const elapsedMs = Date.now() - start;

      // 3 попытки с интервалом 50мс — верхняя граница разумного ожидания, не "зависло".
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      await holder.query('select pg_advisory_unlock($1)', [DEFAULT_ADVISORY_LOCK_KEY]);
      await holder.end();
    }

    // После освобождения чужой сессией runner снова проходит нормально (идемпотентный skip).
    const report = await runMigrations({ db, migrations, logger: silentLogger });
    expect(report.skipped).toEqual([{ id: '0001', name: 'bootstrap' }]);
    await assertAdvisoryLockIsFree(DEFAULT_ADVISORY_LOCK_KEY);
  });
});
