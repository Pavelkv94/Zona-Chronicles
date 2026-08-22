/**
 * Command envelope v1 (`09_EVENT_AND_COMMAND_CONTRACTS` §2) и первый contract slice (§11).
 *
 * Команда выражает НАМЕРЕНИЕ, а не факт. Она не является событием, не переписывает мир и не
 * гарантирует результат: handler отвечает `accepted(events)` либо typed rejection, и оба
 * результата одинаково сохраняются в command journal ради идемпотентности.
 *
 * §12 прямо запрещает реализовывать схемы будущих slices заранее, поэтому здесь ровно один
 * тип команды — `journey.start`.
 */
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { canonicalize, isCanonicalizationError, requireCanonical } from './canonical-json.ts';
import { RUNTIME_ID_PREFIXES } from './identifier.ts';
import {
  InstantSchema,
  NamespacedIdSchema,
  RuntimeIdSchema,
  SchemaVersionSchema,
  WorldVersionSchema,
} from './schema-primitives.ts';
import {
  type ValidationIssue,
  type ValidationResult,
  failure,
  isRecord,
  isValidationIssue,
  normalizeInstantField,
  schemaIssues,
} from './validation.ts';

/** Мажорная версия envelope. Чужая мажорная версия требует upcaster (§4), а не догадок. */
export const ENVELOPE_SCHEMA_VERSION = 1;

/**
 * Типы команд. Расширяется только вместе с итерацией, которая их вводит (§12).
 *
 * `journey.complete` добавлен в I02B: завершение пути — это НАМЕРЕНИЕ, которое формирует
 * scheduler по наступившему due action, и оно обязано пройти тот же путь, что внешняя команда
 * (`03_TECHNICAL_DESIGN` §5, шаг 4: «сформировать допустимые команды и вызвать чистый domain
 * handler»). Отдельная ветка «домен для scheduled actions» дала бы второй способ менять мир —
 * с собственными правилами, собственной идемпотентностью и собственными отказами.
 */
export const COMMAND_TYPES = ['journey.start', 'journey.complete'] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

/** Минимальный набор rejection codes из §2. Технические сбои сюда не относятся. */
export const COMMAND_REJECTION_CODES = [
  'invalid_schema',
  'stale_world_version',
  'actor_not_actionable',
  'precondition_failed',
  'resource_unavailable',
  'route_unavailable',
  'conflicting_scene',
] as const;

export type CommandRejectionCode = (typeof COMMAND_REJECTION_CODES)[number];

export const CommandRejectionCodeSchema = Type.Union(
  COMMAND_REJECTION_CODES.map((code) => Type.Literal(code)),
  {
    description:
      'Ожидаемый доменный отказ. Ошибка БД или дефект кода не маскируются этими кодами (§2).',
  },
);

/** Поля envelope команды: список нужен для проверки §4 «payload не дублирует envelope». */
export const COMMAND_ENVELOPE_KEYS = [
  'command_id',
  'world_id',
  'type',
  'schema_version',
  'actor_id',
  'issued_at_world_time',
  'expected_world_version',
  'correlation_id',
  'caused_by_event_id',
  'payload',
] as const;

/**
 * Поля, по которым считается ОТПЕЧАТОК команды — то, что делает две команды «одной и той же»
 * для идемпотентности (N-4 повторного архитектурного аудита I02A).
 *
 * Список живёт здесь, а не в персистентности, ровно по той причине, по которой область checksum
 * снимка живёт в контракте: добавленное поле команды обязано заставить принять решение явно, а
 * не тихо попасть или не попасть в сравнение. Контрактный тест требует, чтобы объединение
 * включённых и исключённых полей совпадало с {@link COMMAND_ENVELOPE_KEYS}.
 *
 * Исключения и причины:
 *
 * - `command_id` — по нему строка и ищется, отличаться он не может никогда: включение вхолостую;
 * - `correlation_id` — id трассировки. `decide` его не читает, на смысл команды он не влияет.
 *   Его включение означало бы требование «ретрай обязан побайтово воспроизвести трассировочный
 *   id», из-за которого добросовестный повтор, пересобранный другим клиентом, объявлялся бы
 *   подменой. Такого требования в `09_EVENT_AND_COMMAND_CONTRACTS` нет и быть не должно;
 * - `issued_at_world_time` — отметка НАМЕРЕНИЯ, тоже не читается `decide`. В I02A мировое время
 *   не движется; в I02B будет, и клиент, пересобравший команду позже, не должен получать отказ
 *   вместо идемпотентного повтора.
 *
 * `caused_by_event_id` включён намеренно: это причинность, а не трассировка.
 */
export const COMMAND_FINGERPRINT_KEYS = [
  'world_id',
  'type',
  'schema_version',
  'actor_id',
  'expected_world_version',
  'caused_by_event_id',
  'payload',
] as const satisfies readonly (typeof COMMAND_ENVELOPE_KEYS)[number][];

export const COMMAND_FINGERPRINT_EXCLUDED_KEYS = [
  'command_id',
  'correlation_id',
  'issued_at_world_time',
] as const satisfies readonly (typeof COMMAND_ENVELOPE_KEYS)[number][];

/**
 * Проекция команды на поля отпечатка. Отсутствующие необязательные поля не попадают в объект,
 * поэтому команда без `caused_by_event_id` и команда с ним дают разные отпечатки — как и должно
 * быть: причина у них разная.
 */
export function commandFingerprintSource(command: Command): Record<string, unknown> {
  const source: Record<string, unknown> = {};
  for (const key of COMMAND_FINGERPRINT_KEYS) {
    const value = (command as Record<string, unknown>)[key];
    if (value !== undefined) source[key] = value;
  }
  return source;
}

/** `journey.start`: намерение выйти на маршрут (§2, §11). */
export const JourneyStartPayloadSchema = Type.Object(
  {
    route_id: NamespacedIdSchema,
  },
  {
    additionalProperties: false,
    description: 'Маршрут, на который агент намерен выйти.',
  },
);

/** `journey.complete`: намерение завершить начатый путь (I02B). */
export const JourneyCompletePayloadSchema = Type.Object(
  {
    route_id: NamespacedIdSchema,
  },
  {
    additionalProperties: false,
    description: 'Маршрут, который агент завершает. Проверяется против состояния актора.',
  },
);

const COMMAND_PAYLOAD_SCHEMAS = {
  'journey.start': JourneyStartPayloadSchema,
  'journey.complete': JourneyCompletePayloadSchema,
} as const;

const commandEnvelopeFields = {
  command_id: RuntimeIdSchema(
    RUNTIME_ID_PREFIXES.command,
    'Уникальный id команды; одновременно idempotency key на границе приложения (§1).',
  ),
  world_id: NamespacedIdSchema,
  schema_version: SchemaVersionSchema,
  actor_id: Type.Unsafe<string>({
    ...NamespacedIdSchema,
    description: 'Инициатор; системные команды используют явного актора вида system:* (§2).',
  }),
  issued_at_world_time: InstantSchema,
  /**
   * Optimistic concurrency — только для ВНЕШНЕГО намерения (ADR-011, blocker аудита I02B).
   *
   * У поля две несовместимые роли, и их смешение стоило потерянных journey. Для команды извне
   * (оператор, HTTP API) оно защищает от намерения, собранного по устаревшему прочтению мира.
   *
   * Для команды, ВЫВЕДЕННОЙ ИЗ РАСПИСАНИЯ, защищать нечего: действие породил сам мир, а
   * `executeCommand` берёт замок мира и читает состояние ВНУТРИ транзакции. Там поле активно
   * вредило: оно входит в отпечаток команды, поэтому конкурентный сдвиг версии между чтением и
   * захватом замка делал отказ `stale_world_version` НЕВОССТАНОВИМЫМ — следующая попытка того
   * же действия собирала другую версию, получала `fingerprint-mismatch` и отвергалась вечно.
   * Агент оставался `traveling` навсегда, а в append-only журнале — `journey.started` без
   * завершения. Воспроизведено: шесть агентов с разными `due_at`, три worker-а, трое застряли.
   *
   * Отсутствие поля означает «проверять версию не надо», а не «версия ноль»: сериализацию
   * тогда целиком обеспечивает замок мира.
   */
  expected_world_version: Type.Optional(WorldVersionSchema),
  correlation_id: RuntimeIdSchema(
    RUNTIME_ID_PREFIXES.correlation,
    'Весь workflow/scene/plan, которому принадлежит команда (§3).',
  ),
  caused_by_event_id: Type.Optional(
    RuntimeIdSchema(
      RUNTIME_ID_PREFIXES.event,
      'Событие-причина, если команда порождена фактом мира; отсутствует у внешнего намерения.',
    ),
  ),
} as const;

function commandVariant<T extends CommandType>(type: T) {
  return Type.Object(
    {
      ...commandEnvelopeFields,
      type: Type.Literal(type),
      payload: COMMAND_PAYLOAD_SCHEMAS[type],
    },
    {
      $id: `zona:command/${type}/1`,
      additionalProperties: false,
      description: `Command ${type} v1 (09_EVENT_AND_COMMAND_CONTRACTS §2).`,
    },
  );
}

export const JourneyStartCommandSchema = commandVariant('journey.start');
export const JourneyCompleteCommandSchema = commandVariant('journey.complete');

const COMMAND_VARIANT_SCHEMAS = {
  'journey.start': JourneyStartCommandSchema,
  'journey.complete': JourneyCompleteCommandSchema,
} as const;

export const CommandSchema = Type.Union([JourneyStartCommandSchema, JourneyCompleteCommandSchema], {
  $id: 'zona:command/1',
  description: 'Command envelope v1, дискриминированный по type (§2, §11).',
});

export type JourneyStartCommand = Static<typeof JourneyStartCommandSchema>;
export type JourneyCompleteCommand = Static<typeof JourneyCompleteCommandSchema>;

/**
 * Перечисление вариантов, а не `Static<typeof CommandSchema>` — по тому же доводу, что у
 * `WorldEvent`: `Static` от `Type.Union` «плющит» дискриминированный union, и `payload`
 * перестаёт сужаться по `type`.
 */
export type Command = JourneyStartCommand | JourneyCompleteCommand;

/**
 * Валидирует и нормализует команду. Возвращает типизированные ошибки, а не бросает: отказ
 * по схеме — ожидаемый результат на границе, а не исключительная ситуация (§2).
 */
export function decodeCommand(input: unknown): ValidationResult<Command> {
  if (!isRecord(input)) {
    return failure('', 'command envelope обязан быть объектом');
  }

  const discriminator = checkDiscriminator(input);
  if (discriminator !== null) {
    return { errors: [discriminator] };
  }

  const issues = schemaIssues(COMMAND_VARIANT_SCHEMAS[input['type'] as CommandType], input);
  if (issues.length > 0) {
    return { errors: issues };
  }

  const command = input as unknown as Command;
  const invariantIssues: ValidationIssue[] = [];

  const issuedAt = normalizeInstantField('/issued_at_world_time', command.issued_at_world_time);
  if (isValidationIssue(issuedAt)) {
    invariantIssues.push(issuedAt);
  }

  if (invariantIssues.length > 0) {
    return { errors: invariantIssues };
  }

  return {
    value: { ...command, issued_at_world_time: (issuedAt as { iso: string }).iso },
  };
}

/** Каноническая сериализация команды: тот же текст на любой машине и в любой локали. */
export function encodeCommand(command: Command): string {
  return requireCanonical(command, 'command');
}

/**
 * Отдельные сообщения для «неизвестный тип» и «чужая мажорная версия»: первое означает, что
 * значение вообще не из этого контракта, второе — что нужен upcaster (§4).
 */
function checkDiscriminator(input: Record<string, unknown>): ValidationIssue | null {
  const { type, schema_version: schemaVersion } = input;

  if (typeof type !== 'string' || !(COMMAND_TYPES as readonly string[]).includes(type)) {
    return {
      path: '/type',
      message:
        `неизвестный тип команды ${JSON.stringify(type)}; ` +
        `первый contract slice содержит только ${COMMAND_TYPES.join(', ')} (§11)`,
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

/** Проверка без нормализации — для мест, где значение уже канонично. */
export function isCommand(input: unknown): input is Command {
  return Value.Check(CommandSchema, input) && !isCanonicalizationError(canonicalize(input));
}
