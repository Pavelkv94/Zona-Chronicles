/**
 * Шаг worker-а: довести мир до горизонта, вычисленного темпом (I03, D1).
 *
 * Это то место, где `apps/worker` перестаёт быть скелетом I00. До I03 `step` был честным no-op, и
 * трассировка PR-04 из-за этого утверждала больше доказанного (M8 аудита I02B): мир не шёл сам —
 * расписание разбирал `world tick`, который запускает оператор.
 *
 * `tick` инъектирован портом, а не импортирован здесь напрямую. Причина не в тестируемости как
 * таковой: без порта единственным способом проверить, КАКОЙ горизонт worker предъявляет миру,
 * была бы настоящая база и разбор её состояния постфактум — то есть проверка следствия вместо
 * проверки решения. Горизонт — единственное, что этот модуль решает; он и обязан быть наблюдаем.
 */
import { worldHorizon, type WorldTempo } from './world-tempo.ts';

/** Ровно та часть результата `runWorldTick`, которая нужна worker-у для журнала. */
export interface WorldTickOutcome {
  readonly claimed: number;
  readonly worldTime: string;
}

export interface WorldTickPort {
  (input: { readonly horizon: string }): Promise<WorldTickOutcome>;
}

export interface WorldStepDeps {
  /** Мировое время в момент старта worker-а: точка отсчёта темпа. */
  readonly startWorldTime: string;
  /** Реальные часы процесса в миллисекундах; инъектированы, чтобы шаг не зависел от wall clock. */
  readonly realNowMs: () => number;
  readonly tempo: WorldTempo;
  readonly tick: WorldTickPort;
  readonly logger?: {
    readonly info: (fields: Record<string, unknown>, msg: string) => void;
  };
}

/**
 * Точка отсчёта берётся ОДИН раз, при создании шага, и не сдвигается при перезапуске процесса
 * задним числом.
 *
 * Альтернатива — догонять пропущенное время после простоя, отсчитывая от wall clock последнего
 * события — отвергнута. Она не изменила бы, КАКИЕ события произойдут, но дала бы залп: мир,
 * простоявший ночь, за один шаг проскочил бы восемь часов, и зритель увидел бы не жизнь, а
 * перемотку. Простой — это простой; мир продолжается с того момента, где остановился.
 */
export function createWorldStep(deps: WorldStepDeps): () => Promise<void> {
  const realStartMs = deps.realNowMs();

  return async function step(): Promise<void> {
    const horizon = worldHorizon({
      startWorldTime: deps.startWorldTime,
      elapsedRealMs: deps.realNowMs() - realStartMs,
      tempo: deps.tempo,
    });

    const outcome = await deps.tick({ horizon });

    // Логируется только шаг, что-то сделавший: цикл опрашивает мир чаще, чем мир меняется, и
    // строка «claimed: 0» в каждом опросе утопила бы настоящие события.
    if (outcome.claimed > 0) {
      deps.logger?.info(
        { horizon, claimed: outcome.claimed, worldTime: outcome.worldTime },
        'worker.world.advanced',
      );
    }
  };
}
