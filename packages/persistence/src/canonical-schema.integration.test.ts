/**
 * B1 — миграция канонических таблиц применяется на пустой и на существующей схеме.
 *
 * Механику самого runner-а (журнал, checksum, advisory lock, phase conflict) проверяет
 * `migration-runner.integration.test.ts` из I00. Здесь — только то, что добавила I02A:
 * состав схемы, идемпотентность повторного прогона и сохранность уже записанного мира.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createMigratedDatabase, type MigratedDatabase } from './__fixtures__/migrated-database.ts';
import { dumpSchema } from './__fixtures__/test-database.ts';
import { fixtureInitialization, FIXTURE_WORLD_ID } from './__fixtures__/world-fixture.ts';
import { migrations } from './migrations/index.ts';
import { runMigrations, type Logger } from './migration-runner.ts';
import { initializeWorld, loadWorldState } from './world-repository.ts';

const SILENT_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('B1 — канонические таблицы I02A', () => {
  let migrated: MigratedDatabase;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('canonical_schema');
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('создаёт ровно ожидаемый состав таблиц', async () => {
    const client = new Client({ connectionString: migrated.testDb.url });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
          order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'agents',
        'command_attempt_rejections',
        'command_results',
        'locations',
        'outbox',
        // I03: таблицы observer projection. Они не канонические — их содержимое выводится из
        // журнала и пересобирается (D7), — но живут в той же базе, поэтому обязаны быть в этом
        // списке: тест ловит НЕЗАЯВЛЕННУЮ таблицу, а не «таблицу не того сорта».
        'projection_agents',
        'projection_events',
        'projection_locations',
        'projection_routes',
        'projection_state',
        'routes',
        'scheduled_actions',
        'schema_migrations',
        'spatial_ref_sys', // из postgis, миграция 0001
        'world_events',
        'world_snapshots',
        'worlds',
      ]);
    } finally {
      await client.end();
    }
  });

  it('журнал содержит все миграции реестра ровно по одному разу', async () => {
    const applied = await migrated.db
      .selectFrom('schema_migrations')
      .select(['id', 'name'])
      .orderBy('id')
      .execute();
    expect(applied).toEqual(migrations.map((m) => ({ id: m.id, name: m.name })));
  });

  it('повторный прогон идемпотентен: схема побайтово та же, ничего не применено', async () => {
    const before = await dumpSchema(migrated.testDb.url);
    const report = await runMigrations({
      db: migrated.db,
      migrations,
      logger: SILENT_LOGGER,
    });
    expect(report.applied).toEqual([]);
    expect(report.skipped.map((entry) => entry.id)).toEqual(migrations.map((m) => m.id));
    expect(await dumpSchema(migrated.testDb.url)).toBe(before);
  });

  it('повторный прогон на базе с уже записанным миром сохраняет его', async () => {
    await initializeWorld(migrated.db, fixtureInitialization());
    await runMigrations({ db: migrated.db, migrations, logger: SILENT_LOGGER });
    const state = await loadWorldState(migrated.db, FIXTURE_WORLD_ID);
    expect(state?.worldId).toBe(FIXTURE_WORLD_ID);
    expect(Object.keys(state?.agents ?? {})).toHaveLength(2);
  });
});
