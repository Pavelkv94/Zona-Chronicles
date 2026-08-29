import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  WORLD_EVENT_ENVELOPE_KEYS,
  WORLD_EVENT_TYPES,
  WorldEventSchema,
  JourneyCompletedPayloadSchema,
  JourneyStartedPayloadSchema,
  PlanInvalidatedPayloadSchema,
  type WorldEvent,
  assertNeverWorldEvent,
  decodeWorldEvent,
  encodeWorldEvent,
} from './world-event.ts';
import { isValidationFailure, payloadSchemaShadowedKeys } from './validation.ts';

/** Событие из §3 документа, приведённое к канонической форме моментов. */
const VALID_EVENT = {
  event_id: 'evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0',
  world_id: 'world:prototype',
  sequence: 184_233,
  world_time: '2034-05-17T18:20:00.000Z',
  recorded_at: '2026-08-20T12:01:02.000Z',
  type: 'journey.started',
  schema_version: 1,
  rules_version: '0.1.0',
  content_version: '0.1.0',
  actor_ids: ['agent:rook'],
  subject_ids: ['route:yard-to-bridge'],
  location_id: 'loc:quiet-yard',
  correlation_id: 'corr_01J8Z4K7Q2R3S4T5V6W7X8Y9Z1',
  causation_id: 'evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z2',
  caused_by: ['evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z2'],
  command_id: 'cmd_01J8Z4K7Q2R3S4T5V6W7X8Y9Z3',
  random_audit: null,
  payload: {
    route_id: 'route:yard-to-bridge',
    expected_arrival: '2034-05-17T18:52:00.000Z',
  },
} as const;

function decoded(input: unknown): WorldEvent {
  const result = decodeWorldEvent(input);
  if (isValidationFailure(result)) {
    throw new Error(`ожидалось валидное событие, получено: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function issues(input: unknown): string {
  const result = decodeWorldEvent(input);
  if (!isValidationFailure(result)) {
    throw new Error(`ожидался отказ, событие принято: ${JSON.stringify(result.value)}`);
  }
  return result.errors.map((issue) => `${issue.path} ${issue.message}`).join('\n');
}

describe('world event envelope v1 (§3)', () => {
  it('принимает событие из документа', () => {
    expect(decoded(VALID_EVENT)).toEqual(VALID_EVENT);
  });

  it('перечисляет типы событий первого slice и ничего сверх них (§11, §12)', () => {
    expect([...WORLD_EVENT_TYPES]).toEqual([
      'journey.started',
      'journey.completed',
      'plan.invalidated',
      // I04: нужда перешла порог. Значение нужды фактом не является — оно вычисляется; фактом
      // является переход, и он происходит один раз (07_MVP_MECHANICS_SPEC §5, решение I04).
      'need.threshold.crossed',
      // I04: предмет съеден (единственный сток предметов итерации) и агент отдохнул.
      'agent.ate',
      'agent.rested',
      // I05: отдых занял мировое время, поэтому у него появилось начало как отдельный факт.
      'rest.started',
    ]);
  });

  /**
   * Каталог типов и схема union обязаны совпадать ПОЭЛЕМЕНТНО и по порядку.
   *
   * Проверка появилась после пробы Gate A, которая измеряла совсем другое: можно ли добавить
   * механизм, не правя несвязанные packages. Побочно выяснилось, что `WorldEvent` был выписан
   * рядом с каталогом ВРУЧНУЮ, и тип, добавленный в каталог, в payload-карты и в схему union, но
   * не в это перечисление, не ломал НИ ОДНОГО потребителя: `pnpm typecheck` давал ноль ошибок во
   * всём workspace. Обещание A8 из докстринга `assertNeverWorldEvent` — «добавление типа события
   * ломает компиляцию каждого потребителя» — было пустым ровно настолько, насколько внимателен
   * автор правки.
   *
   * Union теперь ВЫВОДИТСЯ из каталога, и пропуск ломает компиляцию в самих контрактах. Эта
   * проверка — второй контур, на случай если типы кто-то заглушит: `@ts-expect-error` и `as`
   * снимают проверку компилятора молча, а сверку списков — нет.
   */
  it('схема union покрывает каталог типов ровно и в том же порядке', () => {
    const variants = (WorldEventSchema as { anyOf: readonly { $id?: string }[] }).anyOf;
    expect(variants.map((variant) => variant.$id)).toEqual(
      WORLD_EVENT_TYPES.map((type) => `zona:world-event/${type}/1`),
    );
  });

  it('round-trip parse -> serialize -> parse даёт тот же результат (A4)', () => {
    const once = decoded(VALID_EVENT);
    const text = encodeWorldEvent(once);
    const twice = decoded(JSON.parse(text));
    expect(twice).toEqual(once);
    expect(encodeWorldEvent(twice)).toBe(text);
  });

  it('сериализация не зависит от порядка вставки полей (A3)', () => {
    const shuffled: Record<string, unknown> = {};
    for (const key of Object.keys(VALID_EVENT).reverse()) {
      shuffled[key] = (VALID_EVENT as Record<string, unknown>)[key];
    }
    expect(encodeWorldEvent(decoded(shuffled))).toBe(encodeWorldEvent(decoded(VALID_EVENT)));
  });

  it('encodeWorldEvent отвергает несортированное множество id, а не канонизирует что дали', () => {
    // Инвариант "множество id отсортировано" исполнялся только в decodeWorldEvent, то есть был
    // односторонним: продюсер, который строит событие сам и сразу считает checksum, получал
    // ДРУГОЙ checksum того же факта и узнавал об этом только у потребителя.
    const event = decoded(VALID_EVENT);
    for (const field of ['actor_ids', 'subject_ids', 'caused_by'] as const) {
      const unsorted = { ...event, [field]: ['agent:rook', 'agent:kite'] };
      expect(() => encodeWorldEvent(unsorted), field).toThrow(/отсортирован/);
    }
  });

  it('encodeWorldEvent принимает отсортированное множество id', () => {
    const sorted = {
      ...decoded(VALID_EVENT),
      actor_ids: ['agent:kite', 'agent:rook'],
    } as WorldEvent;
    expect(() => encodeWorldEvent(sorted)).not.toThrow();
  });

  it('нормализует смещения обоих моментов к UTC', () => {
    const event = decoded({
      ...VALID_EVENT,
      world_time: '2034-05-17T20:20:00+02:00',
      recorded_at: '2026-08-20T07:01:02-05:00',
    });
    expect(event.world_time).toBe('2034-05-17T18:20:00.000Z');
    expect(event.recorded_at).toBe('2026-08-20T12:01:02.000Z');
  });

  it('location_id, causation_id и command_id опциональны', () => {
    const { location_id: _l, causation_id: _c, command_id: _m, ...minimal } = VALID_EVENT;
    expect(decoded({ ...minimal, caused_by: [] })).toEqual({ ...minimal, caused_by: [] });
  });

  it('random_audit присутствует всегда и равен null, когда случайность не использовалась (§3)', () => {
    const { random_audit: _omitted, ...withoutAudit } = VALID_EVENT;
    expect(issues(withoutAudit)).toMatch(/random_audit/);
  });

  it('принимает random_audit со stream key и диапазоном draw (§7)', () => {
    const event = decoded({
      ...VALID_EVENT,
      random_audit: { stream_key: 'agent:rook', first_draw_index: 0, draw_count: 2 },
    });
    expect(event.random_audit).toEqual({
      stream_key: 'agent:rook',
      first_draw_index: 0,
      draw_count: 2,
    });
  });

  it('не дублирует rules_version внутри random_audit — оно уже в envelope (§4)', () => {
    expect(
      issues({
        ...VALID_EVENT,
        random_audit: {
          stream_key: 'agent:rook',
          first_draw_index: 0,
          draw_count: 1,
          rules_version: '0.1.0',
        },
      }),
    ).toMatch(/rules_version/);
  });
});

describe('world event envelope: runtime-отказы (A4)', () => {
  it.each([
    'event_id',
    'world_id',
    'sequence',
    'world_time',
    'recorded_at',
    'type',
    'schema_version',
    'rules_version',
    'content_version',
    'actor_ids',
    'subject_ids',
    'correlation_id',
    'caused_by',
    'random_audit',
    'payload',
  ])('отвергает отсутствие обязательного поля %s', (field) => {
    const broken: Record<string, unknown> = { ...VALID_EVENT };
    delete broken[field];
    expect(issues(broken)).toMatch(new RegExp(field));
  });

  it('отвергает лишнее поле', () => {
    expect(issues({ ...VALID_EVENT, importance: 3 })).toMatch(/importance/);
  });

  it.each([
    ['художественный текст', { narrative: 'Рук вышел со двора.' }],
    ['UI importance', { importance: 'high' }],
    ['observer visibility', { visible_to: ['observer'] }],
  ])('отвергает поле representation-слоя: %s (§3, ADR-005)', (_label, override) => {
    expect(isValidationFailure(decodeWorldEvent({ ...VALID_EVENT, ...override }))).toBe(true);
  });

  it.each([
    ['дробное', 1.5],
    ['ноль', 0],
    ['отрицательное', -1],
    ['строка', '184233'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('отвергает sequence %s', (_label, value) => {
    expect(isValidationFailure(decodeWorldEvent({ ...VALID_EVENT, sequence: value }))).toBe(true);
  });

  it.each([
    ['без смещения', '2034-05-17T18:20:00.000'],
    ['только дата', '2034-05-17'],
    ['несуществующая дата', '2034-02-30T00:00:00.000Z'],
  ])('отвергает world_time %s', (_label, value) => {
    expect(issues({ ...VALID_EVENT, world_time: value })).toMatch(/world_time/);
  });

  it('отвергает world_time точнее миллисекунды (A5)', () => {
    expect(issues({ ...VALID_EVENT, world_time: '2034-05-17T18:20:00.123456Z' })).toMatch(
      /world_time/,
    );
  });

  it('отвергает неизвестный type', () => {
    expect(issues({ ...VALID_EVENT, type: 'journey.interrupted' })).toMatch(/type/);
  });

  it('отвергает чужую мажорную schema_version и называет upcaster', () => {
    expect(issues({ ...VALID_EVENT, schema_version: 2 })).toMatch(/upcaster/);
  });

  it.each([
    ['не semver', 'v0.1'],
    ['пустая строка', ''],
    ['число', 1],
  ])('отвергает rules_version %s', (_label, value) => {
    expect(isValidationFailure(decodeWorldEvent({ ...VALID_EVENT, rules_version: value }))).toBe(
      true,
    );
  });

  it('отвергает поле с именем поля envelope во входных данных', () => {
    // Отказ даёт `additionalProperties: false` payload-схемы. Соблюдение §4 на уровне САМИХ
    // схем проверяется отдельно ниже: недостижимый runtime-контроль был снят мутационной
    // пробой, потому что его отключение не краснило ни один тест.
    expect(
      issues({
        ...VALID_EVENT,
        payload: { ...VALID_EVENT.payload, sequence: 184_233 },
      }),
    ).toMatch(/sequence/);
  });

  it.each([
    ['journey.started', JourneyStartedPayloadSchema],
    ['journey.completed', JourneyCompletedPayloadSchema],
    ['plan.invalidated', PlanInvalidatedPayloadSchema],
  ])('§4: payload-схема %s не объявляет полей envelope', (_type, schema) => {
    expect(payloadSchemaShadowedKeys(schema, WORLD_EVENT_ENVELOPE_KEYS)).toEqual([]);
  });

  it.each([
    ['journey.started', JourneyStartedPayloadSchema],
    ['journey.completed', JourneyCompletedPayloadSchema],
    ['plan.invalidated', PlanInvalidatedPayloadSchema],
  ])('payload-схема %s закрыта: лишнее поле невозможно', (_type, schema) => {
    expect(schema.additionalProperties).toBe(false);
  });

  it('отвергает лишнее поле в payload', () => {
    expect(issues({ ...VALID_EVENT, payload: { ...VALID_EVENT.payload, mood: 'tense' } })).toMatch(
      /mood/,
    );
  });

  it('отвергает payload от другого типа события', () => {
    expect(
      isValidationFailure(
        decodeWorldEvent({
          ...VALID_EVENT,
          type: 'journey.completed',
          payload: VALID_EVENT.payload,
        }),
      ),
    ).toBe(true);
  });
});

describe('множества идентификаторов: детерминированный порядок (SIM-01)', () => {
  it('принимает отсортированное множество', () => {
    expect(decoded({ ...VALID_EVENT, actor_ids: ['agent:kite', 'agent:rook'] }).actor_ids).toEqual([
      'agent:kite',
      'agent:rook',
    ]);
  });

  it.each([
    ['actor_ids', { actor_ids: ['agent:rook', 'agent:kite'] }],
    ['subject_ids', { subject_ids: ['route:z', 'route:a'] }],
  ])('отвергает неотсортированное множество %s: порядок менял бы checksum', (field, override) => {
    expect(issues({ ...VALID_EVENT, ...override })).toMatch(new RegExp(field));
  });

  it.each([
    ['actor_ids', { actor_ids: ['agent:rook', 'agent:rook'] }],
    [
      'caused_by',
      { caused_by: ['evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z2', 'evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z2'] },
    ],
  ])('отвергает дубликат в множестве %s', (field, override) => {
    expect(issues({ ...VALID_EVENT, ...override })).toMatch(new RegExp(field));
  });

  it('пустые множества допустимы: событие может не иметь актора или причины', () => {
    const event = decoded({ ...VALID_EVENT, actor_ids: [], subject_ids: [], caused_by: [] });
    expect(event.actor_ids).toEqual([]);
  });
});

describe('первый contract slice: payload по типам (§11)', () => {
  it('journey.completed не повторяет момент прибытия — он и есть world_time (§4)', () => {
    const event = decoded({
      ...VALID_EVENT,
      type: 'journey.completed',
      payload: { route_id: 'route:yard-to-bridge' },
    });
    expect(event.payload).toEqual({ route_id: 'route:yard-to-bridge' });
  });

  it('plan.invalidated называет план и не выполненное предусловие', () => {
    const event = decoded({
      ...VALID_EVENT,
      type: 'plan.invalidated',
      payload: { plan_id: 'plan:p1', precondition_type: 'agent.is_on_route' },
    });
    expect(event.payload).toEqual({
      plan_id: 'plan:p1',
      precondition_type: 'agent.is_on_route',
    });
  });

  it.each([
    ['precondition_type не точечное имя', { plan_id: 'plan:p1', precondition_type: 'ready' }],
    ['plan_id не namespaced', { plan_id: 'p1', precondition_type: 'agent.is_on_route' }],
  ])('отвергает plan.invalidated: %s', (_label, payload) => {
    expect(
      isValidationFailure(decodeWorldEvent({ ...VALID_EVENT, type: 'plan.invalidated', payload })),
    ).toBe(true);
  });

  it('journey.started требует expected_arrival с явным смещением', () => {
    expect(
      issues({
        ...VALID_EVENT,
        payload: { route_id: 'route:a', expected_arrival: '2034-05-17T18:52:00' },
      }),
    ).toMatch(/expected_arrival/);
  });

  it('нормализует момент внутри payload, а не только в envelope', () => {
    const event = decoded({
      ...VALID_EVENT,
      payload: { route_id: 'route:a', expected_arrival: '2034-05-17T20:52:00+02:00' },
    });
    expect(event.type === 'journey.started' && event.payload.expected_arrival).toBe(
      '2034-05-17T18:52:00.000Z',
    );
  });
});

describe('A8: union пригоден для исчерпывающей проверки в evolve', () => {
  /**
   * Отрицательный type-тест. Ветки `plan.invalidated` здесь нет намеренно, поэтому в `default`
   * значение НЕ сузилось до `never` и `assertNeverWorldEvent` не компилируется. Директива
   * `@ts-expect-error` фиксирует это как ожидаемое поведение: если union станет проверяемым
   * не исчерпывающе (например, `type` перестанет быть литеральным дискриминатором), ошибка
   * исчезнет, директива станет неиспользованной и `pnpm typecheck` упадёт на ней самой.
   */
  function withMissingBranch(event: WorldEvent): string {
    // Здесь намеренно НЕ `switch`: eslint-правило `switch-exhaustiveness-check` — второй,
    // независимый контроль того же требования, и оно сломало бы `pnpm lint` на этом файле.
    // Проверяется именно компилятор, поэтому форма ветвления роли не играет.
    if (event.type === 'journey.started') {
      return 'started';
    }
    if (event.type === 'journey.completed') {
      return 'completed';
    }
    // @ts-expect-error ветка plan.invalidated не обработана, значит event не сузился до never
    return assertNeverWorldEvent(event);
  }

  function withAllBranches(event: WorldEvent): string {
    switch (event.type) {
      case 'journey.started':
        return 'started';
      case 'journey.completed':
        return 'completed';
      case 'plan.invalidated':
        return 'invalidated';
      case 'need.threshold.crossed':
        return 'need-crossed';
      case 'agent.ate':
        return 'ate';
      case 'agent.rested':
        return 'rested';
      case 'rest.started':
        return 'rest-started';
      default:
        return assertNeverWorldEvent(event);
    }
  }

  it('исчерпывающий switch возвращает результат для каждого типа', () => {
    const started = decoded(VALID_EVENT);
    const invalidated = decoded({
      ...VALID_EVENT,
      type: 'plan.invalidated',
      payload: { plan_id: 'plan:p1', precondition_type: 'agent.is_on_route' },
    });
    const crossed = decoded({
      ...VALID_EVENT,
      type: 'need.threshold.crossed',
      payload: {
        need: 'hunger',
        from_level: 'normal',
        to_level: 'warning',
        next_threshold_at: '2034-05-17T22:00:00.000Z',
      },
    });
    expect(withAllBranches(started)).toBe('started');
    expect(withAllBranches(invalidated)).toBe('invalidated');
    expect(withAllBranches(crossed)).toBe('need-crossed');
  });

  it('неисчерпывающий switch падает в runtime, а не возвращает undefined', () => {
    const invalidated = decoded({
      ...VALID_EVENT,
      type: 'plan.invalidated',
      payload: { plan_id: 'plan:p1', precondition_type: 'agent.is_on_route' },
    });
    expect(() => withMissingBranch(invalidated)).toThrow(/plan\.invalidated/);
  });

  it('сужение по type даёт payload конкретного события', () => {
    const event = decoded(VALID_EVENT);
    if (event.type !== 'journey.started') {
      throw new Error('ожидалось journey.started');
    }
    // Тип payload сузился: `expected_arrival` существует только у этого варианта.
    expect(event.payload.expected_arrival).toBe('2034-05-17T18:52:00.000Z');
  });
});

describe('WorldEventSchema пригодна как JSON Schema', () => {
  it('перечисляет ключи envelope для проверки §4', () => {
    expect([...WORLD_EVENT_ENVELOPE_KEYS]).toContain('world_time');
    expect([...WORLD_EVENT_ENVELOPE_KEYS]).toContain('payload');
  });

  it('сериализуется в JSON без RegExp', () => {
    expect(() => JSON.stringify(WorldEventSchema)).not.toThrow();
    expect(JSON.stringify(WorldEventSchema)).toContain('pattern');
  });

  it('является union по type, а не одной объектной схемой', () => {
    expect(Value.Check(WorldEventSchema, VALID_EVENT)).toBe(true);
    expect(Value.Check(WorldEventSchema, { ...VALID_EVENT, type: 'journey.completed' })).toBe(
      false,
    );
  });
});

describe('need.threshold.crossed (I04)', () => {
  const crossing = (payload: Record<string, unknown>) => ({
    ...VALID_EVENT,
    type: 'need.threshold.crossed',
    payload,
  });

  it('момент следующего порога нормализуется к канонической форме', () => {
    const event = decoded(
      crossing({
        need: 'hunger',
        from_level: 'normal',
        to_level: 'warning',
        next_threshold_at: '2034-05-17T23:00:00+01:00',
      }),
    );
    if (event.type !== 'need.threshold.crossed')
      throw new Error('ожидалось need.threshold.crossed');
    expect(event.payload.next_threshold_at).toBe('2034-05-17T22:00:00.000Z');
  });

  it('null означает «следующего порога нет» и проходит нормализацию как значение', () => {
    // Регресс: нормализатор моментов payload разбирал поле безусловно, поэтому законный `null`
    // отвергался как невалидный момент — событие, которое схема принимает, декодер отвергал.
    const event = decoded(
      crossing({
        need: 'hunger',
        from_level: 'warning',
        to_level: 'critical',
        next_threshold_at: null,
      }),
    );
    if (event.type !== 'need.threshold.crossed')
      throw new Error('ожидалось need.threshold.crossed');
    expect(event.payload.next_threshold_at).toBeNull();
  });

  it('значение нужды в payload не принимается: факт — переход, а не измерение', () => {
    const result = decodeWorldEvent(
      crossing({
        need: 'hunger',
        from_level: 'normal',
        to_level: 'warning',
        next_threshold_at: null,
        value: 0.46,
      }),
    );
    expect(isValidationFailure(result)).toBe(true);
  });

  it('неизвестный вид нужды отвергается словарём, а не свободной строкой', () => {
    const result = decodeWorldEvent(
      crossing({
        need: 'thirst',
        from_level: 'normal',
        to_level: 'warning',
        next_threshold_at: null,
      }),
    );
    expect(isValidationFailure(result)).toBe(true);
  });
});
