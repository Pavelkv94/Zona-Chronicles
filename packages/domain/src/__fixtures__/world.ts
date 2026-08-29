/**
 * Фикстуры для unit/property тестов `decide`/`evolve` (I01, первый slice §11).
 *
 * `__fixtures__` исключён из `tsconfig.build.json` — это тестовые данные, а не часть
 * публичного API пакета, и не попадает в `dist`.
 */
import type { JourneyStartCommand, NeedKind } from '@zona/contracts';
import { FixedClock } from '../ports/clock.ts';
import { SequentialIdFactory } from '../ports/id-factory.ts';
import { DeterministicRandomSource } from '../ports/random-source.ts';
import { testRuleset } from '../ports/ruleset.ts';
import type { DecideContext } from '../decide.ts';
import type { WorldState } from '../state.ts';

/**
 * Момент отсчёта нужд по умолчанию — стартовое время фикстурного мира: агент только что поел и
 * отдохнул. Отдельная константа, чтобы тест, которому нужен голодный агент, сдвигал ЕЁ, а не
 * переписывал всю карту агентов.
 */
export const FIXTURE_NEED_BASELINE = '2034-05-17T18:00:00.000Z';

export function fixtureNeedBaseline(
  at: string = FIXTURE_NEED_BASELINE,
): Readonly<Record<NeedKind, string>> {
  return { hunger: at, fatigue: at };
}

export function fixtureWorldState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    worldId: 'world:prototype',
    worldVersion: 0,
    worldTime: '2034-05-17T18:00:00.000Z',
    sequence: 0,
    agents: {
      'agent:rook': {
        id: 'agent:rook',
        locationId: 'loc:quiet-yard',
        status: 'idle',
        routeId: null,
        needBaseline: fixtureNeedBaseline(),
      },
    },
    routes: {
      'route:yard-to-bridge': {
        id: 'route:yard-to-bridge',
        fromLocationId: 'loc:quiet-yard',
        toLocationId: 'loc:bridge',
        travelMinutes: 40,
      },
    },
    items: {},
    scheduledActions: {},
    ...overrides,
  };
}

export function fixtureDecideContext(overrides: Partial<DecideContext> = {}): DecideContext {
  return {
    clock: new FixedClock('2034-05-17T18:20:00Z'),
    random: new DeterministicRandomSource(1),
    ids: new SequentialIdFactory(1),
    ruleset: testRuleset(),
    ...overrides,
  };
}

export function fixtureJourneyStartCommand(
  overrides: Partial<JourneyStartCommand> = {},
): JourneyStartCommand {
  return {
    command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    world_id: 'world:prototype',
    type: 'journey.start',
    schema_version: 1,
    actor_id: 'agent:rook',
    issued_at_world_time: '2034-05-17T18:20:00Z',
    expected_world_version: 0,
    correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    payload: { route_id: 'route:yard-to-bridge' },
    ...overrides,
  };
}
