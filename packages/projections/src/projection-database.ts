/**
 * Хранилище observer projection: СОБСТВЕННАЯ схема, физически не выражающая канонический запрос.
 *
 * ## Почему у проекций свой доступ к БД, а не переиспользованный из `@zona/persistence`
 *
 * `apps/api` зависит от проекций, а правило `observer-api-does-not-reach-persistence`
 * (`.dependency-cruiser.cjs`) запрещает observer-пути дотягиваться до канонического хранилища
 * ТРАНЗИТИВНО. Импортировать сюда `@zona/persistence` значило бы молча снять запрет для всего API.
 *
 * Но дело не только в правиле. Тип {@link ProjectionDatabase} перечисляет ровно пять таблиц
 * проекции — канонических в нём НЕТ. Поэтому запрос к `world_events` из observer-пути не
 * компилируется: он невыразим, а не запрещён. Права роли `zona_api` (только `SELECT` на
 * `projection_*`) — второй, независимый слой того же запрета, и они действуют даже если типы
 * обойти (D5: отказ обязан приходить от прав, а не от отсутствия кода).
 *
 * Цена — повторение фабрики подключения. Она принята сознательно: единственная альтернатива —
 * общий пакет доступа к БД, который снова связал бы observer-путь с каноническим хранилищем, то
 * есть вернул бы ровно ту зависимость, ради отсутствия которой всё это делается.
 *
 * ## Миграции сюда не переезжают
 *
 * Таблицы `projection_*` создаёт канонический реестр миграций (0011): база одна, владелец схемы
 * один, и второй независимый механизм миграций означал бы два порядка применения без общего
 * журнала. Разделяет доступ не схема, а гранты.
 */
import { type ColumnType, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

/** `bigint` приходит из драйвера строкой; поведение то же, что в каноническом слое. */
type BigIntColumn = ColumnType<string, number | string, number | string>;

export interface ProjectionStateTable {
  world_id: string;
  projection_sequence: BigIntColumn;
  last_event_sequence: BigIntColumn;
  world_time: string;
  updated_at: ColumnType<Date, Date, Date>;
}

export interface ProjectionLocationsTable {
  world_id: string;
  location_id: string;
  name: string;
  description: string;
}

export interface ProjectionRoutesTable {
  world_id: string;
  route_id: string;
  from_location_id: string;
  to_location_id: string;
  travel_minutes: number;
}

export interface ProjectionAgentsTable {
  world_id: string;
  agent_id: string;
  name: string;
  location_id: string | null;
  status: string;
  route_id: string | null;
  /** Уровень каждой нужды, запомненный из факта `need.threshold.crossed` (миграция 0014). */
  hunger_level: string;
  fatigue_level: string;
  /** Запас съедобного (миграция 0017). Считается свёрткой по фактам, а не читается из канона. */
  food_carried: number;
}

export interface ProjectionEventsTable {
  world_id: string;
  projection_sequence: BigIntColumn;
  event_id: string;
  world_time: string;
  type: string;
  actor_ids: string[];
  location_id: string | null;
  route_id: string | null;
  /** Нужда и достигнутый уровень; `null` у событий, к нуждам не относящихся (0014). */
  need: string | null;
  need_level: string | null;
}

/**
 * Полный перечень таблиц, доступных observer-пути. Канонических здесь нет и не будет: добавление
 * сюда любой из них — не расширение возможностей, а снятие границы OPS-02/D5.
 */
export interface ProjectionSchema {
  projection_state: ProjectionStateTable;
  projection_locations: ProjectionLocationsTable;
  projection_routes: ProjectionRoutesTable;
  projection_agents: ProjectionAgentsTable;
  projection_events: ProjectionEventsTable;
}

export type ProjectionDatabase = Kysely<ProjectionSchema>;

export interface ProjectionDatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly maxConnections?: number;
}

/** Скрывает пароль: строка подключения попадает в сообщения об ошибках. */
function redact(connectionUrl: string): string {
  try {
    const url = new URL(connectionUrl);
    if (url.password.length > 0) url.password = '***';
    return url.toString();
  } catch {
    return '<неразбираемая строка подключения>';
  }
}

export function parseProjectionDatabaseUrl(connectionUrl: string): ProjectionDatabaseConfig {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    throw new Error(`projections: строка подключения не является URL: ${redact(connectionUrl)}`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(
      `projections: ожидалась схема postgres:// или postgresql://, получено ${redact(connectionUrl)}`,
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database.length === 0) {
    throw new Error(`projections: в строке подключения нет имени базы: ${redact(connectionUrl)}`);
  }
  if (url.hostname.length === 0) {
    throw new Error(`projections: в строке подключения нет хоста: ${redact(connectionUrl)}`);
  }
  return {
    host: url.hostname,
    port: url.port.length > 0 ? Number.parseInt(url.port, 10) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

export function createProjectionDatabase(config: ProjectionDatabaseConfig): ProjectionDatabase {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: config.maxConnections ?? 10,
  });
  return new Kysely<ProjectionSchema>({ dialect: new PostgresDialect({ pool }) });
}

/** `bigint` из драйвера — строка; безопасное целое обязано быть проверено, а не предположено. */
export function requireSafeInteger(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`projections: ${label} не является безопасным целым: ${String(value)}`);
  }
  return parsed;
}
