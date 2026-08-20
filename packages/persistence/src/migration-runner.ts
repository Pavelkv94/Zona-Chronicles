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

/**
 * Destructive `contract` не может ехать в одном прогоне (той же поставке) с
 * `expand` — иначе новый reader/writer из `expand` и слом старого контракта
 * из `contract` попадают в один release, что запрещено §12 03_TECHNICAL_DESIGN.md
 * и stop condition роли `persistence-implementer`.
 */
export class MigrationPhaseConflictError extends Error {
  readonly code = 'MIGRATION_PHASE_CONFLICT';
  readonly expandIds: readonly string[];
  readonly contractIds: readonly string[];

  constructor(expandIds: readonly string[], contractIds: readonly string[]) {
    super(
      `MIGRATION_PHASE_CONFLICT: в одном прогоне присутствуют expand-миграции ` +
        `(${expandIds.join(', ')}) и contract-миграции (${contractIds.join(', ')}). ` +
        `Destructive contract нельзя выпускать вместе с первым новым reader/writer — ` +
        `разнесите их по разным поставкам.`,
    );
    this.name = 'MigrationPhaseConflictError';
    this.expandIds = expandIds;
    this.contractIds = contractIds;
  }
}

export class MigrationLockTimeoutError extends Error {
  readonly code = 'MIGRATION_LOCK_TIMEOUT';
  readonly advisoryLockKey: number;
  readonly attempts: number;

  constructor(advisoryLockKey: number, attempts: number, retryDelayMs: number) {
    super(
      `MIGRATION_LOCK_TIMEOUT: не удалось захватить advisory lock ${advisoryLockKey} за ${attempts} ` +
        `попыток с интервалом ${retryDelayMs}мс — lock, вероятно, держит другой процесс. ` +
        `Runner не ждёт lock бесконечно, чтобы зависшая миграция была видна как явная ошибка, а не тихий hang.`,
    );
    this.name = 'MigrationLockTimeoutError';
    this.advisoryLockKey = advisoryLockKey;
    this.attempts = attempts;
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
 * Проверяет только миграции, которые реально будут применены в этом прогоне
 * (уже применённые — не "та же поставка"). `contract` вместе с `expand` в
 * одной поставке запрещён; `backfill` может соседствовать с обоими.
 */
function validatePhaseBatch(pending: readonly Migration[]): void {
  const expandIds = pending.filter((m) => m.phase === 'expand').map((m) => m.id);
  const contractIds = pending.filter((m) => m.phase === 'contract').map((m) => m.id);
  if (expandIds.length > 0 && contractIds.length > 0) {
    throw new MigrationPhaseConflictError(expandIds, contractIds);
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

    // Фаза-конфликт (expand + contract в одной поставке) — до применения чего-либо.
    validatePhaseBatch(migrations.filter((migration) => !appliedById.has(migration.id)));

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

/**
 * `lock_timeout` соединения миграции: ограничивает, сколько DDL-statement
 * внутри `applyMigration` может ждать конфликтующую heavyweight-блокировку
 * (например, чужую транзакцию, держащую lock на таблице). 5с — миграции I00
 * тривиальны (create extension/table на пустой БД), поэтому реального
 * ожидания нет; значение — это explicit budget на будущее, а не измеренная
 * величина, и переопределяется поставкой в I02A под конкретную DDL-операцию.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/**
 * `statement_timeout` соединения миграции: верхняя граница на выполнение
 * одного SQL statement из `migration.statements`. 30с — с запасом покрывает baseline
 * (create extension/table) и оставляет диагностируемую границу вместо
 * бесконечного зависания; доменные миграции I02A с большими backfill
 * обязаны передавать больший явный `statementTimeoutMs`.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Число попыток `pg_try_advisory_lock` перед `MigrationLockTimeoutError`.
 * Вместе с `DEFAULT_ADVISORY_LOCK_RETRY_DELAY_MS` (1с) даёт суммарный budget
 * ожидания ~5с — этого достаточно, чтобы пережить гонку двух одновременно
 * стартующих deploy-процессов, но не зависнуть молча, если lock держит
 * зависший процесс.
 */
export const DEFAULT_ADVISORY_LOCK_ATTEMPTS = 5;
export const DEFAULT_ADVISORY_LOCK_RETRY_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PostgresExecutorTimeouts {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly advisoryLockAttempts: number;
  readonly advisoryLockRetryDelayMs: number;
}

function createPostgresMigrationExecutor(
  connection: Kysely<Database>,
  advisoryLockKey: number,
  now: () => Date,
  timeouts: PostgresExecutorTimeouts,
): MigrationExecutor {
  return {
    async withAdvisoryLock(run) {
      // `set_config(..., false)` — по значению аргумента-параметра (не через
      // interpolation в SET), персистентно на сессию (не только на текущую
      // транзакцию), потому что весь runner держит один физический connection.
      await sql`select set_config('lock_timeout', ${`${timeouts.lockTimeoutMs}ms`}, false)`.execute(
        connection,
      );
      await sql`select set_config('statement_timeout', ${`${timeouts.statementTimeoutMs}ms`}, false)`.execute(
        connection,
      );

      // `pg_try_advisory_lock` не блокирует — сами делаем ограниченный retry
      // с интервалом, вместо бесконечного ожидания `pg_advisory_lock`, чтобы
      // занятый lock был диагностируемой ошибкой, а не тихим hang.
      let acquired = false;
      for (let attempt = 1; attempt <= timeouts.advisoryLockAttempts; attempt += 1) {
        const result = await sql<{
          locked: boolean;
        }>`select pg_try_advisory_lock(${advisoryLockKey}) as locked`.execute(connection);
        if (result.rows[0]?.locked === true) {
          acquired = true;
          break;
        }
        if (attempt < timeouts.advisoryLockAttempts) {
          await delay(timeouts.advisoryLockRetryDelayMs);
        }
      }
      if (!acquired) {
        throw new MigrationLockTimeoutError(
          advisoryLockKey,
          timeouts.advisoryLockAttempts,
          timeouts.advisoryLockRetryDelayMs,
        );
      }

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
        // Единственный канал исполнения: `statements` по порядку объявления —
        // это ровно то, от чего считается checksum (см. `migrations/types.ts`,
        // N3 I00-F2). У `Migration` намеренно нет `up(db)`, поэтому здесь
        // нечего вызывать, кроме этого цикла.
        for (const statement of migration.statements) {
          await sql.raw(statement).execute(trx);
        }
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
  /** `lock_timeout` соединения миграции, мс. По умолчанию {@link DEFAULT_LOCK_TIMEOUT_MS}. */
  readonly lockTimeoutMs?: number;
  /** `statement_timeout` соединения миграции, мс. По умолчанию {@link DEFAULT_STATEMENT_TIMEOUT_MS}. */
  readonly statementTimeoutMs?: number;
  /** Число попыток `pg_try_advisory_lock`. По умолчанию {@link DEFAULT_ADVISORY_LOCK_ATTEMPTS}. */
  readonly advisoryLockAttempts?: number;
  /** Интервал между попытками, мс. По умолчанию {@link DEFAULT_ADVISORY_LOCK_RETRY_DELAY_MS}. */
  readonly advisoryLockRetryDelayMs?: number;
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
  const timeouts: PostgresExecutorTimeouts = {
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    advisoryLockAttempts: options.advisoryLockAttempts ?? DEFAULT_ADVISORY_LOCK_ATTEMPTS,
    advisoryLockRetryDelayMs:
      options.advisoryLockRetryDelayMs ?? DEFAULT_ADVISORY_LOCK_RETRY_DELAY_MS,
  };

  return options.db.connection().execute(async (connection) => {
    const executor = createPostgresMigrationExecutor(connection, advisoryLockKey, now, timeouts);
    return applyMigrations(executor, options.migrations, options.logger);
  });
}
