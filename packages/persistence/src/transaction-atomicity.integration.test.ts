/**
 * B5 — сбой в любой точке транзакции не оставляет частичной записи.
 * B6 — конкурентные команды не создают дыр и дублей.
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
  FIXTURE_OTHER_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { initializeWorld } from './world-repository.ts';
import { TRANSACTION_STEPS, executeCommand, type TransactionStep } from './command-handler.ts';

const ids = new DerivedIdFactory('i02a-atomicity');

const command = (overrides: Partial<Command> = {}): Command => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: FIXTURE_AGENT_ID,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: 0,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
  ...overrides,
});

/** Полный слепок изменяемых таблиц — «побайтово то же состояние» в терминах ACCEPTANCE B5. */
const snapshotTables = async (db: DatabaseConnection): Promise<string> => {
  const [worlds, agents, events, results, outbox] = await Promise.all([
    db.selectFrom('worlds').selectAll().orderBy('world_id').execute(),
    db.selectFrom('agents').selectAll().orderBy('agent_id').execute(),
    db.selectFrom('world_events').selectAll().orderBy('event_id').execute(),
    db.selectFrom('command_results').selectAll().orderBy('command_id').execute(),
    db.selectFrom('outbox').selectAll().orderBy('event_id').execute(),
  ]);
  return JSON.stringify({ worlds, agents, events, results, outbox });
};

describe('B5 — атомарность транзакции', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('atomicity');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  afterEach(async () => {
    await truncateWorldData(db);
  });

  it.each(TRANSACTION_STEPS.map((step) => [step] as const))(
    'сбой после шага «%s» откатывает всё',
    async (step: TransactionStep) => {
      await initializeWorld(db, fixtureInitialization());
      const before = await snapshotTables(db);

      const reached: TransactionStep[] = [];
      const failure = new Error(`инъекция сбоя после ${step}`);
      await expect(
        executeCommand(db, command(), {
          afterStep: (current) => {
            reached.push(current);
            if (current === step) throw failure;
          },
        }),
      ).rejects.toThrow(failure.message);

      // Правило мутационной пробы: сначала доказать, что сбой действительно произошёл в
      // заявленной точке, иначе «всё откатилось» доказывало бы лишь то, что команда не шла.
      expect(reached).toContain(step);
      expect(reached[reached.length - 1]).toBe(step);

      expect(await snapshotTables(db)).toBe(before);

      // Сбой не «съел» command_id: та же команда после сбоя проходит и даёт ровно одно событие.
      const retry = await executeCommand(db, command());
      expect(retry.outcome).toBe('accepted');
      const events = await db.selectFrom('world_events').selectAll().execute();
      expect(events).toHaveLength(1);
    },
  );
});

describe('B6 — конкурентные команды', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('concurrency');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('из двух команд с одной ожидаемой версией проходит ровно одна', async () => {
    await initializeWorld(db, fixtureInitialization());

    const first = command({ actor_id: FIXTURE_AGENT_ID });
    const second = command({ actor_id: FIXTURE_OTHER_AGENT_ID });
    const [a, b] = await Promise.all([executeCommand(db, first), executeCommand(db, second)]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['accepted', 'rejected']);
    const rejected = a.outcome === 'rejected' ? a : b.outcome === 'rejected' ? b : null;
    expect(rejected?.outcome === 'rejected' ? rejected.rejectionCode : null).toBe(
      'stale_world_version',
    );

    const events = await db.selectFrom('world_events').selectAll().execute();
    expect(events).toHaveLength(1);
    expect(Number(events[0]?.sequence)).toBe(1);

    const world = await db
      .selectFrom('worlds')
      .selectAll()
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .executeTakeFirstOrThrow();
    expect(Number(world.version)).toBe(1);
    expect(Number(world.last_sequence)).toBe(1);
  });

  it('восемь конкурентных команд дают sequence без дыр и дублей', async () => {
    const commands = Array.from({ length: 8 }, (_, index) =>
      command({
        actor_id: index % 2 === 0 ? FIXTURE_AGENT_ID : FIXTURE_OTHER_AGENT_ID,
        // Каждая заявляет версию, актуальную только для одной из попыток.
        expected_world_version: 1,
      }),
    );
    const results = await Promise.all(commands.map((cmd) => executeCommand(db, cmd)));

    const accepted = results.filter((result) => result.outcome === 'accepted');
    expect(accepted).toHaveLength(1);

    const events = await db
      .selectFrom('world_events')
      .select('sequence')
      .orderBy('sequence')
      .execute();
    const sequences = events.map((row) => Number(row.sequence));
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  });
});
