import { describe, expect, it } from 'vitest';
import {
  fixtureDecideContext,
  fixtureJourneyStartCommand,
  fixtureNeedBaseline,
  fixtureWorldState,
} from './__fixtures__/world.ts';
import { decide } from './decide.ts';
import { testRulesetVersions } from './ports/ruleset.ts';

describe('decide: journey.start -> journey.started (happy path)', () => {
  it('принимает команду и порождает ровно одно событие journey.started', () => {
    const result = decide(
      fixtureWorldState(),
      fixtureJourneyStartCommand(),
      fixtureDecideContext(),
    );
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') {
      throw new Error('unreachable');
    }
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe('journey.started');
  });

  it('событие несёт правильные envelope-поля, выведенные из state/command/context', () => {
    const result = decide(
      fixtureWorldState(),
      fixtureJourneyStartCommand(),
      fixtureDecideContext(),
    );
    if (result.kind !== 'accepted') {
      throw new Error('unreachable');
    }
    const event = result.events[0]!;
    expect(event).toMatchObject({
      world_id: 'world:prototype',
      sequence: 1,
      type: 'journey.started',
      // Версии берутся ИЗ ruleset контекста, а не из литералов: событие обязано быть подписано
      // теми правилами, по которым принято решение, и литерал здесь означал бы проверку
      // «версия та, которую я вписал», а не «та, которой считал домен». Версия правил уже
      // менялась (0.1.0 → 0.2.0 в I04), и литерал упал бы, ничего при этом не найдя.
      schema_version: testRulesetVersions().schemaVersion,
      rules_version: testRulesetVersions().rulesVersion,
      content_version: testRulesetVersions().contentVersion,
      actor_ids: ['agent:rook'],
      subject_ids: [],
      location_id: 'loc:quiet-yard',
      correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      caused_by: [],
      command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      random_audit: null,
    });
    expect('recorded_at' in event).toBe(false);
  });

  it('world_time и expected_arrival — канонические ISO-моменты; arrival = world_time + travelMinutes', () => {
    const result = decide(
      fixtureWorldState(),
      fixtureJourneyStartCommand(),
      fixtureDecideContext(),
    );
    if (result.kind !== 'accepted') {
      throw new Error('unreachable');
    }
    const event = result.events[0]!;
    expect(event.world_time).toBe('2034-05-17T18:20:00.000Z');
    if (event.type !== 'journey.started') {
      throw new Error('unreachable');
    }
    expect(event.payload).toStrictEqual({
      route_id: 'route:yard-to-bridge',
      expected_arrival: '2034-05-17T19:00:00.000Z',
    });
  });

  it('не обращается к RandomSource — journey.started не использует случайность', () => {
    const context = fixtureDecideContext();
    const drawsBefore = context.random.draw('audit-probe').drawIndex;
    decide(fixtureWorldState(), fixtureJourneyStartCommand(), context);
    const drawsAfter = context.random.draw('audit-probe').drawIndex;
    expect(drawsAfter).toBe(drawsBefore + 1);
  });
});

describe('decide: journey.start — отказы', () => {
  it('stale_world_version, если expected_world_version не совпадает с state.worldVersion', () => {
    const result = decide(
      fixtureWorldState({ worldVersion: 3 }),
      fixtureJourneyStartCommand({ expected_world_version: 0 }),
      fixtureDecideContext(),
    );
    expect(result).toMatchObject({ kind: 'rejected', rejection: { code: 'stale_world_version' } });
  });

  it('actor_not_actionable, если актор неизвестен миру', () => {
    const result = decide(
      fixtureWorldState(),
      fixtureJourneyStartCommand({ actor_id: 'agent:unknown' }),
      fixtureDecideContext(),
    );
    expect(result).toMatchObject({ kind: 'rejected', rejection: { code: 'actor_not_actionable' } });
  });

  it('actor_not_actionable, если актор уже в пути', () => {
    const state = fixtureWorldState({
      agents: {
        'agent:rook': {
          id: 'agent:rook',
          locationId: 'loc:quiet-yard',
          status: 'traveling',
          routeId: 'route:yard-to-bridge',
          needBaseline: fixtureNeedBaseline(),
          goal: 'idle',
          planId: null,
        },
      },
    });
    const result = decide(state, fixtureJourneyStartCommand(), fixtureDecideContext());
    expect(result).toMatchObject({ kind: 'rejected', rejection: { code: 'actor_not_actionable' } });
  });

  it('route_unavailable, если маршрут неизвестен миру', () => {
    const result = decide(
      fixtureWorldState(),
      fixtureJourneyStartCommand({ payload: { route_id: 'route:unknown' } }),
      fixtureDecideContext(),
    );
    expect(result).toMatchObject({ kind: 'rejected', rejection: { code: 'route_unavailable' } });
  });

  it('route_unavailable, если маршрут не начинается в текущей локации актора', () => {
    const state = fixtureWorldState({
      routes: {
        'route:elsewhere': {
          id: 'route:elsewhere',
          fromLocationId: 'loc:far-away',
          toLocationId: 'loc:bridge',
          travelMinutes: 10,
        },
      },
    });
    const result = decide(
      state,
      fixtureJourneyStartCommand({ payload: { route_id: 'route:elsewhere' } }),
      fixtureDecideContext(),
    );
    expect(result).toMatchObject({ kind: 'rejected', rejection: { code: 'route_unavailable' } });
  });

  it('отказ не бросает исключение — decide всегда возвращает значение', () => {
    expect(() =>
      decide(
        fixtureWorldState(),
        fixtureJourneyStartCommand({ actor_id: 'agent:unknown' }),
        fixtureDecideContext(),
      ),
    ).not.toThrow();
  });
});
