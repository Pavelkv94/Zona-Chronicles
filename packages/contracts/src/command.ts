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

/** Типы команд первого slice (§11). Расширяется только вместе с итерацией из §12. */
export const COMMAND_TYPES = ['journey.start'] as const;

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

export const CommandSchema = Type.Object(
  {
    command_id: RuntimeIdSchema(
      RUNTIME_ID_PREFIXES.command,
      'Уникальный id команды; одновременно idempotency key на границе приложения (§1).',
    ),
    world_id: NamespacedIdSchema,
    type: Type.Union(
      COMMAND_TYPES.map((type) => Type.Literal(type)),
      { description: 'Тип команды из первого contract slice.' },
    ),
    schema_version: SchemaVersionSchema,
    actor_id: Type.Unsafe<string>({
      ...NamespacedIdSchema,
      description: 'Инициатор; системные команды используют явного актора вида system:* (§2).',
    }),
    issued_at_world_time: InstantSchema,
    expected_world_version: WorldVersionSchema,
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
    payload: JourneyStartPayloadSchema,
  },
  {
    $id: 'zona:command/1',
    additionalProperties: false,
    description: 'Command envelope v1 (09_EVENT_AND_COMMAND_CONTRACTS §2).',
  },
);

export type Command = Static<typeof CommandSchema>;

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

  const issues = schemaIssues(CommandSchema, input);
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
