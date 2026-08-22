/**
 * 0007 — расписание и снимки (I02B).
 *
 * `scheduled_actions` — ЗЕРКАЛО канонического состояния плюс операционные поля. Канонической
 * частью являются `kind`, `due_at`, `priority`, `entity_id`, `route_id`: они выводятся из
 * событий чистой функцией `evolve` (см. `ScheduledAction` в `@zona/domain`). Аренда
 * (`lease_owner`, `lease_until`) и `completed_at` каноническими НЕ являются — они описывают,
 * кто и когда обрабатывает действие, а не что происходит в мире, и в checksum не входят.
 *
 * Выполненное действие помечается, а не удаляется (ACCEPTANCE C2): каноническое состояние
 * содержит только НЕЗАВЕРШЁННЫЕ действия (`completed_at is null`), а история обработки нужна
 * для расследования «почему это произошло тогда, а не раньше».
 *
 * `due_at` — `text` с канонической ISO-меткой МИРОВОГО времени, по тому же доводу, что и
 * `world_time` в 0002: это момент внутри мира, а не отметка реальных часов.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `
create table scheduled_actions (
  world_id      text    not null references worlds (world_id),
  action_id     text    not null,
  kind          text    not null check (kind in ('journey.complete')),
  due_at        text    not null,
  priority      integer not null,
  entity_id     text    not null,
  route_id      text    not null,
  lease_owner   text,
  lease_until   timestamptz,
  completed_at  timestamptz,
  primary key (world_id, action_id),
  foreign key (world_id, entity_id) references agents (world_id, agent_id),
  foreign key (world_id, route_id)  references routes (world_id, route_id),
  -- Аренда либо есть целиком, либо её нет: владелец без срока — это утечка на неопределённое время.
  check ((lease_owner is null) = (lease_until is null))
)
`,
  // Порядок захвата (C4): due_at, затем priority, затем entity_id, затем action_id. Он же —
  // порядок индекса, поэтому стабильность не зависит от плана запроса.
  `create index scheduled_actions_due_idx
     on scheduled_actions (world_id, due_at, priority, entity_id, action_id)
    where completed_at is null`,
  `
create table world_snapshots (
  world_id                       text        not null references worlds (world_id),
  last_sequence                  bigint      not null check (last_sequence >= 0),
  world_time                     text        not null,
  checksum                       text        not null,
  prng_stream_positions          jsonb       not null,
  canonical_state                jsonb       not null,
  deterministic_runtime_profile  jsonb       not null,
  created_at                     timestamptz not null,
  primary key (world_id, last_sequence)
)
`,
];

/** `phase: 'expand'` — только новые таблицы. */
export const schedulerAndSnapshotsMigration: Migration = {
  id: '0007',
  name: 'scheduler-and-snapshots',
  phase: 'expand',
  statements,
};
