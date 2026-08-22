/**
 * 0006 — журнал отклонённых ПОПЫТОК под уже занятым `command_id` (N-3 повторного аудита I02A).
 *
 * Отказ по несовпадению отпечатка нельзя записать в `command_results`: первичный ключ
 * `(world_id, command_id)` уже занят исходной командой, и переписать её строку значило бы
 * потерять записанный результат. Но и не записывать нельзя — PLAN §4.8 требует сохранять
 * результат и accepted, и rejected, а этот конкретный отказ единственный, значимый для
 * безопасности: попытка подставить чужой `command_id` обязана оставлять след.
 *
 * Поэтому у попытки собственный приёмник. Он не является command journal-ом и не участвует в
 * идемпотентности: это аудит, а не канонический факт мира.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `
create table command_attempt_rejections (
  attempt_id             bigint generated always as identity primary key,
  world_id               text        not null references worlds (world_id),
  command_id             text        not null,
  rejection_code         text        not null,
  recorded_fingerprint   text        not null,
  attempted_fingerprint  text        not null,
  recorded_at            timestamptz not null,
  check (recorded_fingerprint <> attempted_fingerprint)
)
`,
  `create index command_attempt_rejections_lookup_idx
     on command_attempt_rejections (world_id, command_id, recorded_at)`,
];

/** `phase: 'expand'` — новая таблица, ничего существующего не ломает. */
export const commandAttemptRejectionsMigration: Migration = {
  id: '0006',
  name: 'command-attempt-rejections',
  phase: 'expand',
  statements,
};
