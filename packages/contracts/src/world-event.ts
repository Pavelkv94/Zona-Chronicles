/**
 * World event envelope v1 (`09_EVENT_AND_COMMAND_CONTRACTS` §3) и первый contract slice (§11).
 *
 * Событие — уже случившийся факт мира. Оно не содержит художественный текст, UI importance и
 * observer visibility: это разные слои ADR-005, и они принадлежат projections/representations.
 * Схема запрещает такие поля не рекомендацией, а `additionalProperties: false`.
 *
 * Union по `type` дискриминированный и закрытый: добавление типа события без ветки в `evolve`
 * обязано ломать компиляцию потребителя (A8), поэтому `type` — литерал в каждом варианте, а
 * не общая строка с отдельной валидацией.
 */
import { type Static, Type } from '@sinclair/typebox';
import { requireCanonical } from './canonical-json.ts';
import { ENVELOPE_SCHEMA_VERSION } from './command.ts';
import { RUNTIME_ID_PREFIXES } from './identifier.ts';
import {
  DottedNameSchema,
  DrawCountSchema,
  DrawIndexSchema,
  IdSetSchema,
  InstantSchema,
  NamespacedIdSchema,
  RuntimeIdSchema,
  RuntimeIdSetSchema,
  SchemaVersionSchema,
  SemanticVersionSchema,
  SequenceSchema,
} from './schema-primitives.ts';
import {
  type ValidationIssue,
  type ValidationResult,
  failure,
  idSetIsSorted,
  isRecord,
  isValidationIssue,
  normalizeInstantField,
  schemaIssues,
} from './validation.ts';

/** Типы событий первого slice (§11). Расширяется только итерацией из §12. */
export const WORLD_EVENT_TYPES = [
  'journey.started',
  'journey.completed',
  'plan.invalidated',
] as const;

export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number];

/** Поля envelope события: список нужен для проверки §4 «payload не дублирует envelope». */
export const WORLD_EVENT_ENVELOPE_KEYS = [
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
  'location_id',
  'correlation_id',
  'causation_id',
  'caused_by',
  'command_id',
  'random_audit',
  'payload',
] as const;

/**
 * Audit случайности (§7): stream key и диапазон использованных draw.
 *
 * `rules_version` сюда НЕ входит, хотя §7 перечисляет её среди audit-полей: она уже есть в
 * envelope, а §4 запрещает дублировать поля envelope. Второй экземпляр того же значения — это
 * второй источник истины, который однажды разойдётся с первым.
 */
export const RandomAuditSchema = Type.Object(
  {
    stream_key: Type.Unsafe<string>({
      ...NamespacedIdSchema,
      description: 'Стабильный ключ потока: мир, агент, сцена или система (§7).',
    }),
    first_draw_index: DrawIndexSchema,
    draw_count: DrawCountSchema,
  },
  {
    additionalProperties: false,
    description: 'Метаданные использованной случайности; null, если outcome её не использовал.',
  },
);

/** Поля, общие для всех событий. `type` и `payload` добавляет конкретный вариант. */
const envelopeFields = {
  event_id: RuntimeIdSchema(RUNTIME_ID_PREFIXES.event, 'Глобальный id события (§1).'),
  world_id: NamespacedIdSchema,
  sequence: SequenceSchema,
  world_time: Type.Unsafe<string>({
    ...InstantSchema,
    description: 'Время факта внутри мира (§3).',
  }),
  recorded_at: Type.Unsafe<string>({
    ...InstantSchema,
    description: 'Операционный wall clock; не участвует в доменной логике и replay (§3).',
  }),
  schema_version: SchemaVersionSchema,
  rules_version: SemanticVersionSchema,
  content_version: SemanticVersionSchema,
  actor_ids: IdSetSchema('Акторы факта; множество, отсортированное по возрастанию.'),
  subject_ids: IdSetSchema('Субъекты факта; множество, отсортированное по возрастанию.'),
  location_id: Type.Optional(NamespacedIdSchema),
  correlation_id: RuntimeIdSchema(
    RUNTIME_ID_PREFIXES.correlation,
    'Весь workflow/scene/plan (§3).',
  ),
  causation_id: Type.Optional(
    RuntimeIdSchema(RUNTIME_ID_PREFIXES.event, 'Непосредственное событие-триггер (§3).'),
  ),
  caused_by: RuntimeIdSetSchema(
    RUNTIME_ID_PREFIXES.event,
    'Дополнительные причинные рёбра для летописи; множество, отсортированное по возрастанию.',
  ),
  command_id: Type.Optional(
    RuntimeIdSchema(
      RUNTIME_ID_PREFIXES.command,
      'Идемпотентный источник, если факт создан командой.',
    ),
  ),
  random_audit: Type.Union([RandomAuditSchema, Type.Null()], {
    description: 'Метаданные случайности либо null, если outcome её не использовал (§3).',
  }),
} as const;

/** `journey.started`: агент вышел на маршрут (§3). */
export const JourneyStartedPayloadSchema = Type.Object(
  {
    route_id: NamespacedIdSchema,
    expected_arrival: InstantSchema,
  },
  { additionalProperties: false, description: 'Маршрут и ожидаемый момент прибытия.' },
);

/**
 * `journey.completed`: агент дошёл (§11).
 *
 * Момента прибытия в payload нет намеренно: он и есть `world_time` события, а §4 запрещает
 * дублировать поля envelope в payload.
 */
export const JourneyCompletedPayloadSchema = Type.Object(
  {
    route_id: NamespacedIdSchema,
  },
  { additionalProperties: false, description: 'Пройденный маршрут.' },
);

/**
 * `plan.invalidated`: перед шагом плана не выполнилось предусловие
 * (`07_MVP_MECHANICS_SPEC` §6), после чего агент перепланирует действие.
 */
export const PlanInvalidatedPayloadSchema = Type.Object(
  {
    plan_id: NamespacedIdSchema,
    precondition_type: Type.Unsafe<string>({
      ...DottedNameSchema,
      description: 'Тип невыполненного предусловия, например agent.is_on_route (§6).',
    }),
  },
  { additionalProperties: false, description: 'План и невыполненное предусловие.' },
);

const PAYLOAD_SCHEMAS = {
  'journey.started': JourneyStartedPayloadSchema,
  'journey.completed': JourneyCompletedPayloadSchema,
  'plan.invalidated': PlanInvalidatedPayloadSchema,
} as const;

/** Моменты внутри payload, которые декодер обязан привести к канонической форме. */
const PAYLOAD_INSTANT_FIELDS: Readonly<Record<WorldEventType, readonly string[]>> = {
  'journey.started': ['expected_arrival'],
  'journey.completed': [],
  'plan.invalidated': [],
};

function eventVariant<T extends WorldEventType>(type: T) {
  return Type.Object(
    {
      ...envelopeFields,
      type: Type.Literal(type),
      payload: PAYLOAD_SCHEMAS[type],
    },
    {
      $id: `zona:world-event/${type}/1`,
      additionalProperties: false,
      description: `World event ${type} v1.`,
    },
  );
}

export const JourneyStartedEventSchema = eventVariant('journey.started');
export const JourneyCompletedEventSchema = eventVariant('journey.completed');
export const PlanInvalidatedEventSchema = eventVariant('plan.invalidated');

const VARIANT_SCHEMAS = {
  'journey.started': JourneyStartedEventSchema,
  'journey.completed': JourneyCompletedEventSchema,
  'plan.invalidated': PlanInvalidatedEventSchema,
} as const;

export const WorldEventSchema = Type.Union(
  [JourneyStartedEventSchema, JourneyCompletedEventSchema, PlanInvalidatedEventSchema],
  {
    $id: 'zona:world-event/1',
    description: 'World event envelope v1, дискриминированный по type (§3, §11).',
  },
);

/** Метаданные использованной случайности; `null` в событии означает «случайность не использовалась». */
export type RandomAudit = Static<typeof RandomAuditSchema>;

export type JourneyStartedEvent = Static<typeof JourneyStartedEventSchema>;
export type JourneyCompletedEvent = Static<typeof JourneyCompletedEventSchema>;
export type PlanInvalidatedEvent = Static<typeof PlanInvalidatedEventSchema>;

/**
 * Закрытый union canonical events v1.
 *
 * Он объявлен перечислением вариантов, а не `Static<typeof WorldEventSchema>`, потому что
 * именно перечисление даёт компилятору дискриминатор: `switch (event.type)` без одной ветки
 * не сужается до `never`, и `assertNeverWorldEvent` перестаёт компилироваться (A8).
 */
export type WorldEvent = JourneyStartedEvent | JourneyCompletedEvent | PlanInvalidatedEvent;

/**
 * Исчерпывающая проверка типов событий. Аргумент типа `never` означает «сюда невозможно
 * попасть, если обработаны все варианты»; добавление типа события ломает компиляцию каждого
 * потребителя, который его не обработал (A8).
 *
 * Runtime-ветка тоже нужна: событие могло прийти из журнала, записанного более новой версией
 * кода. Тогда это громкий отказ, а не молчаливое `undefined`.
 */
export function assertNeverWorldEvent(event: never): never {
  throw new Error(
    `необработанный тип события: ${JSON.stringify((event as { type?: unknown }).type)}`,
  );
}

/** Валидирует и нормализует событие; возвращает типизированные ошибки с путём (A4). */
export function decodeWorldEvent(input: unknown): ValidationResult<WorldEvent> {
  if (!isRecord(input)) {
    return failure('', 'world event envelope обязан быть объектом');
  }

  const discriminator = checkDiscriminator(input);
  if (discriminator !== null) {
    return { errors: [discriminator] };
  }

  const type = input['type'] as WorldEventType;
  const issues = detailRandomAudit(schemaIssues(VARIANT_SCHEMAS[type], input), input);
  if (issues.length > 0) {
    return { errors: issues };
  }

  const event = input as unknown as WorldEvent;
  const payload = (event as { payload: Record<string, unknown> }).payload;

  const invariantIssues: ValidationIssue[] = [
    ...idSetIsSorted('/actor_ids', event.actor_ids),
    ...idSetIsSorted('/subject_ids', event.subject_ids),
    ...idSetIsSorted('/caused_by', event.caused_by),
  ];

  const normalizedPayload: Record<string, unknown> = { ...payload };
  const normalized: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>) };

  for (const field of ['world_time', 'recorded_at'] as const) {
    const result = normalizeInstantField(`/${field}`, event[field]);
    if (isValidationIssue(result)) {
      invariantIssues.push(result);
    } else {
      normalized[field] = result.iso;
    }
  }

  for (const field of PAYLOAD_INSTANT_FIELDS[type]) {
    const result = normalizeInstantField(`/payload/${field}`, payload[field] as string);
    if (isValidationIssue(result)) {
      invariantIssues.push(result);
    } else {
      normalizedPayload[field] = result.iso;
    }
  }

  if (invariantIssues.length > 0) {
    return { errors: invariantIssues };
  }

  normalized['payload'] = normalizedPayload;
  return { value: normalized as unknown as WorldEvent };
}

/** Каноническая сериализация события: один и тот же текст на любой машине (SIM-01). */
export function encodeWorldEvent(event: WorldEvent): string {
  return requireCanonical(event, `world event ${event.type}`);
}

/**
 * Раскрывает отказ union `RandomAudit | null`.
 *
 * TypeBox для union сообщает только «Expected union value» и теряет причину: лишнее поле
 * `rules_version` внутри `random_audit` неотличимо от неверного `draw_count`. A4 требует
 * ТИПИЗИРОВАННОЙ ошибки, а не факта отказа, поэтому нарушение перепроверяется по схеме
 * варианта — единственного, который вообще мог подойти для не-null значения.
 */
function detailRandomAudit(
  issues: readonly ValidationIssue[],
  input: Record<string, unknown>,
): ValidationIssue[] {
  const audit = input['random_audit'];
  if (!isRecord(audit)) {
    return [...issues];
  }
  return issues.flatMap((issue) => {
    if (issue.path !== '/random_audit') {
      return [issue];
    }
    const detailed = schemaIssues(RandomAuditSchema, audit).map((inner) => ({
      path: `/random_audit${inner.path}`,
      message: inner.message,
    }));
    return detailed.length > 0 ? detailed : [issue];
  });
}

function checkDiscriminator(input: Record<string, unknown>): ValidationIssue | null {
  const { type, schema_version: schemaVersion } = input;

  if (typeof type !== 'string' || !(WORLD_EVENT_TYPES as readonly string[]).includes(type)) {
    return {
      path: '/type',
      message:
        `неизвестный тип события ${JSON.stringify(type)}; ` +
        `первый contract slice содержит только ${WORLD_EVENT_TYPES.join(', ')} (§11)`,
    };
  }

  if (schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
    return {
      path: '/schema_version',
      message:
        `неподдерживаемая мажорная версия схемы ${JSON.stringify(schemaVersion)}; ` +
        `этот контракт читает версию ${ENVELOPE_SCHEMA_VERSION}, для другой нужен upcaster (§4)`,
    };
  }

  return null;
}
