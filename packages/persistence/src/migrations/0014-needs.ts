/**
 * 0014 — нужды тела: момент отсчёта у агента, второй вид запланированного действия, уровень
 * нужды в проекции (I04, `07_MVP_MECHANICS_SPEC` §5).
 *
 * ## Почему у агента момент, а не значение
 *
 * Значение нужды — производная величина: оно вычисляется из момента отсчёта, мирового времени и
 * коэффициентов ruleset. Колонка со значением была бы вторым источником одной истины, который
 * обязан обновляться при каждом чтении, — то есть либо устаревал бы, либо требовал pulse-ов,
 * запрещённых решением итерации.
 *
 * Колонки NOT NULL с умолчанием, равным времени мира: у существующих агентов нужды отсчитываются
 * с момента миграции. Backfill не имитирует историю, которой не было, — он объявляет всех
 * сытыми на момент появления механики, и это единственное утверждение, которое не выдумывает
 * фактов. Умолчание затем снимается: новый агент обязан получить момент явно, иначе первая же
 * забытая вставка дала бы агента, который вечно сыт, и заметить это можно было бы только по
 * отсутствию событий.
 *
 * ## Почему `route_id` расписания становится nullable
 *
 * Второй вид действия — пересечение порога нужды — маршрута не имеет вовсе. Проверка `check`
 * связывает вид действия с его полями: у завершения пути обязан быть маршрут и не быть нужды, у
 * пересечения — наоборот. Без такой проверки строка «пересечение по маршруту» была бы
 * представима, а `loadWorldState` собрал бы из неё действие, которое домен не породил бы никогда.
 *
 * ## Почему проекция хранит уровень, а не значение
 *
 * По той же причине, что и всюду: у проекции нет коэффициентов ruleset, и вычислять значение она
 * не имеет права. Уровень приходит из факта `need.threshold.crossed` — проекция его запоминает.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  // Момент отсчёта каждой нужды. Отдельные колонки, а не jsonb: их читает и пишет
  // `loadWorldState`/`command-handler` по имени, а форма нужд задана перечислением контракта и
  // меняется только вместе с ним — то есть это фиксированная схема, а не открытый словарь.
  `alter table agents
     add column hunger_baseline  text not null default '',
     add column fatigue_baseline text not null default ''`,
  `update agents set hunger_baseline = (
     select world_time from worlds where worlds.world_id = agents.world_id
   ) where hunger_baseline = ''`,
  `update agents set fatigue_baseline = (
     select world_time from worlds where worlds.world_id = agents.world_id
   ) where fatigue_baseline = ''`,
  `alter table agents
     alter column hunger_baseline  drop default,
     alter column fatigue_baseline drop default`,

  `alter table scheduled_actions alter column route_id drop not null`,
  `alter table scheduled_actions add column need text`,
  `alter table scheduled_actions add column to_level text`,
  `alter table scheduled_actions drop constraint scheduled_actions_kind_check`,
  `alter table scheduled_actions
     add constraint scheduled_actions_kind_check
     check (kind in ('journey.complete', 'need.threshold'))`,
  // Поля вида действия не могут разойтись с самим видом: строка «пересечение по маршруту» или
  // «завершение пути без маршрута» не должна быть представима вовсе.
  `alter table scheduled_actions
     add constraint scheduled_actions_kind_fields_check
     check (
       (kind = 'journey.complete' and route_id is not null and need is null and to_level is null)
       or
       (kind = 'need.threshold' and route_id is null and need is not null and to_level is not null)
     )`,

  `alter table projection_agents
     add column hunger_level  text not null default 'normal',
     add column fatigue_level text not null default 'normal'`,
  `alter table projection_agents
     alter column hunger_level  drop default,
     alter column fatigue_level drop default`,
  `alter table projection_events add column need text`,
  `alter table projection_events add column need_level text`,
];

/**
 * `phase: 'expand'` — добавляются колонки и ослабляется одно ограничение; ни одна существующая
 * строка не удаляется и не переписывается сверх названного backfill.
 */
export const needsMigration: Migration = {
  id: '0014',
  name: 'needs',
  phase: 'expand',
  statements,
};
