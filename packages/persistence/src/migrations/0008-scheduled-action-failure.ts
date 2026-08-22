/**
 * 0008 — запланированное действие получает ЯВНЫЙ исход при отказе (blocker аудита I02B).
 *
 * До этой миграции у действия было ровно два состояния: ожидает и выполнено. Доменный отказ не
 * был ни тем, ни другим: действие оставалось ожидающим, захватывалось каждым следующим тиком и
 * отвергалось снова — вечно. Агент при этом навсегда оставался `traveling`, а в append-only
 * журнале — `journey.started` без завершения.
 *
 * Отказ по домену на запланированном действии — нормальный исход, а не сбой: действие могло
 * устареть, пока ждало очереди. Но он обязан быть ВИДИМЫМ и КОНЕЧНЫМ. Автоматически починить
 * такой случай нельзя — мир не знает, чего оператор хотел; можно только перестать делать вид,
 * что всё в порядке.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `alter table scheduled_actions add column failed_at timestamptz`,
  `alter table scheduled_actions add column failure_code text`,
  // Исход ровно один: действие либо ожидает, либо выполнено, либо отвергнуто.
  `alter table scheduled_actions add constraint scheduled_actions_single_outcome
     check (completed_at is null or failed_at is null)`,
  `alter table scheduled_actions add constraint scheduled_actions_failure_has_code
     check ((failed_at is null) = (failure_code is null))`,
  // Индекс захвата обязан исключать отвергнутые: иначе они возвращаются в очередь навсегда.
  `drop index scheduled_actions_due_idx`,
  `create index scheduled_actions_due_idx
     on scheduled_actions (world_id, due_at, priority, entity_id, action_id)
    where completed_at is null and failed_at is null`,
];

/** `phase: 'expand'` — колонки добавляются; переиндексация не меняет данных. */
export const scheduledActionFailureMigration: Migration = {
  id: '0008',
  name: 'scheduled-action-failure',
  phase: 'expand',
  statements,
};
