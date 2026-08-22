/**
 * BL-2 — least privilege исполняется в РАБОТАЮЩЕМ пути, а не только в миграции.
 *
 * Аудит I02A показал: роли создавались и проверялись, но приложение подключалось под
 * SUPERUSER-ом с BYPASSRLS, поэтому append-only `world_events` не держался ничем. Здесь
 * проверяется, что весь канонический путь команды проходит под `zona_worker`, и что этот же
 * коннект не может переписать историю.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { RUNTIME_ID_PREFIXES, type Command } from '@zona/contracts';
import { DerivedIdFactory } from '@zona/domain';
import { createMigratedDatabase, type MigratedDatabase } from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import { createDatabase, parseDatabaseConnectionUrl, type DatabaseConnection } from './database.ts';
import { LOCAL_DEV_ROLE_PASSWORD, ROLE_NAMES } from './migrations/0003-roles-and-grants.ts';
import { executeCommand } from './command-handler.ts';
import { initializeWorld, loadWorldState } from './world-repository.ts';

const ids = new DerivedIdFactory('i02a-runtime-role');

describe('BL-2 — канонический путь под рантайм-ролью', () => {
  let migrated: MigratedDatabase;
  let worker: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('runtime_role');
    const url = new URL(migrated.testDb.url);
    url.username = ROLE_NAMES.worker;
    url.password = LOCAL_DEV_ROLE_PASSWORD;
    worker = createDatabase({ ...parseDatabaseConnectionUrl(url.toString()), maxConnections: 4 });
  });

  afterAll(async () => {
    await worker.destroy();
    await migrated.close();
  });

  it('рантайм-роль не является superuser и не имеет BYPASSRLS', async () => {
    const attributes = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      select rolsuper, rolbypassrls from pg_roles where rolname = ${ROLE_NAMES.worker}
    `.execute(worker);
    expect(attributes.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    // Проверка сделана ЭТИМ подключением, то есть роль и правда та, под которой идёт рантайм.
    const current = await sql<{ current_user: string }>`select current_user`.execute(worker);
    expect(current.rows[0]?.current_user).toBe(ROLE_NAMES.worker);
  });

  it('весь путь init -> run -> read проходит под zona_worker', async () => {
    await initializeWorld(worker, fixtureInitialization());

    const command: Command = {
      command_id: ids.next(RUNTIME_ID_PREFIXES.command),
      world_id: FIXTURE_WORLD_ID,
      type: 'journey.start',
      schema_version: 1,
      actor_id: FIXTURE_AGENT_ID,
      issued_at_world_time: FIXTURE_WORLD_TIME,
      expected_world_version: 0,
      correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
      payload: { route_id: FIXTURE_ROUTE_ID },
    };
    const result = await executeCommand(worker, command);
    expect(result.outcome).toBe('accepted');

    const state = await loadWorldState(worker, FIXTURE_WORLD_ID);
    expect(state?.agents[FIXTURE_AGENT_ID]?.status).toBe('traveling');
  });

  it('та же рантайм-роль не может переписать записанную историю', async () => {
    await expect(
      worker
        .updateTable('world_events')
        .set({ type: 'tampered' })
        .where('world_id', '=', FIXTURE_WORLD_ID)
        .execute(),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      worker.deleteFrom('world_events').where('world_id', '=', FIXTURE_WORLD_ID).execute(),
    ).rejects.toThrow(/permission denied/i);
  });
});
