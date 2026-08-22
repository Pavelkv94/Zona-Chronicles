/**
 * 0002 — канонические таблицы первого slice (I02A ACCEPTANCE B1/B2/B7).
 *
 * Почему моменты мирового времени хранятся как `text`, а не `timestamptz`: канонической формой
 * момента владеет контракт (`parseCanonicalInstant` — ISO-8601 с явным смещением и ровно тремя
 * знаками дробной части), и она входит в checksum события. `timestamptz` — это точка на оси
 * времени БЕЗ исходного текста: round-trip через драйвер вернул бы `Date`, а обратно —
 * форматирование, зависящее от `DateStyle`/`TimeZone` сессии. SIM-01 запрещает такую зависимость.
 * `recorded_at`/`created_at` — наоборот, ОПЕРАЦИОННЫЕ отметки реальных часов, в checksum не
 * входят и хранятся как `timestamptz`.
 *
 * `sequence` и `version` — `bigint`. Драйвер отдаёт `bigint` строкой; преобразование и проверка
 * на выход за `Number.MAX_SAFE_INTEGER` — в репозитории, а не здесь.
 *
 * Один элемент `statements` — РОВНО один SQL-оператор без завершающей точки с запятой: runner
 * исполняет их через `sql.raw` по extended protocol, который не принимает несколько команд.
 */

import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `
create table worlds (
  world_id         text        primary key,
  seed             bigint      not null,
  version          bigint      not null check (version >= 0),
  last_sequence    bigint      not null check (last_sequence >= 0),
  world_time       text        not null,
  rules_version    text        not null,
  content_version  text        not null,
  schema_version   integer     not null,
  created_at       timestamptz not null
)
`,
  `
create table locations (
  world_id     text not null references worlds (world_id),
  location_id  text not null,
  name         text not null,
  description  text not null,
  primary key (world_id, location_id)
)
`,
  `
create table routes (
  world_id          text    not null references worlds (world_id),
  route_id          text    not null,
  from_location_id  text    not null,
  to_location_id    text    not null,
  travel_minutes    integer not null check (travel_minutes > 0),
  primary key (world_id, route_id),
  foreign key (world_id, from_location_id) references locations (world_id, location_id),
  foreign key (world_id, to_location_id)   references locations (world_id, location_id),
  check (from_location_id <> to_location_id)
)
`,
  `
create table agents (
  world_id     text   not null references worlds (world_id),
  agent_id     text   not null,
  name         text   not null,
  location_id  text   not null,
  status       text   not null check (status in ('idle', 'traveling')),
  route_id     text,
  primary key (world_id, agent_id),
  foreign key (world_id, location_id) references locations (world_id, location_id),
  foreign key (world_id, route_id)    references routes (world_id, route_id),
  -- Статус и маршрут не могут разойтись: агент в пути обязан иметь маршрут, idle — не иметь.
  check ((status = 'traveling') = (route_id is not null))
)
`,
  `
create table world_events (
  event_id         text        primary key,
  world_id         text        not null references worlds (world_id),
  sequence         bigint      not null check (sequence > 0),
  world_time       text        not null,
  type             text        not null,
  schema_version   integer     not null,
  rules_version    text        not null,
  content_version  text        not null,
  actor_ids        text[]      not null,
  subject_ids      text[]      not null,
  location_id      text,
  correlation_id   text        not null,
  caused_by        text[]      not null,
  command_id       text,
  random_audit     jsonb,
  payload          jsonb       not null,
  recorded_at      timestamptz not null,
  -- Монотонность sequence на мир без дыр и дублей (PLAN §7, инвариант 1; B6).
  unique (world_id, sequence)
)
`,
  `
create index world_events_world_sequence_idx on world_events (world_id, sequence)
`,
  `
create table command_results (
  world_id              text        not null references worlds (world_id),
  command_id            text        not null,
  type                  text        not null,
  outcome               text        not null check (outcome in ('accepted', 'rejected')),
  rejection_code        text,
  rejection_message     text,
  event_ids             text[]      not null,
  world_version_before  bigint      not null,
  world_version_after   bigint      not null,
  recorded_at           timestamptz not null,
  -- Идемпотентность по (мир, command_id): вторая попытка не создаст вторую строку (B3).
  primary key (world_id, command_id),
  check ((outcome = 'rejected') = (rejection_code is not null)),
  -- Отказ не порождает событий и не двигает версию мира (B4).
  check (outcome = 'accepted' or (cardinality(event_ids) = 0 and world_version_after = world_version_before))
)
`,
  `
create table outbox (
  outbox_id     bigint generated always as identity primary key,
  world_id      text        not null references worlds (world_id),
  event_id      text        not null references world_events (event_id),
  sequence      bigint      not null,
  payload       jsonb       not null,
  created_at    timestamptz not null,
  published_at  timestamptz,
  -- Ровно одна строка доставки на событие (PLAN §7, инвариант 3).
  unique (event_id)
)
`,
  `
create index outbox_unpublished_idx on outbox (world_id, sequence) where published_at is null
`,
];

/**
 * `phase: 'expand'` — миграция только добавляет таблицы; ни один существующий reader/writer
 * от неё не ломается (журнал миграций из 0001 не тронут).
 */
export const canonicalCoreMigration: Migration = {
  id: '0002',
  name: 'canonical-core',
  phase: 'expand',
  statements,
};
