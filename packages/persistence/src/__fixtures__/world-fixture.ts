/**
 * Минимальный мир для интеграционных тестов персистентности: 1 агент, 2 локации, 1 маршрут
 * (I02A PLAN §4.1). Собран здесь, а не взят из `@zona/content`, чтобы тест транзакции не падал
 * при изменении продуктового контента и чтобы `@zona/persistence` не получал зависимость на
 * пакет данных ради тестов.
 */
import { testRulesetVersions, type WorldState } from '@zona/domain';
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
    },
    [FIXTURE_OTHER_AGENT_ID]: {
      id: FIXTURE_OTHER_AGENT_ID,
      locationId: FIXTURE_START_LOCATION_ID,
      status: 'idle',
      routeId: null,
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
});

export const fixtureInitialization = (): WorldInitialization => ({
  seed: FIXTURE_SEED,
  state: fixtureState(),
  versions: testRulesetVersions(),
  content: {
    locations: [
      { id: FIXTURE_START_LOCATION_ID, name: 'Тихий двор', description: 'Спокойное место.' },
      { id: FIXTURE_END_LOCATION_ID, name: 'Мост', description: 'Полуразрушенный мост.' },
    ],
    agentNames: { [FIXTURE_AGENT_ID]: 'Рук', [FIXTURE_OTHER_AGENT_ID]: 'Коршун' },
  },
});
