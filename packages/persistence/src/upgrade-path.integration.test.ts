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
 *
 * Мир до обновления пишется ЯВНЫМ SQL прежней поставки, а не текущим `initializeWorld` (M4).
 * Раньше здесь стоял он, и это работало ровно пока писатель не менялся: миграция 0009 добавила
 * `worlds.prng_stream_positions`, текущий писатель стал его заполнять, и тест упал на схеме N-1 —
 * то есть модель «предыдущей поставки» использовала писателя ПОСЛЕДУЮЩЕЙ. Смысл фазы `expand`
 * ровно обратный: старый писатель обязан работать против новой схемы, а не новый против старой.
 * Обещание теста («данные предыдущей поставки переживают обновление») не изменилось и не
 * ослаблено — изменилось только то, чем эти данные создаются.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { sql } from 'kysely';
import { createDatabase, parseDatabaseConnectionUrl, type DatabaseConnection } from './database.ts';
import { createTestDatabase, type TestDatabase } from './__fixtures__/test-database.ts';
import { fixtureInitialization, FIXTURE_WORLD_ID } from './__fixtures__/world-fixture.ts';
import { migrations } from './migrations/index.ts';
import { runMigrations, type Logger } from './migration-runner.ts';
import { applyGrants, ensureApplicationRoles } from './principals.ts';
import { TEST_ROLE_PASSWORD } from './__fixtures__/migrated-database.ts';
import { loadWorldState } from './world-repository.ts';

const SILENT: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Колонки `worlds` в поставке N-1: ровно те, что были до миграции 0009. */
const PREVIOUS_RELEASE_WORLD_COLUMNS =
  'world_id, seed, version, last_sequence, world_time, rules_version, content_version, ' +
  'schema_version, created_at';

describe('N-1 — обновление с предыдущей поставки', () => {
  let testDb: TestDatabase;
  let db: DatabaseConnection;

  /**
   * Пишет мир так, как это делала бы ПРЕДЫДУЩАЯ поставка: перечислением её колонок, без единого
   * поля, добавленного последней миграцией. Использовать здесь `initializeWorld` нельзя — это
   * писатель текущей поставки (см. докстринг файла).
   */
  const writePreviousReleaseWorld = async (): Promise<void> => {
    const init = fixtureInitialization();
    const state = init.state;
    await sql`
      insert into worlds (${sql.raw(PREVIOUS_RELEASE_WORLD_COLUMNS)})
      values (
        ${state.worldId}, ${init.seed}, ${state.worldVersion}, ${state.sequence},
        ${state.worldTime}, ${init.versions.rulesVersion}, ${init.versions.contentVersion},
        ${init.versions.schemaVersion}, now()
      )
    `.execute(db);

    for (const location of init.content.locations) {
      await sql`
        insert into locations (world_id, location_id, name, description)
        values (${state.worldId}, ${location.id}, ${location.name}, ${location.description})
      `.execute(db);
    }
    for (const route of Object.values(state.routes)) {
      await sql`
        insert into routes (world_id, route_id, from_location_id, to_location_id, travel_minutes)
        values (${state.worldId}, ${route.id}, ${route.fromLocationId}, ${route.toLocationId},
                ${route.travelMinutes})
      `.execute(db);
    }
    for (const agent of Object.values(state.agents)) {
      await sql`
        insert into agents (world_id, agent_id, name, location_id, status, route_id)
        values (${state.worldId}, ${agent.id}, ${init.content.agentNames[agent.id] ?? agent.id},
                ${agent.locationId}, ${agent.status}, ${agent.routeId})
      `.execute(db);
    }
  };

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
    await writePreviousReleaseWorld();

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
