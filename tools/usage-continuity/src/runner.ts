/**
 * Continuity runner пятичасового usage window (DEV-01).
 * Оркестрирует state machine поверх инъектированных портов: не вызывает telemetry/scheduler/
 * action runner напрямую из production-кода, только через переданные аргументы.
 */
import { nextState } from './state-machine.ts';
import type {
  ActionRunnerPort,
  CheckpointStorePort,
  ClockPort,
  RepoStatePort,
  UsageTelemetryPort,
  WakeSchedulerPort,
} from './ports.ts';
import type { Checkpoint, ContinuityState } from './types.ts';

const DEFAULT_SAFETY_MARGIN_MINUTES = 5;

export interface RunContinuityLoopInput {
  readonly telemetry: UsageTelemetryPort;
  readonly store: CheckpointStorePort;
  readonly scheduler: WakeSchedulerPort;
  readonly clock: ClockPort;
  readonly actions: ActionRunnerPort;
  /** Сверка checkpoint c фактическим repo state перед resume (обязательна для validating_resume). */
  readonly repoState: RepoStatePort;
  readonly checkpointSeed: Checkpoint;
  /** Верхняя граница итераций — гарантирует конечность цикла ожидания. */
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
  readonly transitions: readonly StateTransition[];
  readonly finalState: ContinuityState;
  readonly checkpoint: Checkpoint;
  readonly actionResult: 'ok' | 'failed' | null;
}

/** ISO-8601 арифметика над инъектированными метками времени — не читает wall clock. */
function addMinutesToIso(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

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

/**
 * Сверяет checkpoint с фактическим repo state перед возобновлением работы.
 * Расхождение — явная ошибка, а не тихое продолжение (ACCEPTANCE A8).
 */
function validateResume(checkpoint: Checkpoint, repoState: RepoStatePort): void {
  const actualBranch = repoState.branch();
  const actualHeadSha = repoState.headSha();
  const mismatches: string[] = [];
  if (actualBranch !== checkpoint.branch) {
    mismatches.push(`branch: checkpoint="${checkpoint.branch}" actual="${actualBranch}"`);
  }
  if (actualHeadSha !== checkpoint.head_sha) {
    mismatches.push(`head_sha: checkpoint="${checkpoint.head_sha}" actual="${actualHeadSha}"`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `resume validation failed: repo state diverged from checkpoint "${checkpoint.task_id}" (${mismatches.join('; ')})`,
    );
  }
}

/**
 * Основной цикл continuity harness. Гарантии (ACCEPTANCE A7-A9):
 * - checkpoint_only не запускает новый action, только пишет checkpoint;
 * - waiting_for_usage_reset не вызывает actions.run вообще, но ставит persisted wake;
 * - next_exact_action выполняется ровно один раз после подтверждённого resume;
 * - validating_resume сверяет repo state и явно падает при расхождении;
 * - maxIterations гарантирует конечность цикла.
 */
export function runContinuityLoop(input: RunContinuityLoopInput): RunContinuityLoopResult {
  const safetyMarginMinutes = input.safetyMarginMinutes ?? DEFAULT_SAFETY_MARGIN_MINUTES;
  const transitions: StateTransition[] = [];
  let state: ContinuityState = 'normal';
  let checkpoint = input.checkpointSeed;

  for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
    const sample = input.telemetry.read();
    if (sample === null) {
      // Телеметрия недоступна на этой итерации: капитулируем без ложных обещаний прогресса.
      const now = input.clock.now();
      checkpoint = {
        ...checkpoint,
        checkpointed_at: now,
        capability_status: 'LIMIT_AUTOCONTINUE_UNAVAILABLE',
      };
      input.store.write(checkpoint);
      return { transitions, finalState: state, checkpoint, actionResult: null };
    }

    const now = input.clock.now();
    checkpoint = withSample(checkpoint, sample.remaining_percent, sample.reported_reset_at, now);

    let proposed = nextState(state, sample, now);
    if (proposed !== state) {
      transitions.push({
        from: state,
        to: proposed,
        at: now,
        remaining_percent: sample.remaining_percent,
      });
      state = proposed;
    }

    if (state === 'validating_resume') {
      validateResume(checkpoint, input.repoState);
      // Переход validating_resume -> in_progress безусловен и не требует нового telemetry-сэмпла.
      proposed = nextState(state, sample, now);
      transitions.push({
        from: state,
        to: proposed,
        at: now,
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
      input.scheduler.scheduleWake(
        addMinutesToIso(sample.reported_reset_at, safetyMarginMinutes),
        `resume ${checkpoint.task_id}`,
      );
      continue;
    }

    if (state === 'in_progress') {
      // Цикл всегда возвращается сразу же по достижении in_progress (см. ниже), поэтому эта
      // ветка не может выполниться дважды за один вызов runContinuityLoop — next_exact_action
      // не дублируется структурно, без отдельного флага.
      const actionResult = input.actions.run(checkpoint.next_exact_action);
      return { transitions, finalState: state, checkpoint, actionResult };
    }

    // state === 'normal': продолжаем поллинг, продолжая счётчик итераций.
  }

  throw new Error(
    `continuity loop exceeded maxIterations=${String(input.maxIterations)} without resolving to in_progress (finalState="${state}")`,
  );
}
