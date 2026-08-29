/**
 * 0018 — отдых стал занимать мировое время (I05).
 *
 * ## Что меняется
 *
 * У агента появляется состояние `resting`, а у расписания — вид действия `rest.complete`.
 *
 * ## Почему `resting` — это статус, а не флаг
 *
 * Отдыхающий агент ЗАНЯТ: он не выйдет в путь и не ляжет отдыхать второй раз. Занятость,
 * выраженная отдельным булевым полем рядом со статусом, допускает состояние «в пути и отдыхает»
 * — представимое в данных и невозможное в мире. Статус этого не допускает по построению.
 *
 * Инвариант «в пути ⇔ есть маршрут» при этом сохраняется без правки: у отдыхающего маршрута нет,
 * и обе стороны равенства ложны.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `alter table agents drop constraint agents_status_check`,
  `alter table agents add constraint agents_status_check
     check (status in ('idle', 'traveling', 'resting'))`,
  `alter table projection_agents drop constraint projection_agents_status_check`,
  `alter table projection_agents add constraint projection_agents_status_check
     check (status in ('idle', 'traveling', 'resting'))`,
  `alter table scheduled_actions drop constraint scheduled_actions_kind_check`,
  `alter table scheduled_actions
     add constraint scheduled_actions_kind_check
     check (kind in ('journey.complete', 'need.threshold', 'agent.eat', 'rest.complete'))`,
  `alter table scheduled_actions drop constraint scheduled_actions_kind_fields_check`,
  `alter table scheduled_actions
     add constraint scheduled_actions_kind_fields_check
     check (
       (kind = 'journey.complete' and route_id is not null and need is null
        and to_level is null and item_id is null)
       or
       (kind = 'need.threshold' and route_id is null and need is not null
        and to_level is not null and item_id is null)
       or
       (kind = 'agent.eat' and route_id is null and need is null
        and to_level is null and item_id is not null)
       or
       -- Завершение отдыха не несёт своих полей вовсе: кто и когда — это entity_id и due_at.
       (kind = 'rest.complete' and route_id is null and need is null
        and to_level is null and item_id is null)
     )`,
];

/** `phase: 'expand'` — ограничения ослабляются, ни одна строка не переписывается. */
export const restingMigration: Migration = {
  id: '0018',
  name: 'resting',
  phase: 'expand',
  statements,
};
