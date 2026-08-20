/** @zona/persistence — Kysely-подключение, migration runner и репозитории (I00/I02A). */

export type { Migration, MigrationPhase } from './migrations/types.ts';
export { migrations } from './migrations/index.ts';

export type { Database, DatabaseConnectionConfig, SchemaMigrationsTable } from './database.ts';
export { createDatabase } from './database.ts';

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
