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
 * Источник текста — `migration.statements`, и это не произвольный выбор:
 * `Migration` (см. `migrations/types.ts`) не имеет отдельного `up(db)` —
 * `statements` являются единственным, что общий runner фактически исполняет
 * (по порядку, через `sql.raw(...)`), поэтому checksum от `statements`
 * покрывает ровно исполняемый эффект миграции, а не только его часть (N3,
 * I00-F2). Раньше `up` была свободной функцией, и это позволяло изменить
 * исполняемый SQL, не трогая `statements` — integrity check журнала
 * проходил бы молча, хотя эффект миграции изменился.
 * `Function.prototype.toString()` кода как источник checksum тоже был
 * отклонён (в предыдущем раунде review): текст функции меняется при смене
 * версии TypeScript/транспайлера/минификатора, поэтому checksum от кода
 * дал бы ложный `MIGRATION_CHECKSUM_MISMATCH` на нетронутой миграции —
 * ложную тревогу целостности на невосполнимом журнале.
 *
 * С раунда 3 верификации (minor 3) checksum покрывает ещё и `phase`, не только
 * `statements`. `phase` — не исполняемый SQL, а метка ("expand" | "backfill" |
 * "contract"), но именно на ней держится `MigrationPhaseConflictError`
 * (`migration-runner.ts`, `validatePhaseBatch`) — контроль «destructive contract
 * не в одной поставке с первым новым reader/writer» (§12 03_TECHNICAL_DESIGN.md).
 * Без `phase` в checksum фазу уже применённой миграции можно было изменить
 * (например, задним числом перемаркировать `expand` в `contract`), не трогая
 * `statements`, — integrity check журнала прошёл бы молча, хотя гарантия,
 * которую даёт эта метка, больше не соответствует действительности.
 *
 * Правило нормализации одного statement (детерминированное, описано явно,
 * чтобы форматирование текста миграции не считалось изменением содержимого):
 *  1. `\r\n` -> `\n` (перевод строк не зависит от ОС/редактора);
 *  2. с каждой строки убираются хвостовые пробелы/табы;
 *  3. у результата убираются ведущие/хвостовые пустые строки (`trim`).
 * Statements объединяются символом `\n` в порядке объявления в `statements`
 * (порядок значим — это порядок фактического исполнения). `phase` добавляется
 * как первое "слово" нормализованного текста, через пробел перед первым
 * statement — простой и однозначный префикс: значения `phase` образуют
 * закрытый список из трёх лексем без пробелов (`MigrationPhase`), поэтому
 * коллизии с началом SQL-текста (который у admin-миграций начинается с
 * `create`/`alter`/`drop` и т.п., а не с этих трёх слов) не возникает.
 */
export function computeChecksum(migration: Pick<Migration, 'statements' | 'phase'>): string {
  const normalizedStatements = migration.statements.map(normalizeStatement).join('\n');
  const normalized = `${migration.phase} ${normalizedStatements}`;
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

/**
 * Строит (но не исполняет) запрос применённых миграций, отсортированных по `id`.
 *
 * `orderBy('id', 'asc')` без явной коллации сортирует текст по коллации БД
 * (`lc_collate` кластера/базы) — то есть порядок применения миграций зависел бы
 * от настройки окружения, а не только от кода, что нарушает независимость от
 * DB plan/locale (SIM-01, minor 2 раунда 3 верификации). `collate "C"` даёт
 * побайтовое сравнение независимо от `lc_collate`; для текущих `[0-9]{4}`-префиксов
 * результат совпадает с обычным `asc`, но не полагается на настройку сервера.
 *
 * Экспортируется отдельно от {@link loadAppliedMigrations}, чтобы юнит-тест мог
 * проверить сгенерированный SQL через `.compile()` без реального подключения к
 * БД (`.compile()` не открывает соединение — `pg.Pool` подключается лениво только
 * при исполнении запроса). Воспроизвести саму разницу коллаций потребовало бы
 * отдельного Postgres-кластера с нестандартным `lc_collate`, которого нет ни в
 * одном профиле CI/Testcontainers этого репозитория — см. обоснование в
 * `migration-ledger.test.ts`.
 */
export function buildAppliedMigrationsQuery(db: Kysely<Database>) {
  return db
    .selectFrom('schema_migrations')
    .selectAll()
    .orderBy(sql`id collate "C"`, 'asc');
}

export async function loadAppliedMigrations(
  db: Kysely<Database>,
): Promise<AppliedMigrationRecord[]> {
  if (!(await migrationLedgerExists(db))) {
    return [];
  }
  const rows = await buildAppliedMigrationsQuery(db).execute();
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
