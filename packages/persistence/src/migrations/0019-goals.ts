/**
 * 0019 — у агента появилась цель (I05-B, `07_MVP_MECHANICS_SPEC` §6).
 *
 * ## Что меняется
 *
 * У агента — колонка `goal`; у расписания — два вида действия: `agent.decide` (решение) и
 * `agent.rest` (шаг «лечь отдыхать»); у проекции — цель на карточке и цель в строке ленты.
 *
 * ## Почему умолчание `idle` и почему оно снимается
 *
 * Существующие агенты никаких целей не выбирали: до этой миграции выбора в мире не было. Объявить
 * их праздными — единственное утверждение, которое не выдумывает фактов, и оно ровно то же, что
 * сделал бы первый же вызов `chooseGoal` для спокойного тела.
 *
 * Умолчание затем снимается: новый агент обязан получить цель явно. Иначе забытая вставка дала
 * бы агента, у которого цель «идёт по умолчанию», и разошлась бы с журналом молча — заметно
 * только сверкой checksum при replay, то есть сильно позже причины. Тот же приём и то же
 * основание, что у моментов отсчёта нужд в 0014.
 *
 * ## Почему у новых видов действия нет своих колонок
 *
 * Ни решение, ни укладывание не несут параметров: кто и когда — это `entity_id` и `due_at`.
 * Проверка `check` требует, чтобы все специальные поля были пусты, — строка «решение по
 * маршруту» не должна быть представима вовсе.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `alter table agents add column goal text not null default 'idle'`,
  `alter table agents add constraint agents_goal_check
     check (goal in ('idle', 'eat', 'rest'))`,
  `alter table agents alter column goal drop default`,

  `alter table scheduled_actions drop constraint scheduled_actions_kind_check`,
  `alter table scheduled_actions
     add constraint scheduled_actions_kind_check
     check (kind in ('journey.complete', 'need.threshold', 'agent.eat', 'rest.complete',
                     'agent.decide', 'agent.rest'))`,
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
       -- Завершение отдыха, решение и укладывание своих полей не несут: кто и когда — это
       -- entity_id и due_at.
       (kind in ('rest.complete', 'agent.decide', 'agent.rest') and route_id is null
        and need is null and to_level is null and item_id is null)
     )`,

  `alter table projection_agents add column goal text not null default 'idle'`,
  `alter table projection_agents alter column goal drop default`,
  // Цель события ленты — nullable: у событий, к выбору не относящихся, её нет. Разбора оценок
  // здесь нет и не будет: §7 `03_TECHNICAL_DESIGN` запрещает публичному слою decision trace.
  `alter table projection_events add column goal text`,
];

/**
 * `phase: 'expand'` — добавляются колонки и расширяются ограничения; ни одна существующая строка
 * не удаляется и не переписывается сверх названного умолчания.
 */
export const goalsMigration: Migration = {
  id: '0019',
  name: 'goals',
  phase: 'expand',
  statements,
};
