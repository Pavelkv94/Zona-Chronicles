#!/usr/bin/env node
/**
 * Двухпроцессный dry-run continuity harness (DEV-01, review finding B3, m5).
 *
 * Прежняя версия проходила весь путь `normal -> in_progress` внутри ОДНОГО вызова
 * `runContinuityLoop` — это не соответствовало реальному сценарию DEV-01, где внешний runner
 * просыпается по persisted wake и запускает НОВЫЙ процесс, который обязан загрузить checkpoint
 * с диска и продолжить. Этот скрипт демонстрирует именно межпроцессный сценарий:
 *
 *   Phase 1 (`node dry-run-phase1.ts`)  — процесс A: normal -> checkpoint_only ->
 *                                          waiting_for_usage_reset, wake ставится один раз,
 *                                          checkpoint пишется на диск, процесс завершается.
 *   Phase 2a (`node dry-run-phase2.ts`) — процесс B (НОВЫЙ, отдельный `node`, никакой общей
 *                                          памяти с A): resumeFromCheckpoint читает checkpoint
 *                                          с диска, проходит validating_resume и выполняет
 *                                          next_exact_action РОВНО ОДИН РАЗ. Ветка reset —
 *                                          через `resetReached` (`now >= reported_reset_at`),
 *                                          а не через "телеметрия внезапно поправилась" (m5).
 *   Phase 2b (`node dry-run-phase2.ts`) — процесс C (ЕЩЁ ОДИН новый процесс, тот же checkpoint
 *                                          на диске): resumeFromCheckpoint видит персистентный
 *                                          маркер resume_attempted_at из B и отказывается
 *                                          выполнять действие повторно (`resume_conflict`).
 *
 * Единственный канал между процессами — файл checkpoint на диске (`FileCheckpointStore`),
 * ровно как это будет работать в проде между "session закончилась" и "session возобновилась".
 *
 * Использование: node tools/usage-continuity/src/cli/dry-run.ts
 * Код возврата: 0 — все три фазы прошли ожидаемый outcome и next_exact_action выполнен ровно
 *               один раз суммарно между Phase 2a и Phase 2b; 1 — нарушение любого рода.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const phase1Path = join(here, 'dry-run-phase1.ts');
const phase2Path = join(here, 'dry-run-phase2.ts');

interface PhaseRun {
  readonly label: string;
  readonly ok: boolean;
  readonly status: number | null;
  readonly json: Record<string, unknown> | null;
}

function runPhase(label: string, scriptPath: string, args: readonly string[]): PhaseRun {
  console.log(`--- ${label} ---`);
  console.log(`  $ node ${scriptPath} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (stdout.length > 0) {
    console.log(
      stdout
        .trimEnd()
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
  }
  if (stderr.length > 0) {
    console.error(
      stderr
        .trimEnd()
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
  }

  const lastLine = stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .pop();
  let json: Record<string, unknown> | null = null;
  if (lastLine !== undefined) {
    try {
      const parsed: unknown = JSON.parse(lastLine);
      if (typeof parsed === 'object' && parsed !== null) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      json = null;
    }
  }

  const ok = result.status === 0 && json?.['ok'] === true;
  console.log(`  exit=${String(result.status)} ok=${String(ok)}`);
  console.log('');
  return { label, ok, status: result.status, json };
}

const storeRoot = mkdtempSync(join(tmpdir(), 'usage-continuity-dry-run-'));
console.log(`Checkpoint store root (общий для всех процессов): ${storeRoot}`);
console.log('');

const phase1 = runPhase(
  'Phase 1 [процесс A]: normal -> checkpoint_only -> waiting_for_usage_reset, wake x1, пауза',
  phase1Path,
  [storeRoot],
);

const phase2a = runPhase(
  'Phase 2a [процесс B, НОВЫЙ node]: resumeFromCheckpoint -> validating_resume -> in_progress, action x1',
  phase2Path,
  [storeRoot, 'progressed'],
);

const phase2b = runPhase(
  'Phase 2b [процесс C, ЕЩЁ ОДИН новый node]: повторный resumeFromCheckpoint -> resume_conflict, action x0',
  phase2Path,
  [storeRoot, 'resume_conflict'],
);

const totalActionRuns =
  (Array.isArray(phase2a.json?.['actionCalls']) ? phase2a.json['actionCalls'].length : -1) +
  (Array.isArray(phase2b.json?.['actionCalls']) ? phase2b.json['actionCalls'].length : -1);

const allOk = phase1.ok && phase2a.ok && phase2b.ok && totalActionRuns === 1;

console.log('Итог двухпроцессного dry-run continuity harness:');
console.log(
  `  ${phase1.ok ? 'OK  ' : 'FAIL'} Phase 1: waiting_for_usage_reset, wake ровно один раз`,
);
console.log(
  `  ${phase2a.ok ? 'OK  ' : 'FAIL'} Phase 2a: resume в новом процессе -> in_progress, action выполнен`,
);
console.log(
  `  ${phase2b.ok ? 'OK  ' : 'FAIL'} Phase 2b: повторный resume в новом процессе -> resume_conflict, без дублирования`,
);
console.log(
  `  next_exact_action выполнен суммарно между Phase 2a/2b: ${String(totalActionRuns)} раз(а) (ожидается 1)`,
);

if (!allOk) {
  console.error(
    'FAIL: двухпроцессный dry-run continuity sequence не подтверждает межпроцессный resume (B3).',
  );
  process.exit(1);
}

console.log(
  'OK: resume пережил границу процесса через checkpoint на диске, wake поставлен один раз,' +
    ' next_exact_action выполнен ровно один раз, повторный resume не дублирует действие.',
);
process.exit(0);
