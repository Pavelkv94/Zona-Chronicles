/**
 * apps/worker — process lifecycle skeleton (I00).
 *
 * There is no canonical scheduler logic here yet (that lands in I02B). This module only
 * demonstrates a correct start/stop lifecycle with graceful drain: once `stop()` is called the
 * worker stops claiming new work, waits for the currently in-flight step to finish, and only then
 * resolves. All time/timers are injected ports so tests never depend on wall clock.
 */

export type ClockPort = {
  readonly now: () => number;
};

export type SleepPort = {
  readonly sleep: (ms: number) => Promise<void>;
};

/** One unit of work. In I00 this is a caller-supplied placeholder; I02B replaces it with claim+execute. */
export type StepFn = () => Promise<void>;

export type WorkerLogger = {
  readonly info: (fields: Record<string, unknown>, msg: string) => void;
};

export type WorkerDeps = {
  readonly clock: ClockPort;
  readonly sleeper: SleepPort;
  readonly step: StepFn;
  readonly pollIntervalMs: number;
  readonly logger?: WorkerLogger;
};

export type Worker = {
  /** Begins the poll loop. No-op if already started. */
  readonly start: () => void;
  /** Signals the loop to stop, waits for any in-flight step to finish, then resolves. Idempotent. */
  readonly stop: () => Promise<void>;
};

export function createWorker(deps: WorkerDeps): Worker {
  let stopping = false;
  let started = false;
  let loopPromise: Promise<void> | null = null;

  async function runLoop(): Promise<void> {
    while (!stopping) {
      const startedAt = deps.clock.now();
      deps.logger?.info({ at: startedAt }, 'worker.step.start');
      await deps.step();
      deps.logger?.info({ at: deps.clock.now() }, 'worker.step.done');

      if (stopping) {
        break;
      }
      await deps.sleeper.sleep(deps.pollIntervalMs);
    }
  }

  function start(): void {
    if (started) {
      return;
    }
    started = true;
    stopping = false;
    loopPromise = runLoop();
  }

  async function stop(): Promise<void> {
    stopping = true;
    deps.logger?.info({ at: deps.clock.now() }, 'worker.stopping');
    if (loopPromise) {
      await loopPromise;
    }
  }

  return { start, stop };
}
