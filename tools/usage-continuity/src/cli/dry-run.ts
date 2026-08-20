#!/usr/bin/env node
/**
 * Ускоренный прогон continuity harness (DEV-01) с фейковой телеметрией 5% -> 2% -> 1% -> reset.
 *
 * Никаких реальных ожиданий по wall clock: ClockPort зафиксирован на одном значении, а выход
 * из waiting_for_usage_reset достигается через сэмпл с remaining_percent > 2% (recovered-ветка
 * nextState), а не через продвижение времени. Это соответствует ACCEPTANCE A8: "реальные пять
 * часов в тесте не ждут — clock/usage telemetry инъектируются".
 *
 * Использование: node tools/usage-continuity/src/cli/dry-run.ts
 * Код возврата: 0 — последовательность переходов и однократный resume action корректны;
 *               1 — нарушение (неверный порядок переходов, дублирование action, ошибка).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCheckpointStore } from '../file-checkpoint-store.ts';
import { runContinuityLoop } from '../runner.ts';
import type {
  ActionRunnerPort,
  ClockPort,
  RepoStatePort,
  UsageTelemetryPort,
  WakeSchedulerPort,
} from '../ports.ts';
import type { Checkpoint, UsageWindowSample } from '../types.ts';

const TASK_ID = 'I00-T02-dry-run';
const RESET_AT = '2026-01-01T05:00:00.000Z';
const FIXED_NOW = '2026-01-01T00:00:00.000Z';

const seed: Checkpoint = {
  task_id: TASK_ID,
  iteration_id: 'I00',
  objective: 'dry-run: usage-window continuity harness (DEV-01)',
  plan_status: 'dry-run in progress',
  branch: 'main',
  worktree: process.cwd(),
  base_sha: 'dry-run-base-sha',
  head_sha: 'dry-run-head-sha',
  changed_files: [],
  dirty_files: [],
  own_commits: [],
  last_red: 'n/a (dry-run fixture)',
  last_green: 'n/a (dry-run fixture)',
  unfinished_processes: [],
  decisions: ['dry-run: искусственные переходы 5% -> 2% -> 1% -> reset, без реального ожидания'],
  risks: [],
  next_exact_action: 'dry-run-resume-action',
  usage_window_remaining_percent: 5,
  reported_reset_at: RESET_AT,
  checkpointed_at: FIXED_NOW,
};

function sample(remaining_percent: number): UsageWindowSample {
  return {
    remaining_percent,
    reported_reset_at: RESET_AT,
    source: 'dry-run-fixture',
    observed_at: FIXED_NOW,
  };
}

const samples: UsageWindowSample[] = [sample(5), sample(2), sample(1), sample(100)];

let cursor = 0;
const telemetry: UsageTelemetryPort = {
  read: () => {
    const index = Math.min(cursor, samples.length - 1);
    cursor += 1;
    return samples[index] ?? null;
  },
};

const clock: ClockPort = { now: () => FIXED_NOW };

const scheduledWakes: { at: string; reason: string }[] = [];
const scheduler: WakeSchedulerPort = {
  scheduleWake: (at, reason) => {
    scheduledWakes.push({ at, reason });
  },
};

const executedActions: string[] = [];
const actions: ActionRunnerPort = {
  run: (actionId) => {
    executedActions.push(actionId);
    return 'ok';
  },
};

const repoState: RepoStatePort = {
  branch: () => seed.branch,
  headSha: () => seed.head_sha,
  changedFiles: () => [],
};

const EXPECTED_TRANSITIONS = [
  'normal->checkpoint_only',
  'checkpoint_only->waiting_for_usage_reset',
  'waiting_for_usage_reset->validating_resume',
  'validating_resume->in_progress',
];

const storeRoot = mkdtempSync(join(tmpdir(), 'usage-continuity-dry-run-'));
const store = new FileCheckpointStore({ root: storeRoot });
const checkpointPath = join(storeRoot, '.claude', 'checkpoints', `${TASK_ID}.md`);

try {
  const result = runContinuityLoop({
    telemetry,
    store,
    scheduler,
    clock,
    actions,
    repoState,
    checkpointSeed: seed,
    maxIterations: 10,
  });

  const actualTransitions = result.transitions.map((t) => `${t.from}->${t.to}`);

  console.log('Переходы continuity state machine:');
  for (const line of actualTransitions) {
    console.log(`  ${line}`);
  }
  console.log(`Итоговое состояние: ${result.finalState}`);
  console.log(`Checkpoint записан в: ${checkpointPath}`);
  console.log(
    `Persisted wake: ${
      scheduledWakes.length > 0
        ? scheduledWakes.map((w) => `${w.at} (${w.reason})`).join('; ')
        : 'none'
    }`,
  );
  console.log(
    `next_exact_action выполнен ${String(executedActions.length)} раз(а): [${executedActions.join(', ')}]`,
  );

  const sequenceMatches =
    actualTransitions.length === EXPECTED_TRANSITIONS.length &&
    actualTransitions.every((transition, index) => transition === EXPECTED_TRANSITIONS[index]);
  const actionRanExactlyOnce =
    executedActions.length === 1 && executedActions[0] === seed.next_exact_action;

  if (!sequenceMatches) {
    console.error(
      `FAIL: порядок переходов не совпадает с ожидаемым: ${EXPECTED_TRANSITIONS.join(' -> ')}`,
    );
    process.exit(1);
  }
  if (!actionRanExactlyOnce) {
    console.error('FAIL: next_exact_action должен быть выполнен ровно один раз, без дублирования.');
    process.exit(1);
  }

  console.log('OK: dry-run continuity sequence валиден.');
  process.exit(0);
} catch (error) {
  console.error('FAIL:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
