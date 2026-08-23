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
  /**
   * Что делать с отказом шага. Вызывается вместо того, чтобы уронить цикл.
   *
   * Необязателен НАМЕРЕННО, и умолчание — не «проглотить»: без обработчика цикл всё равно
   * продолжается, а отказ уходит в `logger.info` с полем `error`. Обязательный параметр заставил
   * бы каждый вызов придумывать обработчик, и первый же придумал бы пустой.
   */
  readonly onStepError?: (error: unknown) => void;
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

  /**
   * M1 независимого архитектурного аудита I03: отказ ОДНОГО шага не имеет права уносить цикл.
   *
   * До этой правки здесь не было ни одного `catch`. Отказ `deps.step()` выходил из `runLoop`,
   * а `start()` не вешал `.catch` на `loopPromise` — то есть становился unhandled rejection УЖЕ
   * ПОСЛЕ возврата `main()` и проходил мимо внешнего `main().catch(...)`. Мир останавливался
   * МОЛЧА, и это воспроизведено на живом мире: worker с исправным `DATABASE_URL` и
   * несуществующей базой проекции переставал двигать канонический мир вовсе.
   *
   * Почему цикл продолжается, а не останавливается на отказе. Шаг — это опрос, а не транзакция:
   * канонические записи атомарны сами по себе (`command-handler.ts`), и неудавшийся шаг не
   * оставляет полузаписи. Отказ здесь означает «в этот раз не получилось» — недоступная база,
   * потерянный advisory lock, упавшая проекция. Остановка мира по такому поводу превращает
   * временную неполадку в постоянную и требует человека там, где достаточно следующей секунды.
   *
   * Молчание при этом запрещено: отказ обязан быть НАЗВАН — через `onStepError`, если он задан,
   * и в лог в любом случае.
   */
  async function runLoop(): Promise<void> {
    while (!stopping) {
      const startedAt = deps.clock.now();
      deps.logger?.info({ at: startedAt }, 'worker.step.start');
      try {
        await deps.step();
        deps.logger?.info({ at: deps.clock.now() }, 'worker.step.done');
      } catch (error) {
        deps.logger?.info({ at: deps.clock.now(), error: String(error) }, 'worker.step.failed');
        deps.onStepError?.(error);
      }

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
    // `.catch` здесь — второй слой, а не дубль: `runLoop` уже ловит отказы шага, но отказать
    // может и он сам (например `deps.sleeper.sleep`). Без этого такой отказ снова стал бы
    // unhandled rejection после возврата `main()`.
    loopPromise = runLoop().catch((error: unknown) => {
      deps.logger?.info({ error: String(error) }, 'worker.loop.failed');
      deps.onStepError?.(error);
    });
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
