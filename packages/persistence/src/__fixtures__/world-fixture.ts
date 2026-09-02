/**
 * Минимальный мир для интеграционных тестов персистентности: 1 агент, 2 локации, 1 маршрут
 * (I02A PLAN §4.1). Собран здесь, а не взят из `@zona/content`, чтобы тест транзакции не падал
 * при изменении продуктового контента и чтобы `@zona/persistence` не получал зависимость на
 * пакет данных ради тестов.
 */
import { testRulesetVersions, type AgentState, type WorldState } from '@zona/domain';
import type { WorldInitialization } from '../world-repository.ts';

export const FIXTURE_WORLD_ID = 'world:fixture';
export const FIXTURE_AGENT_ID = 'agent:rook';
export const FIXTURE_OTHER_AGENT_ID = 'agent:kite';
export const FIXTURE_ROUTE_ID = 'route:yard-to-bridge';
export const FIXTURE_BACK_ROUTE_ID = 'route:bridge-to-yard';
export const FIXTURE_START_LOCATION_ID = 'loc:quiet-yard';
export const FIXTURE_END_LOCATION_ID = 'loc:bridge';
export const FIXTURE_WORLD_TIME = '2028-04-26T06:00:00.000Z';
export const FIXTURE_SEED = 42;

export const fixtureState = (): WorldState => ({
  worldId: FIXTURE_WORLD_ID,
  worldVersion: 0,
  worldTime: FIXTURE_WORLD_TIME,
  sequence: 0,
  agents: {
    [FIXTURE_AGENT_ID]: {
      id: FIXTURE_AGENT_ID,
      locationId: FIXTURE_START_LOCATION_ID,
      status: 'idle',
      routeId: null,
      needBaseline: { hunger: FIXTURE_WORLD_TIME, fatigue: FIXTURE_WORLD_TIME },
      goal: 'idle',
    },
    [FIXTURE_OTHER_AGENT_ID]: {
      id: FIXTURE_OTHER_AGENT_ID,
      locationId: FIXTURE_START_LOCATION_ID,
      status: 'idle',
      routeId: null,
      needBaseline: { hunger: FIXTURE_WORLD_TIME, fatigue: FIXTURE_WORLD_TIME },
      goal: 'idle',
    },
  },
  routes: {
    [FIXTURE_ROUTE_ID]: {
      id: FIXTURE_ROUTE_ID,
      fromLocationId: FIXTURE_START_LOCATION_ID,
      toLocationId: FIXTURE_END_LOCATION_ID,
      travelMinutes: 40,
    },
    [FIXTURE_BACK_ROUTE_ID]: {
      id: FIXTURE_BACK_ROUTE_ID,
      fromLocationId: FIXTURE_END_LOCATION_ID,
      toLocationId: FIXTURE_START_LOCATION_ID,
      travelMinutes: 40,
    },
  },
  items: {},
  scheduledActions: {},
});

export const fixtureInitialization = (): WorldInitialization => ({
  seed: FIXTURE_SEED,
  state: fixtureState(),
  // Фикстурный мир собран вручную, а не порождён `seedWorld`: розыгрышей в нём не было, поэтому
  // позиции пусты ЯВНО. Поле обязательное — см. `WorldInitialization` и B1.
  prngStreamPositions: {},
  versions: testRulesetVersions(),
  content: {
    locations: [
      { id: FIXTURE_START_LOCATION_ID, name: 'Тихий двор', description: 'Спокойное место.' },
      { id: FIXTURE_END_LOCATION_ID, name: 'Мост', description: 'Полуразрушенный мост.' },
    ],
    agentNames: { [FIXTURE_AGENT_ID]: 'Рук', [FIXTURE_OTHER_AGENT_ID]: 'Коршун' },
  },
});

/**
 * Мир с `count` праздными агентами в стартовой локации — для проверки конкуренции (B6).
 *
 * Отдельная фикстура, а не расширение основной: `journey.start` — единственная команда этого
 * slice, и каждый агент может выйти на маршрут ровно один раз (завершение пути появится в
 * I02B). Значит, чтобы получить N принятых команд подряд, нужно N агентов. Основная фикстура
 * остаётся минимальной, как требует PLAN §4.1.
 */
export const fixtureInitializationWithAgents = (count: number): WorldInitialization => {
  const base = fixtureInitialization();
  const agents: Record<string, AgentState> = {};
  const agentNames: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    const id = `agent:racer-${String(index).padStart(2, '0')}`;
    agents[id] = {
      id,
      locationId: FIXTURE_START_LOCATION_ID,
      status: 'idle',
      routeId: null,
      needBaseline: { hunger: FIXTURE_WORLD_TIME, fatigue: FIXTURE_WORLD_TIME },
      goal: 'idle',
    };
    agentNames[id] = `Бегун ${String(index)}`;
  }
  return {
    ...base,
    state: { ...base.state, agents },
    content: { ...base.content, agentNames },
  };
};

/** Идентификаторы агентов из {@link fixtureInitializationWithAgents} в том же порядке. */
export const racerAgentIds = (count: number): readonly string[] =>
  Array.from({ length: count }, (_, index) => `agent:racer-${String(index).padStart(2, '0')}`);
