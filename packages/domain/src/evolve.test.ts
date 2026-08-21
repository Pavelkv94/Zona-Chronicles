import type { WorldEvent } from '@zona/contracts';
import { describe, expect, it } from 'vitest';
import { fixtureWorldState } from './__fixtures__/world.ts';
import { evolve } from './evolve.ts';

function journeyStartedEvent(overrides: Partial<WorldEvent> = {}): WorldEvent {
  return {
    event_id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    world_id: 'world:prototype',
    sequence: 1,
    world_time: '2034-05-17T18:20:00.000Z',
    recorded_at: '2034-05-17T18:20:01.000Z',
    type: 'journey.started',
    schema_version: 1,
    rules_version: '0.1.0',
    content_version: '0.1.0',
    actor_ids: ['agent:rook'],
    subject_ids: [],
    location_id: 'loc:quiet-yard',
    correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    caused_by: [],
    command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    random_audit: null,
    payload: { route_id: 'route:yard-to-bridge', expected_arrival: '2034-05-17T19:00:00.000Z' },
    ...overrides,
  } as WorldEvent;
}

describe('evolve: journey.started', () => {
  it('переводит актора в traveling и записывает маршрут', () => {
    const next = evolve(fixtureWorldState(), journeyStartedEvent());
    expect(next.agents['agent:rook']).toStrictEqual({
      id: 'agent:rook',
      locationId: 'loc:quiet-yard',
      status: 'traveling',
      routeId: 'route:yard-to-bridge',
    });
  });

  it('продвигает worldVersion, worldTime и sequence по книгам события', () => {
    const next = evolve(fixtureWorldState(), journeyStartedEvent());
    expect(next.worldVersion).toBe(1);
    expect(next.worldTime).toBe('2034-05-17T18:20:00.000Z');
    expect(next.sequence).toBe(1);
  });

  it('не читает event.recorded_at: два события, различающиеся только recorded_at, дают одно и то же состояние', () => {
    const a = evolve(
      fixtureWorldState(),
      journeyStartedEvent({ recorded_at: '2099-01-01T00:00:00.000Z' }),
    );
    const b = evolve(
      fixtureWorldState(),
      journeyStartedEvent({ recorded_at: '2000-01-01T00:00:00.000Z' }),
    );
    expect(a).toStrictEqual(b);
  });

  it('бросает на журнале с неизвестным актором — это нарушение причинности, а не доменный отказ', () => {
    expect(() =>
      evolve(fixtureWorldState(), journeyStartedEvent({ actor_ids: ['agent:ghost'] })),
    ).toThrow(/agent:ghost/);
  });
});

describe('evolve: journey.completed', () => {
  it('переводит актора в idle, переносит в toLocationId и очищает routeId', () => {
    const traveling = evolve(fixtureWorldState(), journeyStartedEvent());
    const completed: WorldEvent = {
      event_id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      world_id: 'world:prototype',
      sequence: 2,
      world_time: '2034-05-17T19:00:00.000Z',
      recorded_at: '2034-05-17T19:00:01.000Z',
      type: 'journey.completed',
      schema_version: 1,
      rules_version: '0.1.0',
      content_version: '0.1.0',
      actor_ids: ['agent:rook'],
      subject_ids: [],
      location_id: 'loc:bridge',
      correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      caused_by: [],
      random_audit: null,
      payload: { route_id: 'route:yard-to-bridge' },
    };
    const next = evolve(traveling, completed);
    expect(next.agents['agent:rook']).toStrictEqual({
      id: 'agent:rook',
      locationId: 'loc:bridge',
      status: 'idle',
      routeId: null,
    });
  });
});

describe('evolve: plan.invalidated', () => {
  it('продвигает bookkeeping (worldVersion/worldTime/sequence), не меняя агентов и маршруты', () => {
    const before = fixtureWorldState();
    const event: WorldEvent = {
      event_id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAX',
      world_id: 'world:prototype',
      sequence: 1,
      world_time: '2034-05-17T18:20:00.000Z',
      recorded_at: '2034-05-17T18:20:01.000Z',
      type: 'plan.invalidated',
      schema_version: 1,
      rules_version: '0.1.0',
      content_version: '0.1.0',
      actor_ids: ['agent:rook'],
      subject_ids: [],
      correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      caused_by: [],
      random_audit: null,
      payload: { plan_id: 'plan:rook-1', precondition_type: 'agent.is_on_route' },
    };
    const next = evolve(before, event);
    expect(next.agents).toStrictEqual(before.agents);
    expect(next.routes).toStrictEqual(before.routes);
    expect(next.worldVersion).toBe(before.worldVersion + 1);
  });
});
