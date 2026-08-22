/**
 * 0004 — отпечаток тела команды в journal (M-2 независимого архитектурного аудита I02A).
 *
 * До этой миграции идемпотентность сверяла только `(world_id, command_id)`. `--command-id` —
 * публичный флаг CLI, то есть вход, управляемый снаружи: повтор чужого идентификатора с ДРУГИМ
 * телом возвращал вызывающему «принято» и чужие `event_ids`. Идемпотентность обязана означать
 * «та же команда», а не «тот же идентификатор».
 *
 * Колонка добавляется `not null default ''` с немедленным снятием default: существующие строки
 * (только dev-прогоны — поставок ещё не было) получают пустой отпечаток, который не совпадает
 * ни с одним настоящим `sha256:…`, поэтому их повтор будет ОТКЛОНЁН, а не тихо признан своим.
 * Это fail-closed: непроверяемая запись journal не должна выдаваться за авторитетную. Новые
 * строки обязаны приносить отпечаток — default снят, чтобы пропуск был ошибкой, а не пустотой.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `alter table command_results add column command_fingerprint text not null default ''`,
  `alter table command_results alter column command_fingerprint drop default`,
];

/** `phase: 'expand'` — колонка добавляется, ничего существующего не ломая. */
export const commandFingerprintMigration: Migration = {
  id: '0004',
  name: 'command-fingerprint',
  phase: 'expand',
  statements,
};
