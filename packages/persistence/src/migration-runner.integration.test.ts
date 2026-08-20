import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './database.ts';
import { migrations } from './migrations/index.ts';
import { MigrationChecksumMismatchError, runMigrations, type Logger } from './migration-runner.ts';

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

  it('применяет 0001_bootstrap на пустой БД: журнал миграций и расширение postgis', async () => {
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
  });

  it('повторный запуск ничего не применяет (идемпотентность)', async () => {
    const report = await runMigrations({ db, migrations, logger: silentLogger });

    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual([{ id: '0001', name: 'bootstrap' }]);
    expect(report.schemaVersion).toBe('0001');

    const rows = await db.selectFrom('schema_migrations').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('порча checksum в журнале приводит к MIGRATION_CHECKSUM_MISMATCH и ничего не меняет', async () => {
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

    // Runner не должен зависать: advisory lock снят даже после ошибки — следующий вызов проходит
    // (а не висит в ожидании lock, который никто не освободил).
    await expect(runMigrations({ db, migrations, logger: silentLogger })).rejects.toThrow(
      MigrationChecksumMismatchError,
    );
  });
});
