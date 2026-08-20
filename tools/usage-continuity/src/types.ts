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

/** Строковый маркер отсутствующей capability autocontinue. Не является успехом. */
export const LIMIT_AUTOCONTINUE_UNAVAILABLE = 'LIMIT_AUTOCONTINUE_UNAVAILABLE' as const;

/**
 * Обязательные поля checkpoint из §9 08_TDD_AND_AGENT_WORKFLOW.md.
 * `capability_status` — опциональное поле для LIMIT_AUTOCONTINUE_UNAVAILABLE.
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
}
