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
} from './instant.ts';

export { type ItemKind, ITEM_KINDS, ItemKindSchema } from './item.ts';

export {
  type NeedKind,
  type NeedLevel,
  NEED_KINDS,
  NEED_LEVELS,
  NeedKindSchema,
  NeedLevelSchema,
  needLevelRank,
} from './need.ts';

export {
  CANONICAL_INSTANT_PATTERN,
  addMinutes,
  formatCanonicalInstant,
  isCanonicalInstant,
  parseCanonicalInstant,
  requireAddMinutes,
} from './canonical-instant.ts';

export {
  type NumericError,
  type NumericRoundingMode,
  type NumericUnit,
  DRAW_COUNT_UNIT,
  DRAW_INDEX_UNIT,
  MILLISECOND_UNIT,
  NEED_FRACTION_UNIT,
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

export {
  SHA256_MAX_INPUT_BYTES,
  sha256Hex,
  sha256HexOfBytes,
  sha256PaddedLength,
} from './sha256.ts';

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
  ProjectionSequenceSchema,
  SEMANTIC_VERSION_SOURCE,
  SemanticVersionSchema,
  SequenceSchema,
} from './schema-primitives.ts';

export {
  type Command,
  type CommandRejectionCode,
  type CommandType,
  type JourneyCompleteCommand,
  type JourneyStartCommand,
  type NeedThresholdCrossCommand,
  type AgentEatCommand,
  type AgentRestCommand,
  type RestCompleteCommand,
  COMMAND_ENVELOPE_KEYS,
  COMMAND_FINGERPRINT_EXCLUDED_KEYS,
  COMMAND_FINGERPRINT_KEYS,
  COMMAND_REJECTION_CODES,
  COMMAND_TYPES,
  CommandRejectionCodeSchema,
  CommandSchema,
  ENVELOPE_SCHEMA_VERSION,
  JourneyStartPayloadSchema,
  NeedThresholdCrossPayloadSchema,
  AgentEatPayloadSchema,
  AgentRestPayloadSchema,
  RestCompletePayloadSchema,
  commandFingerprintSource,
  decodeCommand,
  encodeCommand,
  isCommand,
} from './command.ts';

export {
  type JourneyCompletedEvent,
  type JourneyStartedEvent,
  type PlanInvalidatedEvent,
  type NeedThresholdCrossedEvent,
  type AgentAteEvent,
  type AgentRestedEvent,
  type RestStartedEvent,
  type RandomAudit,
  type WorldEvent,
  type WorldEventType,
  JourneyCompletedEventSchema,
  JourneyCompletedPayloadSchema,
  JourneyStartedEventSchema,
  JourneyStartedPayloadSchema,
  PlanInvalidatedEventSchema,
  NeedThresholdCrossedEventSchema,
  NeedThresholdCrossedPayloadSchema,
  AgentAtePayloadSchema,
  AgentRestedPayloadSchema,
  RestStartedPayloadSchema,
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
  PUBLIC_SCHEMA_IDS,
  SCHEMA_BUNDLE_VERSION,
  schemaBundleContent,
  schemaBundleRef,
} from './schema-bundle.ts';

export {
  type BundleRef,
  type DeterministicRuntimeProfile,
  type Snapshot,
  BundleRefSchema,
  DeterministicRuntimeProfileSchema,
  decodeDeterministicRuntimeProfile,
  EXACT_MATCH_PROFILE_FIELDS,
  MAJOR_MINOR_PROFILE_FIELDS,
  SNAPSHOT_CHECKSUM_EXCLUDED_FIELDS,
  SNAPSHOT_CHECKSUM_FIELDS,
  CANONICAL_TRANSACTION_ISOLATION_LEVEL,
  SNAPSHOT_CHECKSUM_SCOPE_VERSION,
  SNAPSHOT_SEQUENCE_UNIT,
  SnapshotBundlesSchema,
  SnapshotSchema,
  bundleRefFor,
  decodeSnapshot,
  snapshotChecksum,
  verifyBundleRef,
  verifyRuntimeProfileCompatibility,
  verifySnapshotChecksum,
} from './snapshot.ts';

export {
  type ObserverAgent,
  type ObserverEvent,
  type ObserverMapEdge,
  type ObserverMapNode,
  type ObserverStreamReset,
  type ObserverWorldSnapshot,
  OBSERVER_AGENT_STATUSES,
  OBSERVER_STREAM_EVENT_NAMES,
  ObserverAgentSchema,
  NeedLevelsSchema,
  ObserverEventSchema,
  ObserverMapEdgeSchema,
  ObserverMapNodeSchema,
  ObserverStreamResetSchema,
  ObserverWorldSnapshotSchema,
  decodeObserverEvent,
  decodeObserverWorldSnapshot,
} from './observer.ts';
