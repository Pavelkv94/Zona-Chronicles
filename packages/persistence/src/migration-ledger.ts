import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from './database.ts';
import type { Migration } from './migrations/types.ts';

/** Запись журнала миграций, как она хранится в `schema_migrations`. */
export interface AppliedMigrationRecord {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
}

/**
 * Checksum нормализованного SQL-текста миграции (sha256 через `node:crypto`).
 *
 * Источник текста — `migration.statements` (явный, стабильный SQL, который
 * `up` исполняет по порядку), а НЕ `Function.prototype.toString()` кода `up`.
 * Текст функции меняется при смене версии TypeScript/транспайлера/минификатора,
 * поэтому checksum от кода дал бы ложный `MIGRATION_CHECKSUM_MISMATCH` на
 * нетронутой миграции — ложную тревогу целостности на невосполнимом журнале.
 *
 * Правило нормализации одного statement (детерминированное, описано явно,
 * чтобы форматирование текста миграции не считалось изменением содержимого):
 *  1. `\r\n` -> `\n` (перевод строк не зависит от ОС/редактора);
 *  2. с каждой строки убираются хвостовые пробелы/табы;
 *  3. у результата убираются ведущие/хвостовые пустые строки (`trim`).
 * Statements объединяются символом `\n` в порядке объявления в `statements`
 * (порядок значим — это порядок фактического исполнения).
 */
export function computeChecksum(migration: Pick<Migration, 'statements'>): string {
  const normalized = migration.statements.map(normalizeStatement).join('\n');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function normalizeStatement(statement: string): string {
  return statement
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/**
 * Журнал миграций (`schema_migrations`) создаётся самой первой миграцией (`0001_bootstrap`),
 * поэтому до её применения таблицы не существует — это не ошибка, а пустой журнал.
 */
export async function migrationLedgerExists(db: Kysely<Database>): Promise<boolean> {
  const result = await sql<{ table_exists: boolean }>`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = current_schema()
        and table_name = 'schema_migrations'
    ) as table_exists
  `.execute(db);
  return result.rows[0]?.table_exists ?? false;
}

export async function loadAppliedMigrations(
  db: Kysely<Database>,
): Promise<AppliedMigrationRecord[]> {
  if (!(await migrationLedgerExists(db))) {
    return [];
  }
  const rows = await db.selectFrom('schema_migrations').selectAll().orderBy('id', 'asc').execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    durationMs: row.duration_ms,
  }));
}

export async function recordAppliedMigration(
  db: Kysely<Database>,
  record: AppliedMigrationRecord,
): Promise<void> {
  await db
    .insertInto('schema_migrations')
    .values({
      id: record.id,
      name: record.name,
      checksum: record.checksum,
      applied_at: record.appliedAt,
      duration_ms: record.durationMs,
    })
    .execute();
}
