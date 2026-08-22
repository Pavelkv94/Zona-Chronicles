/**
 * C2, C3, C4, C12 — worker доводит journey до конца, не трогает ненаступившее,
 * обрабатывает в стабильном порядке и не двигает мировое время назад.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ID_PREFIXES, type Command } from '@zona/contracts';
import { DerivedIdFactory } from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_END_LOCATION_ID,
  FIXTURE_OTHER_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { executeCommand } from './command-handler.ts';
import { runWorldTick } from './scheduler.ts';
import { initializeWorld, loadWorldEvents, loadWorldState } from './world-repository.ts';

const ids = new DerivedIdFactory('i02b-scheduler');

const start = (actorId: string, expectedVersion: number): Command => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: actorId,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: expectedVersion,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
});

describe('C2/C3/C4/C12 — шаг worker-а', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('scheduler');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  afterEach(async () => {
    await truncateWorldData(db);
  });

  it('C3: ненаступившее действие не исполняется и время не двигается', async () => {
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, start(FIXTURE_AGENT_ID, 0));

    // Мировое время всё ещё 06:00, действие наступает в 06:40.
    const result = await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-1' });
    expect(result.claimed).toBe(0);
    expect(result.worldTime).toBe(FIXTURE_WORLD_TIME);
    expect(await db.selectFrom('world_events').selectAll().execute()).toHaveLength(1);
  });

  it('C2: наступившее действие завершает путь и продвигает мировое время', async () => {
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, start(FIXTURE_AGENT_ID, 0));

    // Мир доводится до момента прибытия тем же способом, что и в жизни: время двигает
    // обработанное действие. Здесь достаточно сдвинуть часы мира вручную — это делает
    // следующий tick, потому что due_at уже наступил относительно нового времени.
    await db
      .updateTable('worlds')
      .set({ world_time: '2028-04-26T06:40:00.000Z' })
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .execute();

    const result = await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-1' });
    expect(result.claimed).toBe(1);
    expect(result.executed[0]?.outcome).toBe('accepted');

    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    expect(state?.agents[FIXTURE_AGENT_ID]).toEqual({
      id: FIXTURE_AGENT_ID,
      locationId: FIXTURE_END_LOCATION_ID,
      status: 'idle',
      routeId: null,
    });
    // Расписание опустело, но строка осталась помеченной выполненной (C2).
    expect(Object.keys(state?.scheduledActions ?? {})).toHaveLength(0);
    const rows = await db.selectFrom('scheduled_actions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completed_at).toBeInstanceOf(Date);

    const events = await loadWorldEvents(db, FIXTURE_WORLD_ID);
    expect(events.map((event) => event.type)).toEqual(['journey.started', 'journey.completed']);
    expect(events[1]?.world_time).toBe('2028-04-26T06:40:00.000Z');
  });

  it('C4: порядок обработки воспроизводится между независимыми прогонами', async () => {
    const order = async (): Promise<readonly string[]> => {
      await truncateWorldData(db);
      await initializeWorld(db, fixtureInitialization());
      await executeCommand(db, start(FIXTURE_AGENT_ID, 0));
      await executeCommand(db, start(FIXTURE_OTHER_AGENT_ID, 1));
      await db
        .updateTable('worlds')
        .set({ world_time: '2028-04-26T06:40:00.000Z' })
        .where('world_id', '=', FIXTURE_WORLD_ID)
        .execute();
      await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-1' });
      const events = await loadWorldEvents(db, FIXTURE_WORLD_ID);
      return events.filter((e) => e.type === 'journey.completed').map((e) => e.actor_ids[0]!);
    };

    const first = await order();
    const second = await order();
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    // Оба действия имеют ОДИНАКОВЫЙ due_at, поэтому порядок задан entity_id — и он
    // предсказуем, а не «какой получился».
    expect([...first]).toEqual([...first].sort());
  });

  it('C12: мировое время не может пойти назад', async () => {
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, start(FIXTURE_AGENT_ID, 0));
    await db
      .updateTable('worlds')
      .set({ world_time: '2028-04-26T08:00:00.000Z' })
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .execute();

    // due_at действия (06:40) уже позади: попытка исполнить его сдвинула бы время назад.
    await expect(
      runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-1' }),
    ).rejects.toThrow(/мировое время не может идти назад/);
  });
});
