/**
 * Continuity runner пятичасового usage window (DEV-01).
 * Оркестрирует state machine поверх инъектированных портов: не вызывает telemetry/scheduler/
 * action runner напрямую из production-кода, только через переданные аргументы.
 *
 * Разделение на два входа — намеренное (review finding B3):
 * - `runContinuityLoop` — цикл текущего процесса: normal -> checkpoint_only -> (пауза).
 *   Он никогда не выполняет `next_exact_action` и не пересекает границу процесса.
 * - `resumeFromCheckpoint` — отдельная точка входа НОВОГО процесса, который проснулся по
 *   persisted wake: читает checkpoint с диска, сверяет repo state и выполняет
 *   `next_exact_action` ровно один раз с персистентным маркером идемпотентности.
 *
 * Старый однопроцессный дизайн (весь путь normal -> in_progress внутри одного вызова) не
 * соответствовал реальному сценарию DEV-01, где wake поднимает новый процесс без общей памяти
 * с тем, что делал прежний.
 */
import { addMinutes, requireInstant } from './instant.ts';
import { nextState } from './state-machine.ts';
import type {
  ActionRunnerPort,
  CheckpointStorePort,
  ClockPort,
  RepoStatePort,
  UsageTelemetryPort,
  WakeSchedulerPort,
} from './ports.ts';
import { LIMIT_AUTOCONTINUE_UNAVAILABLE } from './types.ts';
import type { Checkpoint, ContinuityOutcome, ContinuityState } from './types.ts';

const DEFAULT_SAFETY_MARGIN_MINUTES = 5;

export interface RunContinuityLoopInput {
  readonly telemetry: UsageTelemetryPort;
  readonly store: CheckpointStorePort;
  readonly scheduler: WakeSchedulerPort;
  readonly clock: ClockPort;
  readonly checkpointSeed: Checkpoint;
  /** Верхняя граница итераций — гарантирует конечность цикла, пока состояние остаётся normal/checkpoint_only. */
  readonly maxIterations: number;
  /** Отступ persisted wake после reported_reset_at. По умолчанию 5 минут. */
  readonly safetyMarginMinutes?: number;
}

export interface StateTransition {
  readonly from: ContinuityState;
  readonly to: ContinuityState;
  readonly at: string;
  readonly remaining_percent: number;
}

export interface RunContinuityLoopResult {
  readonly outcome: Extract<ContinuityOutcome, 'waiting_for_reset' | 'capability_unavailable'>;
  readonly transitions: readonly StateTransition[];
  readonly finalState: ContinuityState;
  readonly checkpoint: Checkpoint;
}

/** Записывает свежий telemetry-сэмпл в checkpoint без потери остальных полей. */
function withSample(
  checkpoint: Checkpoint,
  remaining_percent: number,
  reported_reset_at: string,
  checkpointed_at: string,
): Checkpoint {
  return {
    ...checkpoint,
    usage_window_remaining_percent: remaining_percent,
    reported_reset_at,
    checkpointed_at,
  };
}

/** ISO-8601 арифметика над уже валидированным (`requireInstant`) временем. */
function addMinutesToIso(iso: string, minutes: number, sourceLabel: string): string {
  return addMinutes(requireInstant(iso, sourceLabel), minutes).iso;
}

/**
 * Основной цикл continuity harness текущего процесса (ACCEPTANCE A7, A8; review m1, m2, m3).
 *
 * Гарантии:
 * - checkpoint_only не запускает никакой action, только пишет checkpoint;
 * - при входе в waiting_for_usage_reset wake ставится РОВНО ОДИН РАЗ, checkpoint пишется и
 *   цикл немедленно возвращает управление — без busy-wait и без дублей wake (m1);
 * - `telemetry.read() === null` даёт явный `outcome: 'capability_unavailable'`, отличимый от
 *   прогресса не по форме значения, а по дискриминатору (m2);
 * - невалидная ISO-метка времени — явная ошибка конфигурации, а не тихое "ещё не наступило" (m3);
 * - maxIterations гарантирует конечность цикла, пока состояние остаётся normal/checkpoint_only.
 *
 * Этот цикл НИКОГДА не достигает `validating_resume`/`in_progress` и не выполняет
 * `next_exact_action` — это исключительно ответственность `resumeFromCheckpoint` (B3).
 */
export function runContinuityLoop(input: RunContinuityLoopInput): RunContinuityLoopResult {
  const transitions: StateTransition[] = [];
  let state: ContinuityState = 'normal';
  let checkpoint = input.checkpointSeed;

  for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
    const sample = input.telemetry.read();
    if (sample === null) {
      // Телеметрия недоступна на этой итерации: капитулируем без ложных обещаний прогресса.
      const now = requireInstant(input.clock.now(), 'ClockPort.now()');
      checkpoint = {
        ...checkpoint,
        checkpointed_at: now.iso,
        capability_status: LIMIT_AUTOCONTINUE_UNAVAILABLE,
      };
      input.store.write(checkpoint);
      return { outcome: 'capability_unavailable', transitions, finalState: state, checkpoint };
    }

    const now = requireInstant(input.clock.now(), 'ClockPort.now()');
    requireInstant(sample.reported_reset_at, 'reported_reset_at');
    checkpoint = withSample(
      checkpoint,
      sample.remaining_percent,
      sample.reported_reset_at,
      now.iso,
    );

    const proposed = nextState(state, sample, now.iso);
    if (proposed !== state) {
      transitions.push({
        from: state,
        to: proposed,
        at: now.iso,
        remaining_percent: sample.remaining_percent,
      });
      state = proposed;
    }

    if (state === 'checkpoint_only') {
      input.store.write(checkpoint);
      continue;
    }

    if (state === 'waiting_for_usage_reset') {
      input.store.write(checkpoint);
      // Ровно один wake на эту паузу (m1): цикл завершает текущий turn здесь и не крутится
      // дальше, ожидая следующего сэмпла. Возобновление — задача отдельного процесса
      // (resumeFromCheckpoint) после реального wake.
      const safetyMarginMinutes = input.safetyMarginMinutes ?? DEFAULT_SAFETY_MARGIN_MINUTES;
      input.scheduler.scheduleWake(
        addMinutesToIso(sample.reported_reset_at, safetyMarginMinutes, 'reported_reset_at'),
        `resume ${checkpoint.task_id}`,
      );
      return { outcome: 'waiting_for_reset', transitions, finalState: state, checkpoint };
    }

    // state === 'normal': продолжаем поллинг, продолжая счётчик итераций.
  }

  throw new Error(
    `continuity loop exceeded maxIterations=${String(input.maxIterations)} without pausing (finalState="${state}")`,
  );
}

export interface ResumeFromCheckpointInput {
  readonly taskId: string;
  readonly store: CheckpointStorePort;
  readonly telemetry: UsageTelemetryPort;
  readonly clock: ClockPort;
  readonly actions: ActionRunnerPort;
  readonly repoState: RepoStatePort;
  readonly scheduler: WakeSchedulerPort;
  readonly safetyMarginMinutes?: number;
}

export interface ResumeFromCheckpointResult {
  readonly outcome: ContinuityOutcome;
  readonly finalState: ContinuityState;
  readonly checkpoint: Checkpoint;
  readonly actionResult: 'ok' | 'failed' | null;
}

function arraysEqualAsSets(a: readonly string[], b: readonly string[]): boolean {
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return (
    sortedA.length === sortedB.length && sortedA.every((value, index) => value === sortedB[index])
  );
}

/**
 * Сверяет checkpoint с фактическим repo state перед возобновлением работы (m4): branch, HEAD,
 * worktree, `git diff` (dirty_files) и живые процессы (unfinished_processes) — не только
 * branch/head_sha, как было раньше.
 */
function collectResumeMismatches(checkpoint: Checkpoint, repoState: RepoStatePort): string[] {
  const mismatches: string[] = [];

  const actualBranch = repoState.branch();
  if (actualBranch !== checkpoint.branch) {
    mismatches.push(`branch: checkpoint="${checkpoint.branch}" actual="${actualBranch}"`);
  }

  const actualHeadSha = repoState.headSha();
  if (actualHeadSha !== checkpoint.head_sha) {
    mismatches.push(`head_sha: checkpoint="${checkpoint.head_sha}" actual="${actualHeadSha}"`);
  }

  const actualWorktree = repoState.worktree();
  if (actualWorktree !== checkpoint.worktree) {
    mismatches.push(`worktree: checkpoint="${checkpoint.worktree}" actual="${actualWorktree}"`);
  }

  const actualChangedFiles = repoState.changedFiles();
  if (!arraysEqualAsSets(actualChangedFiles, checkpoint.dirty_files)) {
    mismatches.push(
      `dirty_files (git diff): checkpoint=${JSON.stringify([...checkpoint.dirty_files].sort())} actual=${JSON.stringify(
        [...actualChangedFiles].sort(),
      )}`,
    );
  }

  const actualLivingProcesses = repoState.livingProcesses();
  if (!arraysEqualAsSets(actualLivingProcesses, checkpoint.unfinished_processes)) {
    mismatches.push(
      `unfinished_processes: checkpoint=${JSON.stringify(
        [...checkpoint.unfinished_processes].sort(),
      )} actual=${JSON.stringify([...actualLivingProcesses].sort())}`,
    );
  }

  return mismatches;
}

/**
 * Точка входа НОВОГО процесса, возобновляющего задачу по persisted wake (B3).
 *
 * 1. `store.read(taskId)` — отсутствие checkpoint это явная ошибка (бросает Error), а не
 *    тихий старт с нуля.
 * 2. Если попытка resume уже отмечена (`resume_attempted_at` присутствует) — действие НЕ
 *    выполняется повторно, возвращается `outcome: 'resume_conflict'` (идемпотентность п.3).
 * 3. Если телеметрия ещё не подтверждает reset (ни `now >= reported_reset_at`, ни recovered) —
 *    resume откладывается: wake переставляется, `outcome: 'waiting_for_reset'`, action не
 *    запускается.
 * 4. `validating_resume`: сверка repo state (m4). При расхождении — обновлённый checkpoint с
 *    описанием расхождения пишется В STORE ДО throw (evidence не теряется), только потом Error.
 * 5. При совпадении: `resume_attempted_at` пишется в checkpoint ДО запуска действия — это и есть
 *    персистентный маркер идемпотентности, переживающий падение процесса между wake и
 *    завершением действия.
 * 6. `store.archive(taskId)` НЕ вызывается здесь — только после подтверждённого внешним
 *    verify устойчивого Green, см. `archiveResumedCheckpoint`.
 */
export function resumeFromCheckpoint(input: ResumeFromCheckpointInput): ResumeFromCheckpointResult {
  const safetyMarginMinutes = input.safetyMarginMinutes ?? DEFAULT_SAFETY_MARGIN_MINUTES;
  const stored = input.store.read(input.taskId);
  if (stored === null) {
    throw new Error(
      `resumeFromCheckpoint: checkpoint "${input.taskId}" не найден — resume без checkpoint запрещён (B3)`,
    );
  }
  if (stored.task_id !== input.taskId) {
    throw new Error(
      `resumeFromCheckpoint: checkpoint.task_id="${stored.task_id}" не совпадает с запрошенным taskId="${input.taskId}" (ownership)`,
    );
  }

  if (stored.resume_attempted_at !== undefined) {
    return {
      outcome: 'resume_conflict',
      finalState: 'validating_resume',
      checkpoint: stored,
      actionResult: null,
    };
  }

  const sample = input.telemetry.read();
  const now = requireInstant(input.clock.now(), 'ClockPort.now()');

  if (sample === null) {
    const updated: Checkpoint = {
      ...stored,
      checkpointed_at: now.iso,
      capability_status: LIMIT_AUTOCONTINUE_UNAVAILABLE,
    };
    input.store.write(updated);
    return {
      outcome: 'capability_unavailable',
      finalState: 'waiting_for_usage_reset',
      checkpoint: updated,
      actionResult: null,
    };
  }
  requireInstant(sample.reported_reset_at, 'reported_reset_at');

  const withTelemetry = withSample(
    stored,
    sample.remaining_percent,
    sample.reported_reset_at,
    now.iso,
  );
  const proposed = nextState('waiting_for_usage_reset', sample, now.iso);

  if (proposed === 'waiting_for_usage_reset') {
    // Проснулись раньше времени (или telemetry ещё не восстановилась): не выполняем действие,
    // переставляем wake ровно один раз и возвращаем управление.
    input.store.write(withTelemetry);
    input.scheduler.scheduleWake(
      addMinutesToIso(sample.reported_reset_at, safetyMarginMinutes, 'reported_reset_at'),
      `resume ${withTelemetry.task_id}`,
    );
    return {
      outcome: 'waiting_for_reset',
      finalState: 'waiting_for_usage_reset',
      checkpoint: withTelemetry,
      actionResult: null,
    };
  }

  // proposed === 'validating_resume'
  const mismatches = collectResumeMismatches(withTelemetry, input.repoState);
  if (mismatches.length > 0) {
    const withError: Checkpoint = {
      ...withTelemetry,
      last_resume_validation_error: mismatches.join('; '),
    };
    // Evidence пишется ДО throw (m4) — иначе расхождение теряется вместе с исключением.
    input.store.write(withError);
    throw new Error(
      `resume validation failed: repo state diverged from checkpoint "${withTelemetry.task_id}" (${mismatches.join('; ')})`,
    );
  }

  // Персистентный маркер идемпотентности пишется ДО запуска действия (B3 п.3): падение
  // процесса между этой записью и завершением action не приведёт к повторному запуску при
  // следующем wake — следующий вызов resumeFromCheckpoint увидит resume_attempted_at и
  // откажется выполнять действие повторно (outcome: 'resume_conflict').
  const marked: Checkpoint = { ...withTelemetry, resume_attempted_at: now.iso };
  input.store.write(marked);

  const actionResult = input.actions.run(marked.next_exact_action);
  return { outcome: 'progressed', finalState: 'in_progress', checkpoint: marked, actionResult };
}

/**
 * Архивирует checkpoint ПОСЛЕ подтверждённого внешним verify устойчивого Green — не сразу
 * после того, как `actions.run()` вернул `'ok'` (B3 п.4: одно успешное действие — не то же
 * самое, что "устойчивый Green" всего plan_status). Вызывающий явно решает, когда green
 * достаточно устойчив (например после полного `pnpm verify`), и вызывает эту функцию отдельно.
 */
export function archiveResumedCheckpoint(taskId: string, store: CheckpointStorePort): void {
  store.archive(taskId);
}
