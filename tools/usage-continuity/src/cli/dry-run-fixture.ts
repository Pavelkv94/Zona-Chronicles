/**
 * Общий fixture двухпроцессного dry-run continuity harness (DEV-01, review m5).
 * Импортируется отдельно КАЖДЫМ из двух `node`-процессов (`dry-run-phase1.ts`,
 * `dry-run-phase2.ts`) — они не делят память, только checkpoint-файл на диске (сам предмет
 * доказательства B3), поэтому эти константы должны совпадать между процессами, а не
 * передаваться через shared JS state.
 */
import type { RepoStatePort } from '../ports.ts';
import type { Checkpoint, UsageWindowSample } from '../types.ts';

export const TASK_ID = 'I00-T02-dry-run';

/** Момент, когда provider обещает reset пятичасового окна. */
export const RESET_AT = '2026-01-01T05:00:00.000Z';

/** "Сейчас" для phase 1 (первый процесс) — заведомо раньше RESET_AT. */
export const PHASE1_NOW = '2026-01-01T00:00:00.000Z';

/**
 * "Сейчас" для phase 2 (второй процесс, resume) — РОВНО RESET_AT. Это намеренно демонстрирует
 * ветку `resetReached` state machine (`now >= reported_reset_at`), а не ветку `recovered`
 * (`remaining_percent` внезапно вырос) — именно так выглядит настоящий сценарий DEV-01: провайдер
 * сбросил окно, а не телеметрия "неожиданно поправилась".
 */
export const PHASE2_NOW = RESET_AT;

/** Значения repo state, которые обе фазы используют независимо друг от друга. */
export const WORKTREE = 'dry-run-worktree';
export const BRANCH = 'main';
export const HEAD_SHA = 'dry-run-head-sha';
export const DIRTY_FILES: readonly string[] = [];
export const UNFINISHED_PROCESSES: readonly string[] = [];

export function buildSeedCheckpoint(): Checkpoint {
  return {
    task_id: TASK_ID,
    iteration_id: 'I00',
    objective: 'dry-run: usage-window continuity harness, межпроцессный resume (DEV-01, B3)',
    plan_status: 'dry-run in progress',
    branch: BRANCH,
    worktree: WORKTREE,
    base_sha: 'dry-run-base-sha',
    head_sha: HEAD_SHA,
    changed_files: [],
    dirty_files: [...DIRTY_FILES],
    own_commits: [],
    last_red: 'n/a (dry-run fixture)',
    last_green: 'n/a (dry-run fixture)',
    unfinished_processes: [...UNFINISHED_PROCESSES],
    decisions: [
      'dry-run: phase 1 и phase 2 — отдельные node-процессы, обмен только через checkpoint-файл',
      'dry-run: resume проходит ветку resetReached (now >= reported_reset_at), не recovered',
    ],
    risks: [],
    next_exact_action: 'dry-run-resume-action',
    usage_window_remaining_percent: 5,
    reported_reset_at: RESET_AT,
    checkpointed_at: PHASE1_NOW,
  };
}

export function sample(
  remaining_percent: number,
  reported_reset_at: string = RESET_AT,
): UsageWindowSample {
  return {
    remaining_percent,
    reported_reset_at,
    source: 'dry-run-fixture',
    observed_at: PHASE1_NOW,
  };
}

/** RepoStatePort, совпадающий с checkpoint, записанным `buildSeedCheckpoint()`. */
export function matchingRepoState(): RepoStatePort {
  return {
    branch: () => BRANCH,
    headSha: () => HEAD_SHA,
    changedFiles: () => [...DIRTY_FILES],
    worktree: () => WORKTREE,
    livingProcesses: () => [...UNFINISHED_PROCESSES],
  };
}
