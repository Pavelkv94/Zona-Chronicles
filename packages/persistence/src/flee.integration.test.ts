/**
 * I06-C — агент уходит от опасности дорогой, которую СЧИТАЕТ безопасной (PLAN §2, §8).
 *
 * Здесь проверяется гипотеза итерации целиком и на настоящей базе: два одинаковых агента в
 * одинаковом положении уходят разными дорогами, и различие объясняется тем, что один из них
 * видел, а другой нет.
 *
 * Мир собран специально: две дороги из опасного места, одинаковые по длине и РАЗНЫЕ по настоящей
 * опасности, о которой агенты не осведомлены поровну. Так проверяются оба утверждения сразу:
 * знание меняет выбор — и канон, которого агент не знает, на выбор не влияет.
 *
 * Первая редакция делала дороги одинаковыми и во втором — «чтобы различие объяснялось только
 * знанием». Мутация «оценивать неизвестную дорогу каноном» прошла её целиком: подменять было
 * нечего, обе величины совпадали. Различие в каноне здесь и есть детектор утечки.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireAddMinutes, requireInstant, type WorldEvent } from '@zona/contracts';
import {
  PROTOTYPE_NEEDS,
  SCHEDULED_ACTION_PRIORITY,
  needThresholdActionId,
  nextThresholdCrossing,
  testRulesetVersions,
  type AgentState,
  type ScheduledAction,
  type WorldState,
} from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import { runWorldTick } from './scheduler.ts';
import { initializeWorld, loadWorldEvents, loadWorldState } from './world-repository.ts';

const WORLD_ID = 'world:fixture';
const START = '2028-04-26T06:00:00.000Z';
const DANGER = 'loc:danger';
const ALPHA = 'route:danger-to-alpha';
const BETA = 'route:danger-to-beta';
const SEEN = 'agent:seen';
const BLIND = 'agent:blind';

/** Момент «через N минут после старта мира», посчитанный средствами продукта. */
const at = (minutes: number): string =>
  requireAddMinutes(requireInstant(START, 'старт мира'), minutes, 'сдвиг теста').iso;

const HORIZON = at(2880);

/**
 * Знание, записанное в генезис.
 *
 * Так выражается «он уже ходил там раньше»: истории до начала мира у нас нет, а провенанс
 * обязателен. Ссылка на событие остаётся смысловой — внешнего ключа на журнал у знания нет
 * намеренно (см. миграцию 0022).
 */
const seenBefore = (routeId: string, risk: number) => ({
  [routeId]: { risk, at: START, sourceEventId: 'evt_00000000000000000000000000' },
});

const agent = (id: string, knownRoutes: AgentState['knownRoutes']): AgentState => ({
  id,
  locationId: DANGER,
  status: 'idle',
  routeId: null,
  needBaseline: { hunger: START, fatigue: START },
  goal: 'idle',
  planId: null,
  // Осторожность одинакова: различие между агентами должно объясняться ЗНАНИЕМ, а не характером.
  caution: 1000,
  knownRoutes,
});

const initialNeedSchedule = (agentIds: readonly string[]): Record<string, ScheduledAction> => {
  const scheduled: Record<string, ScheduledAction> = {};
  for (const agentId of agentIds) {
    for (const need of ['hunger', 'fatigue'] as const) {
      const crossing = nextThresholdCrossing(START, 'normal', PROTOTYPE_NEEDS[need]);
      if (crossing === null) continue;
      const id = needThresholdActionId(agentId, need, crossing.at);
      scheduled[id] = {
        id,
        kind: 'need.threshold',
        dueAt: crossing.at,
        priority: SCHEDULED_ACTION_PRIORITY['need.threshold'],
        entityId: agentId,
        need,
        toLevel: crossing.level,
      };
    }
  }
  return scheduled;
};

const world = (): WorldState => ({
  worldId: WORLD_ID,
  worldVersion: 0,
  worldTime: START,
  sequence: 0,
  agents: {
    // Один знает, что дорога «альфа» скверная. Второй не знает о дорогах ничего.
    [SEEN]: agent(SEEN, seenBefore(ALPHA, 900)),
    [BLIND]: agent(BLIND, {}),
  },
  locations: {
    [DANGER]: { id: DANGER, risk: 700 },
    'loc:alpha': { id: 'loc:alpha', risk: 0 },
    'loc:beta': { id: 'loc:beta', risk: 0 },
  },
  routes: {
    // Длина одинакова, опасность — нет. «Альфа» на самом деле скверная, «бета» спокойная, и
    // знает об этом только один из двоих.
    [ALPHA]: {
      id: ALPHA,
      fromLocationId: DANGER,
      toLocationId: 'loc:alpha',
      travelMinutes: 60,
      risk: 950,
    },
    [BETA]: {
      id: BETA,
      fromLocationId: DANGER,
      toLocationId: 'loc:beta',
      travelMinutes: 60,
      risk: 100,
    },
  },
  items: {},
  scheduledActions: initialNeedSchedule([SEEN, BLIND]),
});

const runUntilQuiet = async (migrated: MigratedDatabase, horizon = HORIZON): Promise<void> => {
  for (let tick = 0; tick < 200; tick += 1) {
    const result = await runWorldTick(migrated.db, {
      worldId: WORLD_ID,
      owner: `t-${String(tick)}`,
      horizon,
    });
    if (result.claimed === 0) return;
  }
  throw new Error('мир не пришёл в тишину');
};

const firstJourneyOf = (events: readonly WorldEvent[], agentId: string): string | null => {
  const started = events.find(
    (event) => event.type === 'journey.started' && event.actor_ids.includes(agentId),
  );
  return started?.type === 'journey.started' ? started.payload.route_id : null;
};

describe('I06-C — уход от опасности по субъективной карте', () => {
  let migrated: MigratedDatabase;
  let events: readonly WorldEvent[] = [];

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i06_flee');
    await truncateWorldData(migrated.db);
    await initializeWorld(migrated.db, {
      seed: 1,
      state: world(),
      prngStreamPositions: {},
      versions: testRulesetVersions(),
      content: {
        locations: [
          { id: DANGER, name: 'Опасное место', description: 'Здесь не стоит задерживаться.' },
          { id: 'loc:alpha', name: 'Альфа', description: 'Тихо.' },
          { id: 'loc:beta', name: 'Бета', description: 'Тоже тихо.' },
        ],
        agentNames: { [SEEN]: 'Видевший', [BLIND]: 'Незнающий' },
      },
    });
    await runUntilQuiet(migrated);
    events = await loadWorldEvents(migrated.db, WORLD_ID);
  }, 120_000);

  afterAll(async () => {
    await migrated.close();
  });

  it('оба ушли из опасного места — сами, без единой команды человека', () => {
    for (const agentId of [SEEN, BLIND]) {
      const chosen = firstJourneyOf(events, agentId);
      expect(chosen, `${agentId} остался в опасном месте`).not.toBeNull();
    }
    // И ушли они по РЕШЕНИЮ, а не по приказу: перед каждым выходом стоит выбор цели «уйти».
    for (const agentId of [SEEN, BLIND]) {
      const decision = events.find(
        (event) =>
          event.type === 'goal.chosen' &&
          event.actor_ids.includes(agentId) &&
          event.payload.goal === 'flee',
      );
      expect(decision, `${agentId} вышел в путь без решения уйти`).toBeDefined();
    }
  });

  it('видевший скверную дорогу обошёл её, а незнающий пошёл прямо по ней', () => {
    // Главное утверждение итерации, и оно двустороннее.
    //
    // Видевший избегает «альфы» — и оказывается прав: она действительно самая опасная. Незнающий
    // берёт её же, потому что для него обе дороги одинаково безымянны, и при равной цене решает
    // ключ, а не порядок перебора.
    //
    // Второе — заодно детектор утечки: если бы неизвестная дорога оценивалась КАНОНОМ, незнающий
    // «увидел» бы разницу 950 против 100 и свернул бы на «бету».
    expect(firstJourneyOf(events, SEEN)).toBe(BETA);
    expect(firstJourneyOf(events, BLIND)).toBe(ALPHA);
  });

  it('пройденная дорога стала известной, а вторая — нет', async () => {
    const state = await loadWorldState(migrated.db, WORLD_ID);
    // Знание получено ровно о том, по чему прошли. Мир не рассказал агенту ничего сверх этого.
    expect(Object.keys(state?.agents[BLIND]?.knownRoutes ?? {})).toEqual([ALPHA]);
    expect(Object.keys(state?.agents[SEEN]?.knownRoutes ?? {}).sort()).toEqual([ALPHA, BETA]);
  });

  it('уйдя в спокойное место, агент больше никуда не бежит', () => {
    // Иначе «уход» превратился бы в вечное блуждание: цель, которая не достигается, — это не
    // цель, а цикл.
    const journeys = events.filter((event) => event.type === 'journey.started');
    expect(journeys.length).toBe(2);
  });
});
