/**
 * N-1 — путь ОБНОВЛЕНИЯ: база предыдущей поставки доводится до текущей схемы, данные целы.
 *
 * До этого теста покрытия обновления в проекте не было вообще. B1 проверяет «на пустой и на
 * существующей схеме», но «существующая» там означает «та же поставка, прогнанная дважды».
 * Класс дефектов «применённая миграция отредактирована» проходил незамеченным — им и оказался
 * blocker N-1 повторного аудита.
 *
 * «Предыдущая поставка» здесь моделируется честно: применяются ТОЛЬКО первые N-1 миграций
 * реестра, в базу пишется настоящий мир, и только потом накатывается полный реестр.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createDatabase, parseDatabaseConnectionUrl, type DatabaseConnection } from './database.ts';
import { createTestDatabase, type TestDatabase } from './__fixtures__/test-database.ts';
import { fixtureInitialization, FIXTURE_WORLD_ID } from './__fixtures__/world-fixture.ts';
import { migrations } from './migrations/index.ts';
import { runMigrations, type Logger } from './migration-runner.ts';
import { applyGrants, ensureApplicationRoles } from './principals.ts';
import { TEST_ROLE_PASSWORD } from './__fixtures__/migrated-database.ts';
import { initializeWorld, loadWorldState } from './world-repository.ts';

const SILENT: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('N-1 — обновление с предыдущей поставки', () => {
  let testDb: TestDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    testDb = await createTestDatabase('upgrade_path');
    db = createDatabase(parseDatabaseConnectionUrl(testDb.url));
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  it('журнал предыдущей поставки доводится до текущей схемы без потери данных', async () => {
    const previous = migrations.slice(0, -1);
    expect(previous.length).toBeGreaterThan(0);

    // 1. Состояние «предыдущей поставки».
    await runMigrations({ db, migrations: previous, logger: SILENT });
    await ensureApplicationRoles(db, TEST_ROLE_PASSWORD);
    // Гранты здесь НЕ применяются намеренно: матрица описывает текущую схему и упоминает
    // таблицу, которой в предыдущей поставке ещё нет. Это не дефект, а порядок: `world migrate`
    // применяет гранты ПОСЛЕ миграций, и модель обновления обязана повторять этот порядок,
    // а не изобретать свой (найдено исполнением при написании теста).
    await initializeWorld(db, fixtureInitialization());

    const appliedBefore = await db
      .selectFrom('schema_migrations')
      .select('id')
      .orderBy('id')
      .execute();
    expect(appliedBefore.map((row) => row.id)).toEqual(previous.map((m) => m.id));

    // 2. Обновление до текущего реестра.
    const report = await runMigrations({ db, migrations, logger: SILENT });
    expect(report.applied.map((entry) => entry.id)).toEqual([
      migrations[migrations.length - 1]!.id,
    ]);

    // 3. Схема текущая, данные целы, гранты переприменяются без сбоя.
    await applyGrants(db);
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    expect(state?.worldId).toBe(FIXTURE_WORLD_ID);
    expect(Object.keys(state?.agents ?? {})).toHaveLength(2);

    const appliedAfter = await db
      .selectFrom('schema_migrations')
      .select('id')
      .orderBy('id')
      .execute();
    expect(appliedAfter.map((row) => row.id)).toEqual(migrations.map((m) => m.id));
  });

  it('отредактированная выпущенная миграция даёт названный отказ, а не порчу схемы', async () => {
    // Тот самый класс, которым оказался blocker N-1: id переиспользован под другим смыслом.
    // Здесь он обязан быть громким отказом ДО применения чего бы то ни было.
    const client = new Client({ connectionString: testDb.url });
    await client.connect();
    try {
      await client.query(
        `update schema_migrations set name = 'renamed-after-release' where id = $1`,
        [migrations[2]!.id],
      );
    } finally {
      await client.end();
    }

    try {
      await expect(runMigrations({ db, migrations, logger: SILENT })).rejects.toThrow(
        /MIGRATION_NAME_MISMATCH/,
      );

      // Схема не тронута: отказ произошёл до применения.
      const state = await loadWorldState(db, FIXTURE_WORLD_ID);
      expect(state?.worldId).toBe(FIXTURE_WORLD_ID);
    } finally {
      // p-4: журнал возвращается в исходное состояние. Без этого следующий добавленный в файл
      // тест получал бы MIGRATION_NAME_MISMATCH по ЧУЖОЙ причине, и сейчас всё работает лишь
      // потому, что этот тест последний — то есть держится на порядке, а не на инварианте.
      const restore = new Client({ connectionString: testDb.url });
      await restore.connect();
      try {
        await restore.query(`update schema_migrations set name = $2 where id = $1`, [
          migrations[2]!.id,
          migrations[2]!.name,
        ]);
      } finally {
        await restore.end();
      }
    }
  });

  it('после уборки предыдущего теста миграции снова применяются штатно', () => {
    // Явная проверка того, что уборка работает: этот тест зелёный только если журнал
    // действительно восстановлен.
    return expect(runMigrations({ db, migrations, logger: SILENT })).resolves.toMatchObject({
      applied: [],
    });
  });
});
