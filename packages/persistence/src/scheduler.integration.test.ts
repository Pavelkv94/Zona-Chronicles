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

    // Горизонт задаёт, до какого мирового времени двигать мир этим шагом (ADR-004): сами часы
    // руками никто не крутит — их двигает обработанное действие.
    const result = await runWorldTick(db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'worker-1',
      horizon: '2028-04-26T06:40:00.000Z',
    });
    expect(result.claimed).toBe(1);
    expect(result.executed[0]?.outcome).toBe('accepted');

    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    expect(state?.agents[FIXTURE_AGENT_ID]).toEqual({
      id: FIXTURE_AGENT_ID,
      locationId: FIXTURE_END_LOCATION_ID,
      status: 'idle',
      routeId: null,
      // Путь нужды не трогает: агент дошёл, а не поел (I04).
      needBaseline: { hunger: FIXTURE_WORLD_TIME, fatigue: FIXTURE_WORLD_TIME },
      // Прибытие цели не ставит: цель появится решением, которое мир только что назначил.
      goal: 'idle',
      planId: null,
    });
    // Завершение пути ушло из расписания, а на его месте появилось РЕШЕНИЕ: прибывший агент
    // свободен, и мир обязан дать ему выбрать, что делать дальше (I05-B). Без этой строки
    // тест утверждал бы, что мир после прибытия замолкает, — а он именно этого делать не
    // должен.
    expect(Object.values(state?.scheduledActions ?? {}).map((action) => action.kind)).toEqual([
      'agent.decide',
    ]);
    const rows = await db.selectFrom('scheduled_actions').selectAll().orderBy('kind').execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.kind === 'journey.complete')?.completed_at).toBeInstanceOf(Date);

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
      await runWorldTick(db, {
        worldId: FIXTURE_WORLD_ID,
        owner: 'worker-1',
        horizon: '2028-04-26T06:40:00.000Z',
      });
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

  it('C12: горизонт в прошлом отвергается, время назад не идёт', async () => {
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, start(FIXTURE_AGENT_ID, 0));
    await runWorldTick(db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'worker-1',
      horizon: '2028-04-26T06:40:00.000Z',
    });

    await expect(
      runWorldTick(db, {
        worldId: FIXTURE_WORLD_ID,
        owner: 'worker-1',
        horizon: '2028-04-26T06:00:00.000Z',
      }),
    ).rejects.toThrow(/мир не идёт назад/);
  });

  it('C12: обработанное действие двигает мировое время вперёд, а горизонт его не обгоняет', async () => {
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, start(FIXTURE_AGENT_ID, 0));

    // Горизонт на час вперёд, но действие наступает в 06:40 — время встаёт на нём, а не на
    // горизонте: мир двигают события, а не таймер (ADR-004).
    const result = await runWorldTick(db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'worker-1',
      horizon: '2028-04-26T07:00:00.000Z',
    });
    expect(result.claimed).toBe(1);
    expect(result.worldTime).toBe('2028-04-26T06:40:00.000Z');
  });
});

/**
 * Сигнал «миру нечего делать» — отдельно от «шаг ничего не захватил».
 *
 * Эти два состояния неразличимы по `claimed`, и их совпадение стоило одной отвергнутой починки
 * кредита темпа: предикат `claimed === 0` останавливает мир насмерть, потому что ждущее, но
 * ненаступившее действие выглядит для него пустым миром (`apps/worker/src/world-step.ts`).
 *
 * Здесь проверяется именно РАЗЛИЧИЕ, а не наличие поля: три состояния мира подряд, и в каждом
 * `claimed` одинаков либо бесполезен.
 */
describe('nextDueAt — миру есть что делать, даже когда шаг пуст', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('scheduler-next-due');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  afterEach(async () => {
    await truncateWorldData(db);
  });

  it('пустой мир, ждущее действие и исполненное действие различимы', async () => {
    await initializeWorld(db, fixtureInitialization());

    // 1. Миру нечего делать: расписание пусто.
    const idle = await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-1' });
    expect(idle.claimed).toBe(0);
    expect(idle.nextDueAt).toBeNull();

    // 2. Действие есть, но не наступило. `claimed` тот же ноль — различие только в сроке.
    await executeCommand(db, start(FIXTURE_AGENT_ID, 0));
    const waiting = await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-1' });
    expect(waiting.claimed).toBe(0);
    expect(waiting.nextDueAt).toBe('2028-04-26T06:40:00.000Z');

    // 3. Действие исполнено — но миру ЕСТЬ что делать: прибывший агент свободен, и мир
    // назначил ему решение на тот же момент (I05-B). «Нечего делать» наступает раундом позже,
    // когда решение принято и оказалось праздностью.
    const done = await runWorldTick(db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'worker-1',
      horizon: '2028-04-26T06:40:00.000Z',
    });
    expect(done.claimed).toBe(1);
    expect(done.nextDueAt).toBe('2028-04-26T06:40:00.000Z');

    // 4. Решение принято: спокойному агенту начинать нечего, и он остаётся празден. Факт
    // записан — решение это факт, даже когда оно ничего не меняет, — а расписание пусто.
    const decided = await runWorldTick(db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'worker-1',
      horizon: '2028-04-26T06:40:00.000Z',
    });
    expect(decided.claimed).toBe(1);
    expect(decided.executed[0]?.outcome).toBe('accepted');
    expect(decided.nextDueAt).toBeNull();
  });

  it('срок — БЛИЖАЙШИЙ из ждущих, а не любой', async () => {
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, start(FIXTURE_AGENT_ID, 0));
    await executeCommand(db, start(FIXTURE_OTHER_AGENT_ID, 1));

    const waiting = await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-1' });
    const dueAts = await db
      .selectFrom('scheduled_actions')
      .select('due_at')
      .orderBy('due_at')
      .execute();
    expect(dueAts.length).toBeGreaterThan(1);
    expect(waiting.nextDueAt).toBe(dueAts[0]!.due_at);
  });

  /**
   * Отвергнутое действие ждущим НЕ считается. Иначе мир, у которого в расписании навсегда
   * осталась отвергнутая строка, никогда бы не признавался простаивающим — и кредит темпа
   * вернулся бы через заднюю дверь, причём только у миров с историей отказа.
   */
  it('отвергнутое действие не держит мир занятым', async () => {
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, start(FIXTURE_AGENT_ID, 0));
    await db
      .updateTable('scheduled_actions')
      .set({ failed_at: new Date(), failure_code: 'probe' })
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .execute();

    const result = await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-1' });
    expect(result.nextDueAt).toBeNull();
  });
});
