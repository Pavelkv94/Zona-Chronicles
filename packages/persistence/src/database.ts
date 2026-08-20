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

/**
 * Строит {@link DatabaseConnectionConfig} из connection URL вида
 * `postgres://user:password@host:port/database`.
 *
 * Пакет по-прежнему не читает `process.env` сам (см. `DatabaseConnectionConfig`) —
 * эта функция чистая: вызывающий код (`apps/api`, `apps/worker`) читает
 * `DATABASE_URL` (см. `docker-compose.yml`) и передаёт строку сюда явно. Существует,
 * чтобы I02A не изобретала парсинг URL заново под каждое приложение — единственный
 * источник правды о том, как `DATABASE_URL` разбирается на поля, живёт здесь, рядом
 * с `DatabaseConnectionConfig`, который он заполняет.
 *
 * `maxConnections` в URL не кодируется (в `DATABASE_URL` из `docker-compose.yml`
 * его нет) — это explicit-параметр приложения, не берётся из строки подключения.
 */
export function parseDatabaseConnectionUrl(connectionUrl: string): DatabaseConnectionConfig {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    throw new Error(
      `Invalid database connection URL: not a valid URL, got ${JSON.stringify(connectionUrl)}.`,
    );
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(
      `Invalid database connection URL: expected "postgres://" or "postgresql://" scheme, got ` +
        `${JSON.stringify(connectionUrl)}.`,
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database.length === 0) {
    throw new Error(
      `Invalid database connection URL: missing database name in path, got ${JSON.stringify(connectionUrl)}.`,
    );
  }

  if (url.hostname.length === 0) {
    throw new Error(
      `Invalid database connection URL: missing host, got ${JSON.stringify(connectionUrl)}.`,
    );
  }

  const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : 5432;

  return {
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
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
