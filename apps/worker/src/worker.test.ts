import { describe, expect, it, vi } from 'vitest';
import { createWorker } from './worker.ts';
import { shouldReportProjectionFailure } from './projection-failure-reporting.ts';

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

/**
 * Sleeper, отдающий управление МАКРОЗАДАЧАМ.
 *
 * `instantSleeper` возвращает `Promise.resolve()`, то есть микрозадачу: цикл `while` с таким
 * sleeper-ом крутится, не выпуская event loop, и `setTimeout` в тесте не срабатывает НИКОГДА —
 * тест не падает, а виснет. Проверено: первая редакция тестов ниже висела 600 секунд.
 */
function yieldingSleeper(): { sleep: (ms: number) => Promise<void> } {
  return { sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)) };
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

  /**
   * M1 независимого архитектурного аудита I03, воспроизведён исполнением.
   *
   * Отказ ОДНОГО шага не имеет права уносить весь цикл в тишину. До этой правки `runLoop` не имел
   * ни одного `catch`, а `start()` не вешал `.catch` на `loopPromise`: любая ошибка шага
   * становилась unhandled rejection УЖЕ ПОСЛЕ возврата `main()`, то есть мимо внешнего
   * `main().catch(...)`, и мир просто останавливался молча.
   *
   * Проверено на живом мире: worker с исправным `DATABASE_URL` и НЕСУЩЕСТВУЮЩЕЙ базой проекции
   * переставал двигать канонический мир — событий через 12 секунд ровно столько, сколько было до
   * запуска.
   */
  it('отказ шага назван и не убивает цикл', async () => {
    const failures: unknown[] = [];
    let calls = 0;
    const worker = createWorker({
      clock: fakeClock(),
      sleeper: yieldingSleeper(),
      pollIntervalMs: 0,
      step: async () => {
        calls += 1;
        if (calls === 1) throw new Error('шаг упал');
        return await Promise.resolve();
      },
      onStepError: (error) => {
        failures.push(error);
      },
    });

    worker.start();
    while (calls < 3) await new Promise((resolve) => setTimeout(resolve, 1));
    await worker.stop();

    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain('шаг упал');
    // Цикл ЖИВ: шаги продолжились. Иначе «мир идёт непрерывно» (PR-04) держалось бы на
    // отсутствии ошибок, а не на устройстве.
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('без обработчика отказ шага тоже не роняет цикл и не оставляет unhandled rejection', async () => {
    let calls = 0;
    const worker = createWorker({
      clock: fakeClock(),
      sleeper: yieldingSleeper(),
      pollIntervalMs: 0,
      step: async () => {
        calls += 1;
        if (calls === 1) throw new Error('без обработчика');
        return await Promise.resolve();
      },
    });

    worker.start();
    while (calls < 3) await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(worker.stop()).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  /**
   * Убывающая частота жалоб — свойство, а не украшение: лежащая база не должна превращать журнал
   * в поток одинаковых строк, но и замолчать не имеет права. Ревьюер заметил, что счётчик
   * отказов только логировался и ни на что не влиял; проверяем, что теперь влияет и что
   * молчания не наступает НИКОГДА.
   */
  it('частота жалоб на отказ убывает, но жалоба не смолкает', () => {
    const reported: number[] = [];
    for (let consecutive = 1; consecutive <= 1000; consecutive += 1) {
      if (shouldReportProjectionFailure(consecutive)) reported.push(consecutive);
    }

    expect(reported.slice(0, 5)).toEqual([1, 2, 4, 8, 16]);
    // Разрежается, но не исчезает: на тысяче отказов сообщений заметно меньше сотни и больше нуля.
    expect(reported.length).toBeGreaterThan(10);
    expect(reported.length).toBeLessThan(40);
    expect(reported.at(-1)).toBeGreaterThan(900);
  });
});
