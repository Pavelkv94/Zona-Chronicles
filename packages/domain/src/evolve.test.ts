import type { WorldEvent } from '@zona/contracts';
import { describe, expect, it } from 'vitest';
import { fixtureWorldState, fixtureNeedBaseline } from './__fixtures__/world.ts';
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
      needBaseline: fixtureNeedBaseline(),
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
      needBaseline: fixtureNeedBaseline(),
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

describe('M7 — снятие действия из расписания по причине, а не по совпадению полей', () => {
  const scheduled = (id: string, entityId: string, routeId: string) => ({
    id,
    kind: 'journey.complete' as const,
    dueAt: '2028-04-26T06:40:00.000Z',
    priority: 100,
    entityId,
    routeId,
  });

  it('снимает ИМЕННО то действие, которое породило завершение', () => {
    // Две механики планируют для одной пары «агент + маршрут». Сегодня такого в мире нет, но
    // фильтр по совпадению полей снял бы ОБА, и расписание разошлось бы с журналом молча —
    // заметно только при replay, то есть сильно позже причины.
    const base = fixtureWorldState({
      agents: {
        'agent:rook': {
          id: 'agent:rook',
          locationId: 'loc:quiet-yard',
          status: 'traveling',
          routeId: 'route:yard-to-bridge',
          needBaseline: fixtureNeedBaseline(),
        },
      },
      scheduledActions: {
        evt_cause: scheduled('evt_cause', 'agent:rook', 'route:yard-to-bridge'),
        evt_other: scheduled('evt_other', 'agent:rook', 'route:yard-to-bridge'),
      },
    });

    const next = evolve(base, {
      event_id: 'evt_done',
      world_id: base.worldId,
      sequence: base.sequence + 1,
      world_time: '2028-04-26T06:40:00.000Z',
      type: 'journey.completed',
      schema_version: 1,
      rules_version: '0.1.0',
      content_version: '0.1.0',
      actor_ids: ['agent:rook'],
      subject_ids: [],
      location_id: 'loc:bridge',
      correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      caused_by: ['evt_cause'],
      command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      random_audit: null,
      recorded_at: '2026-08-22T00:00:00.000Z',
      payload: { route_id: 'route:yard-to-bridge' },
    });

    expect(Object.keys(next.scheduledActions)).toEqual(['evt_other']);
  });

  it('событие без caused_by применяется по-старому: журнал невосполним', () => {
    // Совместимость с фактами, записанными до M7. Их нельзя переписать, значит их надо
    // продолжать применять так, как они были записаны.
    const base = fixtureWorldState({
      agents: {
        'agent:rook': {
          id: 'agent:rook',
          locationId: 'loc:quiet-yard',
          status: 'traveling',
          routeId: 'route:yard-to-bridge',
          needBaseline: fixtureNeedBaseline(),
        },
      },
      scheduledActions: {
        evt_legacy: scheduled('evt_legacy', 'agent:rook', 'route:yard-to-bridge'),
      },
    });

    const next = evolve(base, {
      event_id: 'evt_done',
      world_id: base.worldId,
      sequence: base.sequence + 1,
      world_time: '2028-04-26T06:40:00.000Z',
      type: 'journey.completed',
      schema_version: 1,
      rules_version: '0.1.0',
      content_version: '0.1.0',
      actor_ids: ['agent:rook'],
      subject_ids: [],
      location_id: 'loc:bridge',
      correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      caused_by: [],
      command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      random_audit: null,
      recorded_at: '2026-08-22T00:00:00.000Z',
      payload: { route_id: 'route:yard-to-bridge' },
    });

    expect(Object.keys(next.scheduledActions)).toEqual([]);
  });
});
