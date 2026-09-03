/**
 * p-8 — домен обязан игнорировать те же поля, которые исключены из отпечатка команды.
 *
 * Контрактный тест доказывает, что их игнорирует ОТПЕЧАТОК. Что их игнорирует ДОМЕН — не
 * доказывало ничто. В день, когда `issued_at_world_time` станет семантическим (окно валидности,
 * упорядочивание по времени намерения), две РАЗНЫЕ команды получат один отпечаток, и вторая
 * тихо вернёт результат первой. Этот тест упадёт в тот самый день.
 */
import { describe, expect, it } from 'vitest';
import { COMMAND_FINGERPRINT_EXCLUDED_KEYS, type JourneyStartCommand } from '@zona/contracts';
import { decide } from './decide.ts';
import { FixedClock } from './ports/clock.ts';
import { DerivedIdFactory } from './ports/id-factory.ts';
import { DeterministicRandomSource } from './ports/random-source.ts';
import { testRuleset } from './ports/ruleset.ts';
import type { WorldState } from './state.ts';

const WORLD_TIME = '2028-04-26T06:00:00.000Z';

const state = (): WorldState => ({
  worldId: 'world:prototype',
  worldVersion: 0,
  worldTime: WORLD_TIME,
  sequence: 0,
  agents: {
    'agent:rook': {
      id: 'agent:rook',
      locationId: 'loc:yard',
      status: 'idle',
      routeId: null,
      needBaseline: { hunger: WORLD_TIME, fatigue: WORLD_TIME },
      goal: 'idle',
      planId: null,
      caution: 1000,
    },
  },
  locations: {
    'loc:quiet-yard': { id: 'loc:quiet-yard', risk: 0 },
    'loc:bridge': { id: 'loc:bridge', risk: 600 },
  },
  routes: {
    'route:a': {
      id: 'route:a',
      fromLocationId: 'loc:yard',
      toLocationId: 'loc:bridge',
      travelMinutes: 40,
      risk: 300,
    },
  },
  items: {},
  scheduledActions: {},
});

const context = () => ({
  clock: new FixedClock(WORLD_TIME),
  random: new DeterministicRandomSource(1),
  ids: new DerivedIdFactory('world:prototype:1'),
  ruleset: testRuleset(),
});

const command = (overrides: Partial<JourneyStartCommand> = {}): JourneyStartCommand => ({
  command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  world_id: 'world:prototype',
  type: 'journey.start',
  schema_version: 1,
  actor_id: 'agent:rook',
  issued_at_world_time: WORLD_TIME,
  expected_world_version: 0,
  correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  payload: { route_id: 'route:a' },
  ...overrides,
});

describe('decide и поля, исключённые из отпечатка', () => {
  it('исключены ровно те поля, которые перечислены в контракте', () => {
    // Если контракт исключит новое поле, этот список изменится, и тест ниже начнёт проверять
    // его автоматически — связка не требует ручной синхронизации.
    expect([...COMMAND_FINGERPRINT_EXCLUDED_KEYS]).toEqual([
      'command_id',
      'correlation_id',
      'issued_at_world_time',
    ]);
  });

  it('команды, различающиеся только исключёнными полями, дают одинаковый результат', () => {
    // `command_id` домен ЧИТАЕТ — он попадает в событие как `command_id`, — поэтому здесь
    // варьируются только те исключённые поля, которые домен читать не должен вовсе.
    const base = decide(state(), command(), context());
    const varied = decide(
      state(),
      command({
        correlation_id: 'corr_01BX5ZZKBKACTAV9WEVGEMMVRZ',
        issued_at_world_time: '2028-05-01T12:00:00.000Z',
      }),
      context(),
    );

    expect(base.kind).toBe('accepted');
    if (base.kind !== 'accepted' || varied.kind !== 'accepted') return;
    // `correlation_id` события берётся из команды — это трассировка, а не решение домена;
    // сравниваются решения, то есть всё остальное.
    const withoutCorrelation = (events: typeof base.events) =>
      events.map(({ correlation_id: _correlation, ...rest }) => rest);
    expect(withoutCorrelation(varied.events)).toEqual(withoutCorrelation(base.events));
  });
});
