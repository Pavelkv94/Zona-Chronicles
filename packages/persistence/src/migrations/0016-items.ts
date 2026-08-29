/**
 * 0016 — предметы и запланированный приём пищи (I04, `07_MVP_MECHANICS_SPEC` §2, §16).
 *
 * ## Почему таблица, а не счётчик в строке агента
 *
 * Счётчик «еды: 3» невозможно ни отследить, ни передать: у него нет тождества, поэтому SIM-07
 * («уникальные предметы не дублируются») на нём непроверяем в принципе. Строка на предмет стоит
 * дороже в хранении и честнее в учёте: у каждого предмета есть id, владелец и история.
 *
 * ## Почему владелец — внешний ключ, а не текст
 *
 * Инвариант «владелец ровно один и он существует» исполняется схемой, а не дисциплиной кода.
 * Предмет, принадлежащий несуществующему агенту, — это предмет, который никто не может
 * израсходовать; такой мир выглядит исправным ровно до попытки его прожить.
 *
 * ## Почему съеденный предмет удаляется, а не помечается
 *
 * Помеченный съеденным предмет всё ещё существует и всё ещё может быть выбран вторым действием:
 * «нельзя потратить дважды» держалось бы тогда на внимательности каждого читателя. История при
 * этом не теряется — факт `agent.ate` в append-only журнале называет и предмет, и едока, и
 * момент; таблица предметов описывает НАСТОЯЩЕЕ, а не прошлое.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `
create table items (
  world_id  text not null references worlds (world_id),
  item_id   text not null,
  kind      text not null check (kind in ('food')),
  owner_id  text not null,
  primary key (world_id, item_id),
  foreign key (world_id, owner_id) references agents (world_id, agent_id)
)
`,
  // Читают предметы всегда «что есть у этого агента» — единственный запрос, который вообще
  // нужен домену и проекции.
  `create index items_owner_idx on items (world_id, owner_id, item_id)`,

  `alter table scheduled_actions add column item_id text`,
  `alter table scheduled_actions drop constraint scheduled_actions_kind_check`,
  `alter table scheduled_actions
     add constraint scheduled_actions_kind_check
     check (kind in ('journey.complete', 'need.threshold', 'agent.eat'))`,
  `alter table scheduled_actions drop constraint scheduled_actions_kind_fields_check`,
  // Поля вида действия по-прежнему не могут разойтись с самим видом.
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
     )`,
];

/** `phase: 'expand'` — новая таблица и новая колонка; существующие строки не меняются. */
export const itemsMigration: Migration = {
  id: '0016',
  name: 'items',
  phase: 'expand',
  statements,
};
