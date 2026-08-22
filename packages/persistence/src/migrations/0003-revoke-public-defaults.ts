/**
 * 0003 — deny-by-default на уровне схемы (ADR-008).
 *
 * Здесь остались ТОЛЬКО свойства самой базы: `PUBLIC` не создаёт объектов и не читает таблиц.
 * Создание ролей и выдача грантов переехали в `principals.ts` и выполняются при каждом
 * `world migrate` — см. подробное обоснование там (M-4/M-8 аудита I02A): роли кластерные, а
 * журнал миграций базовый, поэтому «применено один раз» для грантов означает «после restore в
 * чистый кластер прав нет, и об этом никто не узнает».
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `revoke create on schema public from public`,
  `revoke all on all tables in schema public from public`,
];

/** `phase: 'expand'` — сужает доступ по умолчанию, ничего существующего не ломая. */
export const revokePublicDefaultsMigration: Migration = {
  id: '0003',
  name: 'revoke-public-defaults',
  phase: 'expand',
  statements,
};
