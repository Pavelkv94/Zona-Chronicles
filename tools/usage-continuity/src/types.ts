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
 * - `progressed` — `next_exact_action` выполнен после подтверждённого resume.
 * - `waiting_for_reset` — вошли в `waiting_for_usage_reset`, wake поставлен один раз, control
 *   возвращён вызывающему (m1: не busy-wait).
 * - `capability_unavailable` — телеметрия недоступна на этой итерации/resume (A9).
 * - `resume_conflict` — повторный `resumeFromCheckpoint` при уже отмеченной попытке (B3 п.3).
 */
export type ContinuityOutcome =
  'progressed' | 'waiting_for_reset' | 'capability_unavailable' | 'resume_conflict';

/** Строковый маркер отсутствующей capability autocontinue. Не является успехом. */
export const LIMIT_AUTOCONTINUE_UNAVAILABLE = 'LIMIT_AUTOCONTINUE_UNAVAILABLE' as const;

/**
 * Обязательные поля checkpoint из §9 08_TDD_AND_AGENT_WORKFLOW.md.
 * `capability_status` — опциональное поле для LIMIT_AUTOCONTINUE_UNAVAILABLE.
 * `resume_attempted_at` — персистентный маркер идемпотентности (B3 п.3): пишется до запуска
 * `next_exact_action` при resume, чтобы падение процесса между wake и завершением действия не
 * приводило к повторному запуску действия при следующем wake.
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
  readonly last_resume_validation_error?: string;
}
