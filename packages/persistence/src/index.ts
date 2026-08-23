/** @zona/persistence — Kysely-подключение, migration runner, репозитории и транзакционный
 *  command handler (I00/I02A). */

export type { Migration, MigrationPhase } from './migrations/types.ts';
export { migrations } from './migrations/index.ts';

export type {
  AgentsTable,
  CommandAttemptRejectionsTable,
  CommandResultsTable,
  Database,
  DatabaseConnection,
  DatabaseConnectionConfig,
  LocationsTable,
  OutboxTable,
  RoutesTable,
  SchemaMigrationsTable,
  WorldEventsTable,
  WorldsTable,
} from './database.ts';
export {
  createDatabase,
  parseDatabaseConnectionUrl,
  redactConnectionUrl,
  requireSafeInteger,
} from './database.ts';

export type {
  WorldContent,
  WorldContentSnapshot,
  WorldInitialization,
  WorldMeta,
} from './world-repository.ts';
export {
  initializeWorld,
  loadWorldEvents,
  loadWorldMeta,
  loadWorldState,
  loadOutboxEventsAfter,
  loadWorldContent,
  loadWorldsWithEmptyPrngPositions,
  repairWorldPrngPositions,
} from './world-repository.ts';

/**
 * Из handler-а наружу выходит только то, что нужно ПОТРЕБИТЕЛЮ пакета: сама команда и форма
 * её результата.
 *
 * `TRANSACTION_STEPS`/`ACCEPTED_PATH_STEPS`/`REJECTED_PATH_STEPS` и `ExecuteCommandOptions`
 * (в котором живёт `afterStep`) намеренно НЕ экспортируются: `afterStep` — шов для инъекции
 * сбоя, то есть возможность выполнить произвольный код внутри канонической транзакции. В
 * публичном API пакета такому шву не место — его единственный законный потребитель это
 * интеграционные тесты, лежащие в этом же пакете и импортирующие `./command-handler.ts`
 * напрямую (finding m-1 независимого архитектурного аудита).
 */
export type { CommandAccepted, CommandExecution, CommandRejected } from './command-handler.ts';
export { commandFingerprint, eventIdOriginKey, executeCommand } from './command-handler.ts';

export type { ReplayResult } from './replay.ts';
export { replayFromSnapshot, replayWorld } from './replay.ts';

export type { LoadSnapshotContext, SnapshotContent } from './snapshot-store.ts';
export {
  UnqualifiedRuntimeProfileError,
  loadLatestSnapshot,
  loadSnapshotAt,
  writeSnapshot,
} from './snapshot-store.ts';

export type { PersistentRandomSourceOptions } from './prng-positions.ts';
export { PersistentRandomSource } from './prng-positions.ts';

export type { ClaimedAction, ClaimOptions, TickOptions, TickResult } from './scheduler.ts';
export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_LEASE_MS,
  claimDueActions,
  runWorldTick,
} from './scheduler.ts';

export type { EnsureRolesResult, RoleName } from './principals.ts';
export {
  APPLICATION_ROLES,
  GRANT_MATRIX,
  ROLE_NAMES,
  applyGrants,
  ensureApplicationRoles,
} from './principals.ts';

export type { AppliedMigrationRecord } from './migration-ledger.ts';
export { computeChecksum } from './migration-ledger.ts';

export type {
  AppliedMigrationReport,
  Logger,
  MigrationExecutor,
  MigrationRunReport,
  RunMigrationsOptions,
  SkippedMigrationReport,
} from './migration-runner.ts';
export {
  applyMigrations,
  DEFAULT_ADVISORY_LOCK_ATTEMPTS,
  DEFAULT_ADVISORY_LOCK_KEY,
  DEFAULT_ADVISORY_LOCK_RETRY_DELAY_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  MigrationChecksumMismatchError,
  MigrationLockTimeoutError,
  MigrationNameMismatchError,
  MigrationOrderInvalidError,
  MigrationPhaseConflictError,
  runMigrations,
} from './migration-runner.ts';

export const PACKAGE_NAME = '@zona/persistence' as const;
