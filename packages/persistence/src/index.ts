/** @zona/persistence — Kysely-подключение, migration runner, репозитории и транзакционный
 *  command handler (I00/I02A). */

export type { Migration, MigrationPhase } from './migrations/types.ts';
export { migrations } from './migrations/index.ts';

export type {
  AgentsTable,
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
export { createDatabase, parseDatabaseConnectionUrl, requireSafeInteger } from './database.ts';

export type { WorldContent, WorldInitialization, WorldMeta } from './world-repository.ts';
export { initializeWorld, loadWorldMeta, loadWorldState } from './world-repository.ts';

export type {
  CommandAccepted,
  CommandExecution,
  CommandRejected,
  ExecuteCommandOptions,
  TransactionStep,
} from './command-handler.ts';
export { TRANSACTION_STEPS, executeCommand } from './command-handler.ts';

export { LOCAL_DEV_ROLE_PASSWORD, ROLE_NAMES } from './migrations/0003-roles-and-grants.ts';

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
