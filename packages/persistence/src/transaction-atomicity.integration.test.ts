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
  fixtureInitializationWithAgents,
  racerAgentIds,
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { initializeWorld, loadWorldState } from './world-repository.ts';
import {
  ACCEPTED_PATH_STEPS,
  FINGERPRINT_MISMATCH_PATH_STEPS,
  MAX_ATTEMPTS_PER_COMMAND,
  REJECTED_PATH_STEPS,
  TRANSACTION_STEPS,
  executeCommand,
  type TransactionStep,
} from './command-handler.ts';

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

  /**
   * Путь принятой и путь отклонённой команды проходят РАЗНЫЕ наборы точек, и это утверждение
   * само по себе является проверкой: если реализация перестанет вызывать `afterStep` на
   * rejected-ветке, тест упадёт здесь, а не промолчит.
   */
  it.each([
    ['accepted', () => command(), ACCEPTED_PATH_STEPS] as const,
    [
      'rejected',
      () => command({ payload: { route_id: 'route:missing' } }),
      REJECTED_PATH_STEPS,
    ] as const,
  ])('путь «%s» проходит ровно объявленные точки записи', async (_label, build, expected) => {
    await initializeWorld(db, fixtureInitialization());
    const reached: TransactionStep[] = [];
    await executeCommand(db, build(), { afterStep: (step) => void reached.push(step) });
    expect(reached).toEqual([...expected]);
  });

  it('каждая объявленная точка достижима хотя бы одним путём', () => {
    // Иначе список точек и код расходятся молча: шаг, добавленный в TRANSACTION_STEPS и
    // забытый в путях, выглядел бы покрытым инъекцией, не будучи достигнутым ни разу.
    const covered = new Set<TransactionStep>([
      ...ACCEPTED_PATH_STEPS,
      ...REJECTED_PATH_STEPS,
      ...FINGERPRINT_MISMATCH_PATH_STEPS,
    ]);
    expect([...covered].sort()).toEqual([...TRANSACTION_STEPS].sort());
  });

  it('путь «fingerprint-mismatch» проходит ровно объявленные точки записи', async () => {
    // p-5: третий путь ТОЖЕ пишет в базу, и до этой проверки он не имел ни одной точки
    // инъекции — утверждение «сбой инъектируется после каждого шага записи» было неверным.
    await initializeWorld(db, fixtureInitialization());
    const original = command();
    await executeCommand(db, original);

    const reached: TransactionStep[] = [];
    const result = await executeCommand(
      db,
      { ...original, actor_id: FIXTURE_OTHER_AGENT_ID },
      { afterStep: (step) => void reached.push(step) },
    );
    expect(result.outcome).toBe('rejected');
    expect(reached).toEqual([...FINGERPRINT_MISMATCH_PATH_STEPS]);
  });

  it('аудит попыток ограничен сверху и не растёт бесконечно', async () => {
    // p-6: `--command-id` — публичный флаг, то есть вход снаружи. Хранится последние
    // MAX_ATTEMPTS_PER_COMMAND попыток; сигнал «этот id перебирают» остаётся, объём — нет.
    await initializeWorld(db, fixtureInitialization());
    const original = command();
    await executeCommand(db, original);

    const attempts = MAX_ATTEMPTS_PER_COMMAND + 5;
    for (let index = 0; index < attempts; index += 1) {
      await executeCommand(db, {
        ...original,
        actor_id: FIXTURE_OTHER_AGENT_ID,
        payload: { route_id: `route:probe-${String(index)}` },
      });
    }

    const rows = await db
      .selectFrom('command_attempt_rejections')
      .selectAll()
      .where('command_id', '=', original.command_id)
      .orderBy('attempt_id')
      .execute();
    expect(rows).toHaveLength(MAX_ATTEMPTS_PER_COMMAND);
    // Сохраняются ПОСЛЕДНИЕ попытки, а не первые: свежий сигнал ценнее исторического.
    expect(rows[rows.length - 1]?.attempted_fingerprint).toBeDefined();
  });

  it.each([
    ...ACCEPTED_PATH_STEPS.map((step) => ['accepted', step] as const),
    ...REJECTED_PATH_STEPS.map((step) => ['rejected', step] as const),
  ])('сбой на пути «%s» после шага «%s» откатывает всё', async (path, step: TransactionStep) => {
    await initializeWorld(db, fixtureInitialization());
    const before = await snapshotTables(db);

    const build = (): Command =>
      path === 'accepted' ? command() : command({ payload: { route_id: 'route:missing' } });

    const reached: TransactionStep[] = [];
    const failure = new Error(`инъекция сбоя после ${step}`);
    await expect(
      executeCommand(db, build(), {
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

    // Сбой не «съел» command_id: та же команда после сбоя проходит до конца, и на accepted-пути
    // даёт ровно одно событие, а на rejected — ни одного.
    const retry = await executeCommand(db, build());
    expect(retry.outcome).toBe(path);
    const events = await db.selectFrom('world_events').selectAll().execute();
    expect(events).toHaveLength(path === 'accepted' ? 1 : 0);
  });
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

  it('восемь клиентов с повтором дают ровно восемь событий подряд, без дыр', async () => {
    // Тест самодостаточен: собственный мир, а не состояние, оставленное предыдущим тестом.
    // Прежняя редакция объявляла всем восьми командам `expected_world_version: 1` — при таком
    // входе ровно одна команда принимается при ЛЮБОМ порядке исполнения, поэтому тест
    // оставался зелёным и без всякой конкуренции: он не отличал работающий `FOR UPDATE` от
    // его отсутствия и вдобавок падал при запуске в одиночку (independent review, раунд 1).
    //
    // Здесь каждый клиент ведёт себя как настоящий: читает текущую версию мира, отправляет
    // команду и ПОВТОРЯЕТ её при `stale_world_version`. Тогда все восемь обязаны пройти, а
    // журнал — получить восемь событий с sequence 1..8 без дыр, дублей и технических ошибок
    // уникального индекса. Именно это и доказывает сериализацию.
    await truncateWorldData(db);
    const CLIENTS = 8;
    await initializeWorld(db, fixtureInitializationWithAgents(CLIENTS));
    const agentIds = racerAgentIds(CLIENTS);

    const MAX_ATTEMPTS = 40;

    const client = async (index: number): Promise<number> => {
      const agentId = agentIds[index]!;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const state = await loadWorldState(db, FIXTURE_WORLD_ID);
        if (state === null) throw new Error('мир исчез посреди теста');

        const result = await executeCommand(db, {
          ...command({ actor_id: agentId, payload: { route_id: FIXTURE_ROUTE_ID } }),
          expected_world_version: state.worldVersion,
        });
        if (result.outcome === 'accepted') return attempt;
        if (result.rejectionCode !== 'stale_world_version') {
          throw new Error(`неожиданный отказ ${result.rejectionCode}: ${result.rejectionMessage}`);
        }
      }
      throw new Error(`клиент ${index} не смог пройти за ${MAX_ATTEMPTS} попыток`);
    };

    // Конкуренция настоящая: восемь параллельных цепочек на восьми соединениях пула.
    const attempts = await Promise.all(
      Array.from({ length: CLIENTS }, (_, index) => client(index)),
    );

    const events = await db
      .selectFrom('world_events')
      .select('sequence')
      .orderBy('sequence')
      .execute();
    const sequences = events.map((row) => Number(row.sequence));
    expect(sequences).toEqual(Array.from({ length: CLIENTS }, (_, index) => index + 1));

    const world = await db
      .selectFrom('worlds')
      .selectAll()
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .executeTakeFirstOrThrow();
    expect(Number(world.version)).toBe(CLIENTS);
    expect(Number(world.last_sequence)).toBe(CLIENTS);

    // Гонка обязана быть НАБЛЮДАЕМОЙ: если бы конкуренции не было, ни один клиент не получил
    // бы ни одного повтора, и тест снова ничего не доказывал бы про сериализацию.
    expect(attempts.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0);
  });
});
