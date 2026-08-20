import { describe, expect, it, vi } from 'vitest';
import { createWorker } from './worker.ts';

/** Deferred promise helper so a test can control exactly when an in-flight step resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeClock(): { now: () => number } {
  return { now: () => 0 };
}

function instantSleeper(): { sleep: (ms: number) => Promise<void> } {
  return { sleep: () => Promise.resolve() };
}

describe('createWorker', () => {
  it('stop() waits for an in-flight step to finish before resolving, and does not lose it', async () => {
    const step1 = deferred<void>();
    let completedSteps = 0;
    const stepCalls: number[] = [];
    let call = 0;

    const worker = createWorker({
      clock: fakeClock(),
      sleeper: instantSleeper(),
      pollIntervalMs: 10,
      step: async () => {
        call += 1;
        stepCalls.push(call);
        if (call === 1) {
          await step1.promise;
        }
        completedSteps += 1;
      },
    });

    worker.start();
    // Let the loop enter the first step and start awaiting step1.promise.
    await Promise.resolve();
    await Promise.resolve();

    const stopPromise = worker.stop();
    // stop() must not resolve while the first step is still in flight.
    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(completedSteps).toBe(0);

    step1.resolve();
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(completedSteps).toBe(1);
    // Exactly one step ran — stop() did not allow a second step to start.
    expect(stepCalls).toEqual([1]);
  });

  it('stop() is idempotent', async () => {
    const worker = createWorker({
      clock: fakeClock(),
      sleeper: instantSleeper(),
      pollIntervalMs: 10,
      step: async () => {},
    });

    worker.start();
    await worker.stop();
    await expect(worker.stop()).resolves.toBeUndefined();
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it('does not start new steps after stop()', async () => {
    const step = vi.fn(async () => {});
    const worker = createWorker({
      clock: fakeClock(),
      sleeper: instantSleeper(),
      pollIntervalMs: 10,
      step,
    });

    worker.start();
    await Promise.resolve();
    await Promise.resolve();
    await worker.stop();

    const callsAtStop = step.mock.calls.length;
    expect(callsAtStop).toBeGreaterThan(0);

    // Give the loop several more microtask/timer turns; no further steps should start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(step.mock.calls.length).toBe(callsAtStop);
  });

  it('calling stop() before start() resolves without running any step', async () => {
    const step = vi.fn(async () => {});
    const worker = createWorker({
      clock: fakeClock(),
      sleeper: instantSleeper(),
      pollIntervalMs: 10,
      step,
    });

    await worker.stop();
    expect(step).not.toHaveBeenCalled();
  });
});
