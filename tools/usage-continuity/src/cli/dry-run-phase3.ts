#!/usr/bin/env node
/**
 * Phase 3 многопроцессного dry-run (DEV-01, N9): ветка "оборванный resume".
 *
 * До этого файла dry-run доказывал только happy path B3 (phase 1/2): resume, который либо ещё
 * не наступил, либо выполнился и завершился. Он не покрывал сценарий из N9 — процесс, который
 * упал МЕЖДУ записью `resume_attempted_at` и записью `resume_completed_at`. Именно этот разрыв
 * раньше был неотличим от успеха: повторный resume отдавал `resume_conflict`, а `dry-run.ts`
 * засчитывал это как `ok`.
 *
 * Вызывается дважды (см. `dry-run.ts`) с разным `mode`, на ОТДЕЛЬНОЙ задаче (`TASK_ID_CRASH`),
 * не пересекающейся с phase 1/2:
 *
 *  - `crash`            — процесс D: `resumeFromCheckpoint` доходит до записи
 *                          `resume_attempted_at` и запускает `next_exact_action`, но action
 *                          БРОСАЕТ исключение (симуляция падения процесса). Исключение НЕ
 *                          перехватывается внутри `resumeFromCheckpoint` — оно перехватывается
 *                          здесь, в CLI-обвязке, только чтобы проверить, что: (а) исключение
 *                          действительно дошло наверх (процесс не соврал бы про успех) и
 *                          (б) checkpoint на диске остался с `resume_attempted_at`, но БЕЗ
 *                          `resume_completed_at` — то есть оборванная попытка различима.
 *  - `incomplete-check`  — процесс E (ЕЩЁ ОДИН новый node, тот же checkpoint на диске):
 *                          `resumeFromCheckpoint` обязан вернуть `outcome: 'resume_incomplete'`
 *                          (НЕ `progressed`, НЕ успех) и НЕ должен запускать action повторно.
 *
 * Использование: node dry-run-phase3.ts <checkpoint-store-root> <crash|incomplete-check>
 * Код возврата: 0 — фактическое поведение совпало с ожидаемым для данного mode; 1 — иначе.
 */
import { FileCheckpointStore } from '../file-checkpoint-store.ts';
import { resumeFromCheckpoint } from '../runner.ts';
import {
  PHASE2_NOW,
  TASK_ID_CRASH,
  buildCrashSeedCheckpoint,
  matchingRepoState,
  sample,
} from './dry-run-fixture.ts';
import type {
  ActionRunnerPort,
  ClockPort,
  UsageTelemetryPort,
  WakeSchedulerPort,
} from '../ports.ts';

const root = process.argv[2];
const mode = process.argv[3];
if (root === undefined || (mode !== 'crash' && mode !== 'incomplete-check')) {
  console.error('usage: dry-run-phase3.ts <checkpoint-store-root> <crash|incomplete-check>');
  process.exit(1);
}

const store = new FileCheckpointStore({ root });
const telemetry: UsageTelemetryPort = { read: () => sample(0.5) };
const clock: ClockPort = { now: () => PHASE2_NOW };
const wakeCalls: { at: string; reason: string }[] = [];
const scheduler: WakeSchedulerPort = {
  scheduleWake: (at, reason) => {
    wakeCalls.push({ at, reason });
  },
};
const actionCalls: string[] = [];

if (mode === 'crash') {
  // Эта задача ещё не существует на диске — записываем её seed напрямую (эквивалент
  // "phase 1 для этой задачи уже отработал"), затем СРАЗУ переходим к resume с action, который
  // бросает исключение после того, как resume_attempted_at уже записан.
  store.write(buildCrashSeedCheckpoint());

  const crashingActions: ActionRunnerPort = {
    run: (actionId) => {
      actionCalls.push(actionId);
      throw new Error('dry-run: simulated crash mid-action (N9)');
    },
  };

  let threw = false;
  let errorMessage = '';
  try {
    resumeFromCheckpoint({
      taskId: TASK_ID_CRASH,
      store,
      telemetry,
      clock,
      actions: crashingActions,
      repoState: matchingRepoState(),
      scheduler,
    });
  } catch (error) {
    threw = true;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const onDisk = store.read(TASK_ID_CRASH);
  const attemptedRecorded = onDisk?.resume_attempted_at !== undefined;
  const completedNotRecorded = onDisk?.resume_completed_at === undefined;
  const ok = threw && actionCalls.length === 1 && attemptedRecorded && completedNotRecorded;

  console.log(
    JSON.stringify({
      phase: 3,
      mode,
      ok,
      threw,
      errorMessage,
      actionCalls,
      resume_attempted_at: onDisk?.resume_attempted_at ?? null,
      resume_completed_at: onDisk?.resume_completed_at ?? null,
    }),
  );
  process.exit(ok ? 0 : 1);
}

// mode === 'incomplete-check': НОВЫЙ процесс, тот же checkpoint на диске после падения выше.
const postCrashActions: ActionRunnerPort = {
  run: (actionId) => {
    actionCalls.push(actionId);
    return 'ok';
  },
};

try {
  const result = resumeFromCheckpoint({
    taskId: TASK_ID_CRASH,
    store,
    telemetry,
    clock,
    actions: postCrashActions,
    repoState: matchingRepoState(),
    scheduler,
  });

  const ok =
    result.outcome === 'resume_incomplete' &&
    result.finalState === 'validating_resume' &&
    result.actionResult === null &&
    actionCalls.length === 0;

  console.log(
    JSON.stringify({
      phase: 3,
      mode,
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
      phase: 3,
      mode,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
