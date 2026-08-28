/**
 * Свёртка журнала в observer projection: применяет записанные факты и ничего не решает заново.
 */
import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '@zona/contracts';
import {
  applyObserverEvent,
  initialObserverProjection,
  type ObserverProjectionState,
} from './observer-fold.ts';

const WORLD_ID = 'world:prototype';

const seed = () =>
  initialObserverProjection({
    worldId: WORLD_ID,
    worldTime: '2028-04-26T06:00:00.000Z',
    nodes: [
      { location_id: 'loc:quiet-yard', name: 'Тихий двор', description: 'Двор.' },
      { location_id: 'loc:bridge', name: 'Мост', description: 'Мост.' },
    ],
    edges: [
      {
        route_id: 'route:yard-to-bridge',
        from_location_id: 'loc:quiet-yard',
        to_location_id: 'loc:bridge',
        travel_minutes: 40,
      },
    ],
    agents: [
      {
        agent_id: 'agent:rook',
        name: 'Рук',
        location_id: 'loc:quiet-yard',
        status: 'idle',
        route_id: null,
        needs: { hunger: 'normal', fatigue: 'normal' },
      },
    ],
  });

const started = (sequence: number): WorldEvent =>
  ({
    event_id: `evt_${'A'.repeat(20)}${String(sequence).padStart(6, '0')}`,
    world_id: WORLD_ID,
    sequence,
    world_time: '2028-04-26T06:00:00.000Z',
    recorded_at: '2026-08-23T00:00:00.000Z',
    type: 'journey.started',
    schema_version: 1,
    rules_version: '0.1.0',
    content_version: '0.1.0',
    actor_ids: ['agent:rook'],
    subject_ids: [],
    location_id: 'loc:quiet-yard',
    correlation_id: `corr_${'B'.repeat(20)}000001`,
    caused_by: [],
    payload: { route_id: 'route:yard-to-bridge', expected_arrival: '2028-04-26T06:40:00.000Z' },
  }) as unknown as WorldEvent;

const completed = (sequence: number, locationId: string | undefined): WorldEvent =>
  ({
    event_id: `evt_${'C'.repeat(20)}${String(sequence).padStart(6, '0')}`,
    world_id: WORLD_ID,
    sequence,
    world_time: '2028-04-26T06:40:00.000Z',
    recorded_at: '2026-08-23T00:00:00.000Z',
    type: 'journey.completed',
    schema_version: 1,
    rules_version: '0.1.0',
    content_version: '0.1.0',
    actor_ids: ['agent:rook'],
    subject_ids: [],
    ...(locationId === undefined ? {} : { location_id: locationId }),
    correlation_id: `corr_${'B'.repeat(20)}000001`,
    caused_by: [],
    payload: { route_id: 'route:yard-to-bridge' },
  }) as unknown as WorldEvent;

describe('свёртка: агент в пути не стоит ни в одной локации', () => {
  it('journey.started убирает агента с карты и ставит маршрут', () => {
    const { state, emitted } = applyObserverEvent(seed(), started(1));

    expect(state.agents['agent:rook']).toEqual({
      agent_id: 'agent:rook',
      name: 'Рук',
      location_id: null,
      status: 'traveling',
      route_id: 'route:yard-to-bridge',
      needs: { hunger: 'normal', fatigue: 'normal' },
    });
    expect(emitted.projection_sequence).toBe(1);
    expect(emitted.type).toBe('journey.started');
  });

  it('journey.completed ставит агента ТУДА, ГДЕ ПРОИЗОШЛО СОБЫТИЕ, а не в конец маршрута по контенту', () => {
    const afterStart = applyObserverEvent(seed(), started(1)).state;
    // Место прибытия приходит из события. Специально НЕ `loc:bridge` из ребра: если бы свёртка
    // вычисляла место по маршруту, этот тест бы упал — и именно это и проверяется.
    const { state } = applyObserverEvent(afterStart, completed(2, 'loc:quiet-yard'));

    expect(state.agents['agent:rook']).toMatchObject({
      status: 'idle',
      location_id: 'loc:quiet-yard',
      route_id: null,
    });
  });

  it('journey.completed без места прибытия — громкий отказ, а не догадка по маршруту', () => {
    const afterStart = applyObserverEvent(seed(), started(1)).state;
    expect(() => applyObserverEvent(afterStart, completed(2, undefined))).toThrow(/location_id/);
  });
});

describe('свёртка: курсоры', () => {
  it('projection_sequence растёт на каждое событие и начинается с 1', () => {
    let state: ObserverProjectionState = seed();
    const sequences: number[] = [];
    for (const event of [started(1), completed(2, 'loc:bridge')]) {
      const result = applyObserverEvent(state, event);
      state = result.state;
      sequences.push(result.emitted.projection_sequence);
    }
    expect(sequences).toEqual([1, 2]);
    expect(state.lastEventSequence).toBe(2);
  });

  it('мировое время проекции — время последнего применённого факта, не обгоняет журнал', () => {
    const { state } = applyObserverEvent(seed(), completed(1, 'loc:bridge'));
    expect(state.worldTime).toBe('2028-04-26T06:40:00.000Z');
  });

  /** D6: догон после перезапуска обязан быть ровно один раз на событие. */
  it('повторное применение того же события — отказ, а не удвоенная лента', () => {
    const first = applyObserverEvent(seed(), started(1));
    expect(() => applyObserverEvent(first.state, started(1))).toThrow(/уже применено/);
  });

  it('событие чужого мира отвергается', () => {
    const alien = { ...started(1), world_id: 'world:other' } as WorldEvent;
    expect(() => applyObserverEvent(seed(), alien)).toThrow(/принадлежит миру/);
  });

  it('событие про неизвестного агента — отказ, а не выдуманный агент', () => {
    const unknown = { ...started(1), actor_ids: ['agent:ghost'] } as WorldEvent;
    expect(() => applyObserverEvent(seed(), unknown)).toThrow(/agent:ghost/);
  });
});

describe('свёртка: факт без эффекта на карту всё равно попадает в ленту', () => {
  it('plan.invalidated не меняет агентов, но порождает запись', () => {
    const event = {
      ...started(1),
      type: 'plan.invalidated',
      payload: { reason: 'route_unavailable' },
    } as unknown as WorldEvent;

    const before = seed();
    const { state, emitted } = applyObserverEvent(before, event);

    expect(state.agents).toEqual(before.agents);
    expect(emitted.type).toBe('plan.invalidated');
    expect(emitted.projection_sequence).toBe(1);
  });
});
