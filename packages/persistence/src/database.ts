import { Kysely, PostgresDialect, type ColumnType } from 'kysely';
import { Pool } from 'pg';

/**
 * Журнал применённых миграций. Единственная таблица, известная пакету в I00 —
 * доменные таблицы мира (`world_events`, `agents`, ...) добавляются в I02A.
 */
export interface SchemaMigrationsTable {
  id: string;
  name: string;
  checksum: string;
  applied_at: ColumnType<Date, Date, never>;
  duration_ms: number;
}

/** Схема, известная пакету persistence на текущей итерации (I00). */
export interface Database {
  schema_migrations: SchemaMigrationsTable;
}

/**
 * Явная конфигурация подключения. Пакет не читает `process.env` — значение
 * приходит аргументом от вызывающего кода (ADR-003, ADR-008).
 */
export interface DatabaseConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly maxConnections?: number;
}

/** Фабрика Kysely-инстанса поверх `pg` с явно переданной конфигурацией. */
export function createDatabase(config: DatabaseConnectionConfig): Kysely<Database> {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: config.maxConnections ?? 10,
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
