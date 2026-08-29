/**
 * 0017 — запас еды на карточке агента (I04).
 *
 * Проекция считает его СВЁРТКОЙ по фактам `agent.ate`, а не чтением канонической таблицы
 * предметов: observer path не имеет права дотягиваться до канона (OPS-02/D5), и права на
 * `items` роли проекции не выдаются. Начальное значение приходит из генезисного снимка вместе с
 * расстановкой агентов — тем же путём, что их локации.
 *
 * Умолчание 0 нужно только для строк, записанных до этой миграции: у них запас неизвестен, и
 * ноль — единственное значение, которое ничего не выдумывает. Пересборка проекции (D7) вернёт
 * настоящее число.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `alter table projection_agents add column food_carried integer not null default 0
     check (food_carried >= 0)`,
];

/** `phase: 'expand'` — добавляется колонка с умолчанием; существующие строки читаются как прежде. */
export const projectionFoodMigration: Migration = {
  id: '0017',
  name: 'projection-food',
  phase: 'expand',
  statements,
};
