import { sql, type Kysely } from 'kysely';
import type { Database } from './database.ts';
import type { Migration } from './migrations/types.ts';
import {
  computeChecksum,
  loadAppliedMigrations,
  recordAppliedMigration,
  type AppliedMigrationRecord,
} from './migration-ledger.ts';

/** Логгер инъектируется вызывающим кодом — пакет не создаёт свой транспорт. */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AppliedMigrationReport {
  readonly id: string;
  readonly name: string;
  readonly durationMs: number;
}

export interface SkippedMigrationReport {
  readonly id: string;
  readonly name: string;
}

export interface MigrationRunReport {
  readonly applied: AppliedMigrationReport[];
  readonly skipped: SkippedMigrationReport[];
  /** id последней известной применённой миграции (из этого запуска либо из журнала), либо `null`, если журнал пуст. */
  readonly schemaVersion: string | null;
}

/**
 * Порт исполнения, отделяющий оркестрацию (`applyMigrations`) от конкретного драйвера БД.
 * Production-реализация держит один и тот же физический connection на весь advisory lock
 * (`createPostgresMigrationExecutor`); unit-тесты подставляют фейковый executor.
 */
export interface MigrationExecutor {
  withAdvisoryLock<T>(run: () => Promise<T>): Promise<T>;
  loadAppliedMigrations(): Promise<AppliedMigrationRecord[]>;
  applyMigration(migration: Migration, checksum: string): Promise<{ durationMs: number }>;
}

export class MigrationChecksumMismatchError extends Error {
  readonly code = 'MIGRATION_CHECKSUM_MISMATCH';
  readonly migrationId: string;
  readonly recordedChecksum: string;
  readonly currentChecksum: string;

  constructor(migrationId: string, recordedChecksum: string, currentChecksum: string) {
    super(
      `MIGRATION_CHECKSUM_MISMATCH: миграция ${migrationId} применена с checksum ${recordedChecksum}, ` +
        `а текущий текст миграции даёт ${currentChecksum}. Применённую миграцию нельзя редактировать — ` +
        `добавьте новую миграцию вперёд.`,
    );
    this.name = 'MigrationChecksumMismatchError';
    this.migrationId = migrationId;
    this.recordedChecksum = recordedChecksum;
    this.currentChecksum = currentChecksum;
  }
}

export class MigrationNameMismatchError extends Error {
  readonly code = 'MIGRATION_NAME_MISMATCH';
  readonly migrationId: string;
  readonly recordedName: string;
  readonly currentName: string;

  constructor(migrationId: string, recordedName: string, currentName: string) {
    super(
      `MIGRATION_NAME_MISMATCH: миграция ${migrationId} применена под именем "${recordedName}", ` +
        `а в реестре сейчас указано имя "${currentName}". id применённой миграции неизменяем.`,
    );
    this.name = 'MigrationNameMismatchError';
    this.migrationId = migrationId;
    this.recordedName = recordedName;
    this.currentName = currentName;
  }
}

export class MigrationOrderInvalidError extends Error {
  readonly code = 'MIGRATION_ORDER_INVALID';
  readonly detail: string;

  constructor(detail: string) {
    super(`MIGRATION_ORDER_INVALID: ${detail}`);
    this.name = 'MigrationOrderInvalidError';
    this.detail = detail;
  }
}

/** Реестр обязан быть строго возрастающим по `id` без дублей — порядок задаётся объявлением, не сортировкой. */
function validateMigrationRegistry(migrations: readonly Migration[]): void {
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (previous === undefined || current === undefined) continue;
    if (current.id <= previous.id) {
      throw new MigrationOrderInvalidError(
        `реестр не отсортирован по возрастанию id: "${previous.id}" перед "${current.id}"`,
      );
    }
  }
}

/**
 * Чистая оркестрация поверх {@link MigrationExecutor}: не знает о `pg`/`kysely` напрямую,
 * поэтому полностью покрывается unit-тестами с фейковым executor-ом.
 */
export async function applyMigrations(
  executor: MigrationExecutor,
  migrations: readonly Migration[],
  logger: Logger,
): Promise<MigrationRunReport> {
  validateMigrationRegistry(migrations);

  return executor.withAdvisoryLock(async () => {
    const applied = await executor.loadAppliedMigrations();
    const appliedById = new Map(applied.map((record) => [record.id, record] as const));

    // Валидация целостности журнала — до применения любой миграции.
    for (const migration of migrations) {
      const existing = appliedById.get(migration.id);
      if (existing === undefined) continue;
      if (existing.name !== migration.name) {
        throw new MigrationNameMismatchError(migration.id, existing.name, migration.name);
      }
      const checksum = computeChecksum(migration);
      if (existing.checksum !== checksum) {
        throw new MigrationChecksumMismatchError(migration.id, existing.checksum, checksum);
      }
    }

    const appliedReport: AppliedMigrationReport[] = [];
    const skippedReport: SkippedMigrationReport[] = [];
    let schemaVersion: string | null =
      applied.length > 0 ? (applied[applied.length - 1]?.id ?? null) : null;

    for (const migration of migrations) {
      if (appliedById.has(migration.id)) {
        skippedReport.push({ id: migration.id, name: migration.name });
        continue;
      }
      const checksum = computeChecksum(migration);
      logger.info(`применяю миграцию ${migration.id}_${migration.name}`);
      const { durationMs } = await executor.applyMigration(migration, checksum);
      logger.info(`миграция ${migration.id}_${migration.name} применена`, { durationMs });
      appliedReport.push({ id: migration.id, name: migration.name, durationMs });
      schemaVersion = migration.id;
    }

    return { applied: appliedReport, skipped: skippedReport, schemaVersion };
  });
}

/** Фиксированный ключ `pg_advisory_lock`. Один и тот же для всех сред — блокирует конкурентные runner-ы одного мира. */
export const DEFAULT_ADVISORY_LOCK_KEY = 727_384_910;

function createPostgresMigrationExecutor(
  connection: Kysely<Database>,
  advisoryLockKey: number,
  now: () => Date,
): MigrationExecutor {
  return {
    async withAdvisoryLock(run) {
      await sql`select pg_advisory_lock(${advisoryLockKey})`.execute(connection);
      try {
        return await run();
      } finally {
        await sql`select pg_advisory_unlock(${advisoryLockKey})`.execute(connection);
      }
    },
    loadAppliedMigrations: () => loadAppliedMigrations(connection),
    async applyMigration(migration, checksum) {
      return connection.transaction().execute(async (trx) => {
        const start = now();
        await migration.up(trx);
        const durationMs = now().getTime() - start.getTime();
        await recordAppliedMigration(trx, {
          id: migration.id,
          name: migration.name,
          checksum,
          appliedAt: now(),
          durationMs,
        });
        return { durationMs };
      });
    },
  };
}

export interface RunMigrationsOptions {
  readonly db: Kysely<Database>;
  readonly migrations: readonly Migration[];
  readonly logger: Logger;
  /** Источник времени, по умолчанию `() => new Date()`. Инъектируется для детерминированных тестов. */
  readonly now?: () => Date;
  readonly advisoryLockKey?: number;
}

/**
 * Применяет неприменённые миграции в порядке `id`, каждую в отдельной транзакции вместе
 * с записью в журнал. Держит один физический connection (через `db.connection()`) на весь
 * advisory lock, потому что `pg_advisory_lock`/`pg_advisory_unlock` — session-scoped и обязаны
 * выполняться на одном и том же соединении, а не на случайном соединении из пула.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationRunReport> {
  const now = options.now ?? (() => new Date());
  const advisoryLockKey = options.advisoryLockKey ?? DEFAULT_ADVISORY_LOCK_KEY;

  return options.db.connection().execute(async (connection) => {
    const executor = createPostgresMigrationExecutor(connection, advisoryLockKey, now);
    return applyMigrations(executor, options.migrations, options.logger);
  });
}
