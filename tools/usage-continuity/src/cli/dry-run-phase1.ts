#!/usr/bin/env node
/**
 * Phase 1 двухпроцессного dry-run (DEV-01, review m5): ПЕРВЫЙ процесс.
 *
 * Доводит continuity loop до `waiting_for_usage_reset`, записывает checkpoint на диск и
 * завершается — как и должен вести себя реальный процесс, у которого кончилось пятичасовое
 * окно: не крутится в busy-wait (m1), а завершает текущий turn после того, как persisted wake
 * поставлен ровно один раз.
 *
 * Использование: node dry-run-phase1.ts <checkpoint-store-root>
 * Код возврата: 0 — outcome=waiting_for_reset, ровно один wake, ожидаемая последовательность
 *               переходов; 1 — иначе.
 */
import { FileCheckpointStore } from '../file-checkpoint-store.ts';
import { runContinuityLoop } from '../runner.ts';
import { PHASE1_NOW, buildSeedCheckpoint, sample } from './dry-run-fixture.ts';
import type { ClockPort, UsageTelemetryPort, WakeSchedulerPort } from '../ports.ts';

const root = process.argv[2];
if (root === undefined) {
  console.error('usage: dry-run-phase1.ts <checkpoint-store-root>');
  process.exit(1);
}

const seed = buildSeedCheckpoint();

// Телеметрия НИКОГДА не восстанавливается (нет sample с remaining > 2%) — единственный путь в
// waiting_for_usage_reset здесь через убывающий остаток, а не через "recovered".
const samples = [sample(5), sample(2), sample(0.5)];
let cursor = 0;
const telemetry: UsageTelemetryPort = {
  read: () => {
    const next = samples[Math.min(cursor, samples.length - 1)];
    cursor += 1;
    return next ?? null;
  },
};

const clock: ClockPort = { now: () => PHASE1_NOW };

const wakeCalls: { at: string; reason: string }[] = [];
const scheduler: WakeSchedulerPort = {
  scheduleWake: (at, reason) => {
    wakeCalls.push({ at, reason });
  },
};

const store = new FileCheckpointStore({ root });

const EXPECTED_TRANSITIONS = [
  'normal->checkpoint_only',
  'checkpoint_only->waiting_for_usage_reset',
];

try {
  const result = runContinuityLoop({
    telemetry,
    store,
    scheduler,
    clock,
    checkpointSeed: seed,
    maxIterations: 10,
  });

  const actualTransitions = result.transitions.map((t) => `${t.from}->${t.to}`);
  const sequenceMatches =
    actualTransitions.length === EXPECTED_TRANSITIONS.length &&
    actualTransitions.every((t, i) => t === EXPECTED_TRANSITIONS[i]);
  const ok =
    result.outcome === 'waiting_for_reset' &&
    result.finalState === 'waiting_for_usage_reset' &&
    wakeCalls.length === 1 &&
    sequenceMatches;

  console.log(
    JSON.stringify({
      phase: 1,
      ok,
      outcome: result.outcome,
      finalState: result.finalState,
      transitions: actualTransitions,
      wakeCalls,
    }),
  );
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.log(
    JSON.stringify({
      phase: 1,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
