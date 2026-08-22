/**
 * C1 — принятая команда планирует своё завершение, в ТОЙ ЖЕ транзакции.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ID_PREFIXES, type Command } from '@zona/contracts';
import { DerivedIdFactory, SCHEDULED_ACTION_PRIORITY } from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { ACCEPTED_PATH_STEPS, executeCommand } from './command-handler.ts';
import { initializeWorld, loadWorldState } from './world-repository.ts';

const ids = new DerivedIdFactory('i02b-scheduling');

const startCommand = (): Command => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: FIXTURE_AGENT_ID,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: 0,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
});

describe('C1 — команда планирует своё завершение', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('scheduling');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  afterEach(async () => {
    await truncateWorldData(db);
  });

  it('journey.start создаёт ровно одно действие с due_at = world_time + travelMinutes', async () => {
    await initializeWorld(db, fixtureInitialization());
    const result = await executeCommand(db, startCommand());
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;

    const actions = await db.selectFrom('scheduled_actions').selectAll().execute();
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe('journey.complete');
    // Фикстура: старт 06:00, маршрут 40 минут.
    expect(action.due_at).toBe('2028-04-26T06:40:00.000Z');
    expect(action.priority).toBe(SCHEDULED_ACTION_PRIORITY['journey.complete']);
    expect(action.entity_id).toBe(FIXTURE_AGENT_ID);
    expect(action.route_id).toBe(FIXTURE_ROUTE_ID);
    expect(action.completed_at).toBeNull();
    expect(action.lease_owner).toBeNull();
    // Действие опознаётся событием-причиной: связь прямая, без отдельного справочника.
    expect(action.action_id).toBe(result.eventIds[0]);
  });

  it('расписание входит в каноническое состояние, а не живёт рядом с ним', async () => {
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, startCommand());

    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    const actions = Object.values(state?.scheduledActions ?? {});
    expect(actions).toHaveLength(1);
    expect(actions[0]?.entityId).toBe(FIXTURE_AGENT_ID);
  });

  it.each(ACCEPTED_PATH_STEPS.map((step) => [step] as const))(
    'сбой после «%s» не оставляет ни события без расписания, ни расписания без события',
    async (step) => {
      await initializeWorld(db, fixtureInitialization());
      const reached: string[] = [];
      await expect(
        executeCommand(db, startCommand(), {
          afterStep: (current) => {
            reached.push(current);
            if (current === step) throw new Error(`инъекция после ${step}`);
          },
        }),
      ).rejects.toThrow(`инъекция после ${step}`);
      expect(reached[reached.length - 1]).toBe(step);

      const events = await db.selectFrom('world_events').selectAll().execute();
      const actions = await db.selectFrom('scheduled_actions').selectAll().execute();
      expect(events).toHaveLength(0);
      expect(actions).toHaveLength(0);
    },
  );
});
