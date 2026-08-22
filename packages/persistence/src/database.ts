import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import { Pool } from 'pg';

/**
 * Журнал применённых миграций (I00, миграция 0001).
 */
export interface SchemaMigrationsTable {
  id: string;
  name: string;
  checksum: string;
  applied_at: ColumnType<Date, Date, never>;
  duration_ms: number;
}

/**
 * Значение `bigint` из PostgreSQL: читается строкой, пишется числом или строкой.
 *
 * Драйвер `pg` намеренно не приводит `int8` к `number` — молчаливая потеря точности за
 * `Number.MAX_SAFE_INTEGER` хуже явного разбора. Разбор с проверкой границы делает
 * {@link requireSafeInteger}, а не тип.
 */
type BigIntColumn = ColumnType<string, number | string, number | string>;

/**
 * Конфигурация мира (I02A, миграция 0002).
 *
 * `world_time` — `text`, а не `timestamptz`: канонической формой момента владеет контракт, и
 * она входит в checksum события (см. шапку миграции 0002). `created_at`/`recorded_at` —
 * операционные отметки реальных часов, поэтому `timestamptz` и `Date`.
 */
export interface WorldsTable {
  world_id: string;
  seed: BigIntColumn;
  version: BigIntColumn;
  last_sequence: BigIntColumn;
  world_time: string;
  rules_version: string;
  content_version: string;
  schema_version: number;
  created_at: ColumnType<Date, Date, Date>;
}

export interface LocationsTable {
  world_id: string;
  location_id: string;
  name: string;
  description: string;
}

export interface RoutesTable {
  world_id: string;
  route_id: string;
  from_location_id: string;
  to_location_id: string;
  travel_minutes: number;
}

export interface AgentsTable {
  world_id: string;
  agent_id: string;
  name: string;
  location_id: string;
  status: 'idle' | 'traveling';
  route_id: string | null;
}

/** Append-only журнал фактов. Права на `update`/`delete` не выдаются никому (миграция 0003). */
export interface WorldEventsTable {
  event_id: string;
  world_id: string;
  sequence: BigIntColumn;
  world_time: string;
  type: string;
  schema_version: number;
  rules_version: string;
  content_version: string;
  actor_ids: string[];
  subject_ids: string[];
  location_id: string | null;
  correlation_id: string;
  caused_by: string[];
  command_id: string | null;
  random_audit: ColumnType<unknown, string | null, string | null>;
  payload: ColumnType<unknown, string, string>;
  recorded_at: ColumnType<Date, Date, Date>;
  /** Канонический checksum события, снятый ДО записи (M-3): проверяет точность round-trip. */
  event_checksum: string;
}

/** Journal команд: и accepted, и rejected — источник идемпотентности (ACCEPTANCE B3/B4). */
export interface CommandResultsTable {
  world_id: string;
  command_id: string;
  type: string;
  outcome: 'accepted' | 'rejected';
  rejection_code: string | null;
  rejection_message: string | null;
  event_ids: string[];
  /** Канонический checksum ТЕЛА команды (M-2): идемпотентность требует той же команды. */
  command_fingerprint: string;
  world_version_before: BigIntColumn;
  world_version_after: BigIntColumn;
  recorded_at: ColumnType<Date, Date, Date>;
}

/**
 * Аудит отклонённых попыток под занятым `command_id` (N-3). НЕ command journal: в
 * идемпотентности не участвует, каноническим фактом мира не является.
 */
export interface CommandAttemptRejectionsTable {
  attempt_id: Generated<BigIntColumn>;
  world_id: string;
  command_id: string;
  rejection_code: string;
  recorded_fingerprint: string;
  attempted_fingerprint: string;
  recorded_at: ColumnType<Date, Date, Date>;
}

export interface OutboxTable {
  outbox_id: Generated<BigIntColumn>;
  world_id: string;
  event_id: string;
  sequence: BigIntColumn;
  payload: ColumnType<unknown, string, string>;
  created_at: ColumnType<Date, Date, Date>;
  published_at: ColumnType<Date | null, Date | null, Date | null>;
}

/** Схема, известная пакету persistence на текущей итерации (I00 + I02A). */
export interface Database {
  schema_migrations: SchemaMigrationsTable;
  worlds: WorldsTable;
  locations: LocationsTable;
  routes: RoutesTable;
  agents: AgentsTable;
  world_events: WorldEventsTable;
  command_results: CommandResultsTable;
  command_attempt_rejections: CommandAttemptRejectionsTable;
  outbox: OutboxTable;
}

/**
 * Разбирает `bigint`-строку в безопасное целое. Выход за границу — громкий сбой: молча
 * округлить `sequence` значит потерять место в истории мира.
 */
export function requireSafeInteger(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `persistence: ${label} = ${String(value)} вне безопасного целочисленного диапазона`,
    );
  }
  return parsed;
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
 * Описание строки подключения БЕЗ пароля — для сообщений об ошибках и логов.
 *
 * M-5 (аудит I02A): сообщения `parseDatabaseConnectionUrl` печатали строку целиком через
 * `JSON.stringify`, поэтому невалидный `DATABASE_URL` с настоящим паролем уходил в stderr и в
 * любой лог, который его собирает (§11 `03_TECHNICAL_DESIGN`: secrets не в logs и artifacts).
 * Нераспознанная строка не показывается вовсе: из неё нечего вырезать безопасно.
 */
export function redactConnectionUrl(connectionUrl: string): string {
  try {
    const url = new URL(connectionUrl);
    const user = url.username.length > 0 ? `${url.username}:***@` : '';
    return `${url.protocol}//${user}${url.host}${url.pathname}`;
  } catch {
    return '<строка подключения не разобрана; содержимое скрыто, т.к. может содержать пароль>';
  }
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
      `Invalid database connection URL: not a valid URL, got ${redactConnectionUrl(connectionUrl)}.`,
    );
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(
      `Invalid database connection URL: expected "postgres://" or "postgresql://" scheme, got ` +
        `${redactConnectionUrl(connectionUrl)}.`,
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database.length === 0) {
    throw new Error(
      `Invalid database connection URL: missing database name in path, got ${redactConnectionUrl(connectionUrl)}.`,
    );
  }

  if (url.hostname.length === 0) {
    throw new Error(
      `Invalid database connection URL: missing host, got ${redactConnectionUrl(connectionUrl)}.`,
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

/** Kysely-инстанс поверх {@link Database}. Транзакция (`Transaction<Database>`) ему присваиваема,
 *  поэтому репозитории принимают этот тип и одинаково работают внутри и вне транзакции. */
export type DatabaseConnection = Kysely<Database>;

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
