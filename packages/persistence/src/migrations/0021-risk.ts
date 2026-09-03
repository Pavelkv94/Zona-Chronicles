/**
 * 0021 — у мест и дорог появилась опасность, у агента — осторожность (I06, §8).
 *
 * ## Почему риск здесь, а не в правилах
 *
 * «Мост полуразрушен» — свойство моста, а не настройка баланса: меняется оно вместе с картой и
 * версионируется версией КОНТЕНТА. Тот же довод, по которому длительность маршрута лежит в
 * данных маршрута, а не в ruleset.
 *
 * ## Почему умолчание ноль, и почему оно снимается
 *
 * Существующие места и дороги опасности не имели вовсе — объявить их безопасными единственное
 * утверждение, которое не выдумывает фактов о мире. Умолчание затем снимается: новая дорога
 * обязана назвать свой риск явно, иначе забытая вставка молча добавила бы миру безопасный
 * коридор, и заметить это можно было бы только по тому, что все ходят одной дорогой.
 *
 * ## Почему осторожность — колонка агента, а не таблица черт
 *
 * Черта здесь ровно одна, и таблица «черта — значение» на одну строку это не гибкость, а
 * отложенное решение о форме, принятое до того, как появился второй случай. Когда черт станет
 * несколько, форма выберется по ним, а не по догадке.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `alter table locations add column risk integer not null default 0`,
  `alter table locations add constraint locations_risk_check check (risk between 0 and 1000)`,
  `alter table locations alter column risk drop default`,

  `alter table routes add column risk integer not null default 0`,
  `alter table routes add constraint routes_risk_check check (risk between 0 and 1000)`,
  `alter table routes alter column risk drop default`,

  // Нейтральная осторожность для тех, кто существовал до розыгрыша: тысячная доля от единицы.
  // Утверждение «этот агент не осторожнее и не беспечнее среднего» — единственное, которое
  // можно сделать о том, чья черта не разыгрывалась.
  `alter table agents add column caution integer not null default 1000`,
  `alter table agents add constraint agents_caution_check check (caution between 0 and 10000)`,
  `alter table agents alter column caution drop default`,
];

/** `phase: 'expand'` — добавляются колонки; ни одна существующая строка не переписывается. */
export const riskMigration: Migration = {
  id: '0021',
  name: 'risk',
  phase: 'expand',
  statements,
};
