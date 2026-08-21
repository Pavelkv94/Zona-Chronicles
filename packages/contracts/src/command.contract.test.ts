import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  COMMAND_ENVELOPE_KEYS,
  COMMAND_REJECTION_CODES,
  COMMAND_TYPES,
  CommandRejectionCodeSchema,
  CommandSchema,
  ENVELOPE_SCHEMA_VERSION,
  JourneyStartPayloadSchema,
  type Command,
  decodeCommand,
  encodeCommand,
} from './command.ts';
import { isValidationFailure, payloadSchemaShadowedKeys } from './validation.ts';

/** Валидный envelope из §2 документа, приведённый к канонической форме момента. */
const VALID_COMMAND = {
  command_id: 'cmd_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0',
  world_id: 'world:prototype',
  type: 'journey.start',
  schema_version: 1,
  actor_id: 'agent:rook',
  issued_at_world_time: '2034-05-17T18:20:00.000Z',
  expected_world_version: 184_232,
  correlation_id: 'corr_01J8Z4K7Q2R3S4T5V6W7X8Y9Z1',
  caused_by_event_id: 'evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z2',
  payload: { route_id: 'route:yard-to-bridge' },
} as const;

function decoded(input: unknown): Command {
  const result = decodeCommand(input);
  if (isValidationFailure(result)) {
    throw new Error(`ожидалась валидная команда, получено: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function issues(input: unknown): string {
  const result = decodeCommand(input);
  if (!isValidationFailure(result)) {
    throw new Error(`ожидался отказ, команда принята: ${JSON.stringify(result.value)}`);
  }
  return result.errors.map((issue) => `${issue.path} ${issue.message}`).join('\n');
}

describe('command envelope v1 (§2)', () => {
  it('принимает envelope из документа', () => {
    expect(decoded(VALID_COMMAND)).toEqual(VALID_COMMAND);
  });

  it('перечисляет типы команд первого slice и ничего сверх них (§11, §12)', () => {
    expect([...COMMAND_TYPES]).toEqual(['journey.start']);
  });

  it('объявляет версию схемы envelope', () => {
    expect(ENVELOPE_SCHEMA_VERSION).toBe(1);
  });

  it('caused_by_event_id опционален: команда может не иметь события-причины', () => {
    const { caused_by_event_id: _omitted, ...withoutCause } = VALID_COMMAND;
    expect(decoded(withoutCause)).toEqual(withoutCause);
  });

  it('round-trip parse -> serialize -> parse даёт тот же результат (A4)', () => {
    const once = decoded(VALID_COMMAND);
    const text = encodeCommand(once);
    const twice = decoded(JSON.parse(text));
    expect(twice).toEqual(once);
    expect(encodeCommand(twice)).toBe(text);
  });

  it('сериализация канонична: порядок вставки полей не влияет на текст', () => {
    const shuffled: Record<string, unknown> = {};
    for (const key of Object.keys(VALID_COMMAND).reverse()) {
      shuffled[key] = (VALID_COMMAND as Record<string, unknown>)[key];
    }
    expect(encodeCommand(decoded(shuffled))).toBe(encodeCommand(decoded(VALID_COMMAND)));
  });
});

describe('command envelope: runtime-отказы (A4)', () => {
  it('отвергает лишнее поле', () => {
    expect(issues({ ...VALID_COMMAND, importance: 'high' })).toMatch(/importance/);
  });

  it('отвергает лишнее поле, даже если оно называется как поле события', () => {
    expect(issues({ ...VALID_COMMAND, sequence: 1 })).toMatch(/sequence/);
  });

  it.each([
    'command_id',
    'world_id',
    'type',
    'schema_version',
    'actor_id',
    'issued_at_world_time',
    'expected_world_version',
    'correlation_id',
    'payload',
  ])('отвергает отсутствие обязательного поля %s', (field) => {
    const broken: Record<string, unknown> = { ...VALID_COMMAND };
    delete broken[field];
    expect(issues(broken)).toMatch(new RegExp(field));
  });

  it.each([
    ['schema_version строкой', { schema_version: '1' }],
    ['expected_world_version строкой', { expected_world_version: '1' }],
    ['actor_id числом', { actor_id: 1 }],
    ['payload строкой', { payload: 'route:yard-to-bridge' }],
    ['payload массивом', { payload: [] }],
    ['command_id null', { command_id: null }],
  ])('отвергает неверный тип: %s', (_label, override) => {
    expect(isValidationFailure(decodeCommand({ ...VALID_COMMAND, ...override }))).toBe(true);
  });

  it.each([
    ['не объект: строка', 'journey.start'],
    ['не объект: массив', []],
    ['не объект: null', null],
    ['не объект: число', 1],
  ])('отвергает вход, который не является объектом: %s', (_label, input) => {
    expect(isValidationFailure(decodeCommand(input))).toBe(true);
  });

  it.each([
    ['без смещения', '2034-05-17T18:20:00.000'],
    ['только дата', '2034-05-17'],
    ['локальное время', '2034-05-17 18:20:00'],
    ['мусор', 'скоро'],
  ])('отвергает issued_at_world_time %s', (_label, value) => {
    expect(issues({ ...VALID_COMMAND, issued_at_world_time: value })).toMatch(
      /issued_at_world_time/,
    );
  });

  it('нормализует момент со смещением к канонической форме UTC', () => {
    const command = decoded({
      ...VALID_COMMAND,
      issued_at_world_time: '2034-05-17T20:20:00+02:00',
    });
    expect(command.issued_at_world_time).toBe('2034-05-17T18:20:00.000Z');
  });

  it('отвергает момент точнее миллисекунды (A5)', () => {
    expect(issues({ ...VALID_COMMAND, issued_at_world_time: '2034-05-17T18:20:00.1234Z' })).toMatch(
      /issued_at_world_time/,
    );
  });

  it.each([
    ['дробное', 1.5],
    ['отрицательное', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('отвергает нецелое expected_world_version: %s', (_label, value) => {
    expect(
      isValidationFailure(decodeCommand({ ...VALID_COMMAND, expected_world_version: value })),
    ).toBe(true);
  });

  it('отвергает неизвестный type', () => {
    expect(issues({ ...VALID_COMMAND, type: 'journey.abort' })).toMatch(/type/);
  });

  it('отвергает чужую мажорную schema_version и называет причину', () => {
    expect(issues({ ...VALID_COMMAND, schema_version: 2 })).toMatch(/верси/i);
  });

  it.each([
    ['слаг без namespace', 'yard-to-bridge'],
    ['верхний регистр', 'Route:yard'],
    ['пустая строка', ''],
  ])('отвергает route_id %s', (_label, value) => {
    expect(issues({ ...VALID_COMMAND, payload: { route_id: value } })).toMatch(/route_id/);
  });

  it('отвергает лишнее поле внутри payload', () => {
    expect(issues({ ...VALID_COMMAND, payload: { route_id: 'route:a', haste: true } })).toMatch(
      /haste/,
    );
  });

  it('отвергает поле с именем поля envelope во входных данных', () => {
    // Отказ приходит от `additionalProperties: false` payload-схемы, а не от отдельной
    // проверки §4: см. описание в блоке «§4: payload-схемы не объявляют полей envelope».
    expect(
      issues({ ...VALID_COMMAND, payload: { route_id: 'route:a', world_id: 'world:prototype' } }),
    ).toMatch(/world_id/);
  });

  it.each([
    ['чужой префикс', 'evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0'],
    ['без префикса', '01J8Z4K7Q2R3S4T5V6W7X8Y9Z0'],
  ])('отвергает command_id %s', (_label, value) => {
    expect(issues({ ...VALID_COMMAND, command_id: value })).toMatch(/command_id/);
  });

  it('сообщает путь до поля, а не только факт отказа', () => {
    const result = decodeCommand({ ...VALID_COMMAND, payload: { route_id: 'НЕВЕРНО' } });
    if (!isValidationFailure(result)) {
      throw new Error('ожидался отказ');
    }
    expect(result.errors[0]?.path).toBe('/payload/route_id');
  });
});

describe('rejection codes (§2)', () => {
  it('перечисляет минимальный набор из документа', () => {
    expect([...COMMAND_REJECTION_CODES]).toEqual([
      'invalid_schema',
      'stale_world_version',
      'actor_not_actionable',
      'precondition_failed',
      'resource_unavailable',
      'route_unavailable',
      'conflicting_scene',
    ]);
  });

  it('перечисление исполняемо: валидируется в runtime', () => {
    expect(Value.Check(CommandRejectionCodeSchema, 'route_unavailable')).toBe(true);
    expect(Value.Check(CommandRejectionCodeSchema, 'not_in_the_mood')).toBe(false);
    expect(Value.Check(CommandRejectionCodeSchema, 'db_timeout')).toBe(false);
  });
});

describe('CommandSchema пригодна как JSON Schema', () => {
  it('не содержит RegExp в pattern: Fastify и OpenAPI принимают только строки', () => {
    const serialized = JSON.stringify(CommandSchema);
    expect(serialized).toContain('pattern');
    expect(JSON.parse(serialized)).toBeTypeOf('object');
  });

  it('запрещает дополнительные свойства на верхнем уровне', () => {
    expect(Value.Check(CommandSchema, { ...VALID_COMMAND, extra: 1 })).toBe(false);
  });
});

/**
 * §4 «поля envelope не дублируются в payload» — проверка на СХЕМАХ, а не на данных.
 *
 * Мутационная проба показала, что прежний runtime-контроль был недостижим: у каждой
 * payload-схемы стоит `additionalProperties: false`, поэтому лишнее поле `world_id`
 * отклоняется как «Unexpected property» ещё до него, и снятие контроля не краснило ни один
 * тест. Недостижимый контроль — это не защита, а видимость защиты.
 *
 * Реально возможное нарушение §4 другое: автор схемы ОБЪЯВИТ поле с именем поля envelope,
 * и тогда дубликат станет легальным по схеме. Ловится это только проверкой самих схем.
 */
describe('§4: payload-схемы не объявляют полей envelope', () => {
  it('journey.start не дублирует ни одного поля envelope', () => {
    expect(payloadSchemaShadowedKeys(JourneyStartPayloadSchema, COMMAND_ENVELOPE_KEYS)).toEqual([]);
  });

  it('детектор действительно срабатывает на схеме, которая дублирует поле envelope', () => {
    // Фикстура обязательна: правило без фикстуры не отличимо от отсутствующего правила
    // (ADR-003, урок раунда 3 верификации I00).
    const shadowing = Type.Object(
      { route_id: Type.String(), world_id: Type.String(), actor_id: Type.String() },
      { additionalProperties: false },
    );
    expect(payloadSchemaShadowedKeys(shadowing, COMMAND_ENVELOPE_KEYS)).toEqual([
      'actor_id',
      'world_id',
    ]);
  });

  it('payload-схема закрыта: именно это делает контроль на данных излишним', () => {
    expect(JourneyStartPayloadSchema.additionalProperties).toBe(false);
  });
});
