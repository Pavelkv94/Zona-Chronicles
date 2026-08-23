/**
 * 0011 — таблицы observer projection (I03, OPS-02, §7 03_TECHNICAL_DESIGN).
 *
 * ## Почему отдельные таблицы, а не выборка из канонических
 *
 * Канонические `agents`/`locations`/`routes` — материализованное состояние мира; observer
 * projection — то, что разрешено ВИДЕТЬ. Совпадение содержимого сегодня не делает их одной
 * сущностью: у проекции своя история (она может отставать и пересобираться), свой курсор и своя
 * граница доступа. Читать канонические таблицы observer-путь не имеет ПРАВА, и запрет исполняется
 * грантами роли `zona_api`, а не отсутствием кода (D5).
 *
 * ## `projection_sequence` — не канонический `sequence`
 *
 * Зритель получает курсор проекции. Он растёт на КАЖДОЕ применённое проекцией событие и не обязан
 * совпадать с номером события в журнале: проекция может не показывать события, не попадающие в
 * observer-слой. Совпадение значений в первом slice — совпадение, а не свойство, и полагаться на
 * него нельзя (`PROJECTION_SEQUENCE_UNIT` в контрактах объясняет то же).
 *
 * ## Курсор хранится вместе с проекцией
 *
 * `projection_state` держит и `projection_sequence`, и `last_event_sequence` — сколько журнала уже
 * применено. Второе нужно, чтобы догон после перезапуска шёл ровно один раз на событие (D6): без
 * записанной позиции журнала builder не отличил бы «ещё не применял» от «уже применил».
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `
create table projection_state (
  world_id             text        primary key,
  projection_sequence  bigint      not null check (projection_sequence >= 0),
  last_event_sequence  bigint      not null check (last_event_sequence >= 0),
  world_time           text        not null,
  updated_at           timestamptz not null
)
`,
  `
create table projection_locations (
  world_id     text not null,
  location_id  text not null,
  name         text not null,
  description  text not null,
  primary key (world_id, location_id)
)
`,
  `
create table projection_routes (
  world_id          text    not null,
  route_id          text    not null,
  from_location_id  text    not null,
  to_location_id    text    not null,
  travel_minutes    integer not null check (travel_minutes > 0),
  primary key (world_id, route_id)
)
`,
  `
create table projection_agents (
  world_id     text not null,
  agent_id     text not null,
  name         text not null,
  location_id  text,
  status       text not null check (status in ('idle', 'traveling')),
  route_id     text,
  primary key (world_id, agent_id),
  -- Тот же инвариант, что у канонических агентов: в пути обязан быть маршрут и не быть локации.
  check ((status = 'traveling') = (route_id is not null)),
  check ((status = 'traveling') = (location_id is null))
)
`,
  `
create table projection_events (
  world_id             text        not null,
  projection_sequence  bigint      not null check (projection_sequence >= 1),
  event_id             text        not null,
  world_time           text        not null,
  type                 text        not null,
  actor_ids            text[]      not null,
  location_id          text,
  route_id             text,
  primary key (world_id, projection_sequence),
  -- Одно событие журнала попадает в ленту не более одного раза (D6: без дублей).
  unique (world_id, event_id)
)
`,
  // Лента читается «после курсора, по возрастанию» — единственный порядок, в котором её вообще
  // читают (D9). Индекс совпадает с первичным ключом по составу, поэтому отдельного нет.
  `
create index projection_events_world_time_idx on projection_events (world_id, world_time)
`,
];

/** `phase: 'expand'` — добавляются новые таблицы; канонические не меняются. */
export const observerProjectionMigration: Migration = {
  id: '0011',
  name: 'observer-projection',
  phase: 'expand',
  statements,
};
