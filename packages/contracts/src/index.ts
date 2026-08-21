/**
 * Публичные контракты мира. Пакет — leaf: не импортирует внутренние пакеты приложения
 * (ADR-002).
 *
 * Состав v1 (I01, contract freeze):
 *
 * - момент времени: общий строгий разбор (`instant`) и каноническая форма мира
 *   (`canonical-instant`);
 * - единицы измерения, диапазоны и округление (`numeric`) — A5;
 * - canonical serialization v1 и checksum (`canonical-json`, `sha256`, `checksum`) — A3;
 * - идентификаторы (`identifier`) — §1;
 * - command envelope и world event envelope с runtime-валидацией (`command`, `world-event`) — A4;
 * - snapshot и immutable bundles по версии и checksum (`snapshot`) — A9.
 *
 * Первый contract slice ограничен §11: `journey.start`, `journey.started`,
 * `journey.completed`, `plan.invalidated`. §12 прямо запрещает реализовывать схемы будущих
 * slices заранее.
 */
export {
  type Instant,
  type InstantError,
  isInstantError,
  STRICT_ISO_8601_INSTANT_PATTERN,
  parseInstant,
  requireInstant,
  compareInstants,
  addMinutes,
} from './instant.ts';

export {
  CANONICAL_INSTANT_PATTERN,
  formatCanonicalInstant,
  isCanonicalInstant,
  parseCanonicalInstant,
} from './canonical-instant.ts';

export {
  type NumericError,
  type NumericRoundingMode,
  type NumericUnit,
  DRAW_COUNT_UNIT,
  DRAW_INDEX_UNIT,
  MILLISECOND_UNIT,
  NUMERIC_ROUNDING_MODES,
  SCHEMA_VERSION_UNIT,
  SEQUENCE_UNIT,
  WORLD_VERSION_UNIT,
  checkMinorUnits,
  defineNumericUnit,
  formatMinorUnits,
  isNumericError,
  parseDecimalMinorUnits,
  roundToMinorUnits,
} from './numeric.ts';

export {
  type CanonicalJson,
  type CanonicalizationError,
  type CanonicalizationResult,
  CANONICAL_SERIALIZATION_VERSION,
  canonicalize,
  compareByCodePoint,
  isCanonicalizationError,
  requireCanonical,
} from './canonical-json.ts';

export { SHA256_MAX_INPUT_BYTES, sha256Hex, sha256HexOfBytes } from './sha256.ts';

export {
  type CanonicalChecksum,
  type ChecksumResult,
  CHECKSUM_ALGORITHM,
  CHECKSUM_PATTERN,
  canonicalChecksum,
  isChecksum,
  requireChecksum,
} from './checksum.ts';

export {
  type RuntimeIdPrefix,
  NAMESPACED_ID_PATTERN,
  NAMESPACED_ID_SOURCE,
  RUNTIME_ID_PATTERN,
  RUNTIME_ID_PREFIXES,
  ULID_ALPHABET,
  ULID_BODY_LENGTH,
  isNamespacedId,
  isRuntimeId,
  namespaceOf,
} from './identifier.ts';

export {
  type ValidationFailure,
  type ValidationIssue,
  type ValidationResult,
  type ValidationSuccess,
  isValidationFailure,
  payloadSchemaShadowedKeys,
} from './validation.ts';

export {
  ChecksumSchema,
  DOTTED_NAME_SOURCE,
  DottedNameSchema,
  InstantSchema,
  NamespacedIdSchema,
  SEMANTIC_VERSION_SOURCE,
  SemanticVersionSchema,
  SequenceSchema,
} from './schema-primitives.ts';

export {
  type Command,
  type CommandRejectionCode,
  type CommandType,
  COMMAND_ENVELOPE_KEYS,
  COMMAND_REJECTION_CODES,
  COMMAND_TYPES,
  CommandRejectionCodeSchema,
  CommandSchema,
  ENVELOPE_SCHEMA_VERSION,
  JourneyStartPayloadSchema,
  decodeCommand,
  encodeCommand,
  isCommand,
} from './command.ts';

export {
  type JourneyCompletedEvent,
  type JourneyStartedEvent,
  type PlanInvalidatedEvent,
  type RandomAudit,
  type WorldEvent,
  type WorldEventType,
  JourneyCompletedEventSchema,
  JourneyCompletedPayloadSchema,
  JourneyStartedEventSchema,
  JourneyStartedPayloadSchema,
  PlanInvalidatedEventSchema,
  PlanInvalidatedPayloadSchema,
  RandomAuditSchema,
  WORLD_EVENT_ENVELOPE_KEYS,
  WORLD_EVENT_TYPES,
  WorldEventSchema,
  assertNeverWorldEvent,
  decodeWorldEvent,
  encodeWorldEvent,
} from './world-event.ts';

export {
  type BundleRef,
  type Snapshot,
  BundleRefSchema,
  DeterministicRuntimeProfileSchema,
  SNAPSHOT_SEQUENCE_UNIT,
  SnapshotBundlesSchema,
  SnapshotSchema,
  bundleRefFor,
  decodeSnapshot,
  snapshotChecksum,
  verifyBundleRef,
  verifySnapshotChecksum,
} from './snapshot.ts';
