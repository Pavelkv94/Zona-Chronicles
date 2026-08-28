/**
 * Contract-тесты observer-слоя (I03).
 *
 * Проверяется не «схема существует», а три запрета, каждый из которых уже однажды был бы
 * нарушен без проверки: отсутствие художественного текста как факта, отсутствие канонических
 * полей в публичном ответе и отдельное версионирование от канонического schema bundle.
 */
import { describe, expect, it } from 'vitest';
import {
  OBSERVER_STREAM_EVENT_NAMES,
  ObserverAgentSchema,
  ObserverEventSchema,
  ObserverMapEdgeSchema,
  ObserverMapNodeSchema,
  ObserverStreamResetSchema,
  ObserverWorldSnapshotSchema,
  decodeObserverEvent,
  decodeObserverWorldSnapshot,
} from './observer.ts';
import { schemaBundleContent } from './schema-bundle.ts';
import { isValidationFailure } from './validation.ts';

const OBSERVER_SCHEMAS = [
  ObserverAgentSchema,
  ObserverEventSchema,
  ObserverMapEdgeSchema,
  ObserverMapNodeSchema,
  ObserverStreamResetSchema,
  ObserverWorldSnapshotSchema,
] as const;

const validSnapshot = () => ({
  world_id: 'world:prototype',
  projection_sequence: 4,
  world_time: '2028-04-26T06:40:00.000Z',
  nodes: [{ location_id: 'loc:bridge', name: 'Мост', description: 'Полуразрушенный мост.' }],
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
      location_id: 'loc:bridge',
      status: 'idle',
      route_id: null,
      needs: { hunger: 'normal', fatigue: 'warning' },
    },
  ],
});

const validEvent = () => ({
  projection_sequence: 2,
  event_id: 'evt_D2ETY739KPRAYTMXP916Q7DKTN',
  world_time: '2028-04-26T06:40:00.000Z',
  type: 'journey.completed',
  actor_ids: ['agent:rook'],
  location_id: 'loc:bridge',
  route_id: 'route:yard-to-bridge',
  need: null,
  need_level: null,
});

describe('observer: публичный ответ не несёт канонических и скрытых полей', () => {
  it('snapshot принимает валидное тело', () => {
    const result = decodeObserverWorldSnapshot(validSnapshot());
    expect(isValidationFailure(result)).toBe(false);
  });

  /**
   * §7 03_TECHNICAL_DESIGN прямо запрещает публичному snapshot сериализовать canonical snapshot,
   * hidden fields, точное knowledge state и decision trace. Проверяется КАЖДОЕ имя по отдельности,
   * а не «схема строгая»: строгость можно ослабить одной правкой, и тогда тест обязан назвать,
   * ЧТО именно просочилось.
   */
  it.each([
    ['canonical_state', { canonical_state: {} }],
    ['checksum', { checksum: 'sha256:0'.padEnd(71, '0') }],
    ['last_sequence', { last_sequence: 4 }],
    ['deterministic_runtime_profile', { deterministic_runtime_profile: {} }],
    ['prng_stream_positions', { prng_stream_positions: {} }],
    ['bundles', { bundles: {} }],
    ['seed', { seed: 42 }],
  ])('поле %s отвергается публичным snapshot', (_name, extra) => {
    const result = decodeObserverWorldSnapshot({ ...validSnapshot(), ...extra });
    expect(isValidationFailure(result)).toBe(true);
  });

  it('канонический sequence не подменяет projection_sequence: поле называется своим именем', () => {
    const { projection_sequence: _dropped, ...withoutCursor } = validSnapshot();
    const result = decodeObserverWorldSnapshot({ ...withoutCursor, sequence: 4 });
    expect(isValidationFailure(result)).toBe(true);
  });
});

describe('observer: лента отдаёт факты, а не текст о них (ADR-005)', () => {
  it('событие принимается', () => {
    expect(isValidationFailure(decodeObserverEvent(validEvent()))).toBe(false);
  });

  /**
   * ADR-005: текст никогда не является источником факта. Если бы событие несло готовую фразу,
   * зритель читал бы ЕЁ, а не факт, и расхождение фразы с фактом стало бы невидимым.
   */
  it.each([
    ['summary', { summary: 'Рук дошёл до моста' }],
    ['text', { text: 'Рук дошёл до моста' }],
    ['narrative', { narrative: 'Рук дошёл до моста' }],
    ['importance', { importance: 'high' }],
    ['payload', { payload: {} }],
  ])('поле %s отвергается событием ленты', (_name, extra) => {
    expect(isValidationFailure(decodeObserverEvent({ ...validEvent(), ...extra }))).toBe(true);
  });

  it('мировое время приводится к канонической форме, а не только проверяется шаблоном', () => {
    const result = decodeObserverEvent({
      ...validEvent(),
      world_time: '2028-04-26T08:40:00+02:00',
    });
    expect(isValidationFailure(result)).toBe(false);
    if (isValidationFailure(result)) return;
    expect(result.value.world_time).toBe('2028-04-26T06:40:00.000Z');
  });
});

describe('observer: версионируется отдельно от канонического schema bundle', () => {
  /**
   * Включение observer-схем в канонический bundle связало бы снимки мира с контрактом UI:
   * переименование поля на экране меняло бы checksum bundle, и снимки, снятые до правки,
   * объявлялись бы несовместимыми. Мир переставал бы восстанавливаться из-за правки вёрстки.
   */
  it('ни одна observer-схема не входит в канонический schema bundle', () => {
    const bundleIds = Object.keys(schemaBundleContent());
    for (const schema of OBSERVER_SCHEMAS) {
      expect(bundleIds).not.toContain(schema.$id);
    }
  });

  it('каждая observer-схема адресуема и несёт мажор в $id', () => {
    for (const schema of OBSERVER_SCHEMAS) {
      expect(schema.$id).toMatch(/^zona:observer-[a-z-]+\/\d+$/);
    }
  });
});

describe('observer: имена событий потока — литералы', () => {
  it('имена заданы и различны', () => {
    const names = Object.values(OBSERVER_STREAM_EVENT_NAMES);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length > 0)).toBe(true);
  });
});
