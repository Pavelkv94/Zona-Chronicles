/**
 * 0023 — шаг «уйти» в расписании (I06-C).
 *
 * Своих полей у действия нет, и в частности нет МАРШРУТА: дорогу выбирает `decide` в момент
 * ухода, по субъективной карте агента. Колонка `route_id` здесь означала бы, что дорогу выбрал
 * кто-то другой и раньше — то есть по устаревшему знанию.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  // Цель «уйти» — четвёртая, и проверка целей расширяется вместе с ней. Умолчания у колонки нет
  // с 0019, поэтому расширить проверку достаточно: молча появиться новая цель не может.
  `alter table agents drop constraint agents_goal_check`,
  `alter table agents add constraint agents_goal_check
     check (goal in ('idle', 'eat', 'rest', 'flee'))`,

  `alter table scheduled_actions drop constraint scheduled_actions_kind_check`,
  `alter table scheduled_actions
     add constraint scheduled_actions_kind_check
     check (kind in ('journey.complete', 'need.threshold', 'agent.eat', 'rest.complete',
                     'agent.decide', 'agent.rest', 'agent.travel'))`,
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
       -- Завершение отдыха, решение, укладывание и уход своих полей не несут: кто и когда —
       -- это entity_id и due_at, а дорогу ухода выбирает decide, а не расписание.
       (kind in ('rest.complete', 'agent.decide', 'agent.rest', 'agent.travel')
        and route_id is null and need is null and to_level is null and item_id is null)
     )`,
];

/** `phase: 'expand'` — ограничения расширяются, ни одна строка не переписывается. */
export const travelStepMigration: Migration = {
  id: '0023',
  name: 'travel-step',
  phase: 'expand',
  statements,
};
