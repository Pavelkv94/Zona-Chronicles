/**
 * Типы harness пятичасового usage window (DEV-01).
 * Источник нормативных полей: docs/08_TDD_AND_AGENT_WORKFLOW.md §9,
 * docs/iterations/I00-repository-and-agent-harness/ACCEPTANCE.md A7-A9.
 */

/** Один сэмпл provider/platform telemetry пятичасового usage window. */
export interface UsageWindowSample {
  /** Остаток окна в процентах, 0..100. Не context-window и не token estimate. */
  readonly remaining_percent: number;
  /** ISO-8601 время, когда provider обещает reset окна. */
  readonly reported_reset_at: string;
  /** Источник телеметрии (например имя провайдера/адаптера), для audit trail. */
  readonly source: string;
  /** ISO-8601 время наблюдения сэмпла. */
  readonly observed_at: string;
}

/** Состояния continuity state machine, см. §9 08_TDD_AND_AGENT_WORKFLOW.md. */
export type ContinuityState =
  'normal' | 'checkpoint_only' | 'waiting_for_usage_reset' | 'validating_resume' | 'in_progress';

/**
 * Явный дискриминатор результата continuity harness (review finding m2). Вызывающий не должен
 * различать "капитуляцию" и "прогресс" по форме значения (`actionResult === null` означало и то,
 * и другое) — только по этому полю.
 *
 * - `progressed` — `next_exact_action` выполнен после подтверждённого resume, и попытка
 *   зафиксирована как завершённая (`resume_completed_at` записан) в ЭТОМ вызове.
 * - `waiting_for_reset` — вошли в `waiting_for_usage_reset`, wake поставлен один раз, control
 *   возвращён вызывающему (m1: не busy-wait).
 * - `capability_unavailable` — телеметрия недоступна на этой итерации/resume (A9).
 * - `resume_already_completed` — повторный `resumeFromCheckpoint` видит попытку, которая уже
 *   ДОШЛА до конца (`resume_attempted_at` И `resume_completed_at` присутствуют): action не
 *   запускается повторно, `actionResult` возвращает ранее записанный `resume_result` (N9).
 * - `resume_incomplete` — повторный `resumeFromCheckpoint` видит попытку, которая НАЧАЛАСЬ, но
 *   не завершилась (`resume_attempted_at` присутствует, `resume_completed_at` — нет): процесс,
 *   выполнявший `next_exact_action`, оборвался между стартом попытки и записью исхода. Это НЕ
 *   успех и не эквивалент `resume_already_completed` — action по-прежнему не запускается
 *   автоматически, но вызывающий обязан явно решить, что делать, а не считать состояние штатным
 *   (N9; ранее оба случая были неразличимы под именем `resume_conflict`).
 */
export type ContinuityOutcome =
  | 'progressed'
  | 'waiting_for_reset'
  | 'capability_unavailable'
  | 'resume_already_completed'
  | 'resume_incomplete';

/** Строковый маркер отсутствующей capability autocontinue. Не является успехом. */
export const LIMIT_AUTOCONTINUE_UNAVAILABLE = 'LIMIT_AUTOCONTINUE_UNAVAILABLE' as const;

/**
 * Обязательные поля checkpoint из §9 08_TDD_AND_AGENT_WORKFLOW.md.
 * `capability_status` — опциональное поле для LIMIT_AUTOCONTINUE_UNAVAILABLE.
 * `resume_attempted_at` — персистентный маркер СТАРТА попытки (B3 п.3): пишется до запуска
 * `next_exact_action` при resume, чтобы падение процесса между wake и завершением действия было
 * обнаружимо следующим resume, а не выглядело неотличимым от успеха (N9).
 * `resume_completed_at` — персистентный маркер ИСХОДА попытки (N9): пишется ПОСЛЕ того, как
 * `next_exact_action` вернул управление (не бросил исключение), вместе с `resume_result`. Пара
 * `resume_attempted_at` без `resume_completed_at` — это единственный и точный признак того, что
 * попытка оборвалась между стартом и завершением: следующий resume обязан различать этот случай
 * и случай "попытка уже дошла до конца", а не сваливать оба под одно имя исхода.
 * `resume_result` — исход `next_exact_action` (`'ok' | 'failed'`), записанный вместе с
 * `resume_completed_at`; позволяет повторному resume вернуть ранее вычисленный результат вместо
 * `null`, когда попытка уже завершена.
 * `last_resume_validation_error` — описание расхождения repo state с checkpoint (m4),
 * записывается в checkpoint до того, как `resumeFromCheckpoint` бросит ошибку, чтобы evidence
 * не терялось вместе с исключением.
 */
export interface Checkpoint {
  readonly task_id: string;
  readonly iteration_id: string;
  readonly objective: string;
  readonly plan_status: string;
  readonly branch: string;
  readonly worktree: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly changed_files: readonly string[];
  readonly dirty_files: readonly string[];
  readonly own_commits: readonly string[];
  readonly last_red: string;
  readonly last_green: string;
  readonly unfinished_processes: readonly string[];
  readonly decisions: readonly string[];
  readonly risks: readonly string[];
  readonly next_exact_action: string;
  readonly usage_window_remaining_percent: number;
  readonly reported_reset_at: string;
  readonly checkpointed_at: string;
  readonly capability_status?: string;
  readonly resume_attempted_at?: string;
  readonly resume_completed_at?: string;
  readonly resume_result?: 'ok' | 'failed';
  readonly last_resume_validation_error?: string;
}
