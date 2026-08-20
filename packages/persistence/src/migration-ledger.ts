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
 * Checksum нормализованного тела миграции (sha256 через `node:crypto`).
 *
 * Контракт миграции — только `{ id, name, up }` (без отдельного текстового поля),
 * поэтому источником текста служит исходный код функции `up` (`Function.prototype.toString`),
 * нормализованный схлопыванием пробельных символов, чтобы форматирование не считалось
 * изменением содержимого.
 */
export function computeChecksum(migration: Pick<Migration, 'up'>): string {
  const normalized = migration.up.toString().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
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
