#!/usr/bin/env node
/**
 * Phase 2 многопроцессного dry-run (DEV-01, review m5, B3, N9): НОВЫЙ процесс, не разделяющий
 * память с Phase 1. Единственный канал между процессами — checkpoint-файл на диске.
 *
 * Вызывается дважды (см. `dry-run.ts`) с разным `expect`, чтобы доказать сразу два свойства B3:
 *  - `progressed`               — первый resume после wake ЧИТАЕТ checkpoint (`store.read`,
 *                                 ранее нигде не вызывавшийся вне собственных тестов) и
 *                                 выполняет next_exact_action ровно один раз, пройдя ветку
 *                                 `resetReached` (`now >= reported_reset_at`), а НЕ ветку
 *                                 `recovered` — m5.
 *  - `resume_already_completed` — повторный resume в ЕЩЁ ОДНОМ новом процессе видит
 *                                 персистентные маркеры `resume_attempted_at` И
 *                                 `resume_completed_at` (попытка ДОШЛА до конца) и отказывается
 *                                 выполнять действие повторно. Это отдельный, различимый исход
 *                                 от `resume_incomplete` (см. `dry-run-phase3.ts`) — N9.
 *
 * Использование: node dry-run-phase2.ts <checkpoint-store-root> <progressed|resume_already_completed>
 * Код возврата: 0 — фактический outcome совпал с ожидаемым и action выполнен ожидаемое число
 *               раз (1 для progressed, 0 для resume_already_completed); 1 — иначе.
 */
import { FileCheckpointStore } from '../file-checkpoint-store.ts';
import { resumeFromCheckpoint } from '../runner.ts';
import { PHASE2_NOW, TASK_ID, matchingRepoState, sample } from './dry-run-fixture.ts';
import type {
  ActionRunnerPort,
  ClockPort,
  UsageTelemetryPort,
  WakeSchedulerPort,
} from '../ports.ts';
import type { ContinuityOutcome } from '../types.ts';

const root = process.argv[2];
const expectArg = process.argv[3];
if (
  root === undefined ||
  (expectArg !== 'progressed' && expectArg !== 'resume_already_completed')
) {
  console.error(
    'usage: dry-run-phase2.ts <checkpoint-store-root> <progressed|resume_already_completed>',
  );
  process.exit(1);
}
const expect: ContinuityOutcome = expectArg;

const store = new FileCheckpointStore({ root });

// remaining остаётся низким (0.5%, НЕ recovered) — resume должен пройти именно через
// resetReached (PHASE2_NOW === reported_reset_at), а не через "телеметрия внезапно поправилась".
const telemetry: UsageTelemetryPort = { read: () => sample(0.5) };
const clock: ClockPort = { now: () => PHASE2_NOW };

const wakeCalls: { at: string; reason: string }[] = [];
const scheduler: WakeSchedulerPort = {
  scheduleWake: (at, reason) => {
    wakeCalls.push({ at, reason });
  },
};

const actionCalls: string[] = [];
const actions: ActionRunnerPort = {
  run: (actionId) => {
    actionCalls.push(actionId);
    return 'ok';
  },
};

try {
  const result = resumeFromCheckpoint({
    taskId: TASK_ID,
    store,
    telemetry,
    clock,
    actions,
    repoState: matchingRepoState(),
    scheduler,
  });

  const expectedActionCalls = expect === 'progressed' ? 1 : 0;
  const ok = result.outcome === expect && actionCalls.length === expectedActionCalls;

  console.log(
    JSON.stringify({
      phase: 2,
      expect,
      ok,
      outcome: result.outcome,
      finalState: result.finalState,
      actionResult: result.actionResult,
      actionCalls,
      resume_attempted_at: result.checkpoint.resume_attempted_at ?? null,
      resume_completed_at: result.checkpoint.resume_completed_at ?? null,
    }),
  );
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.log(
    JSON.stringify({
      phase: 2,
      expect,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
