/**
 * D1 — worker предъявляет миру горизонт, растущий от реального времени, и ничего больше.
 */
import { describe, expect, it } from 'vitest';
import { createWorldStep } from './world-step.ts';
import { DEFAULT_WORLD_TEMPO } from './world-tempo.ts';

const START = '2028-04-26T06:00:00.000Z';

/**
 * Срок ждущего действия, заведомо далёкий.
 *
 * Тесты ниже проверяют РОСТ горизонта, а рост определён только для мира, которому есть что
 * делать: простаивающий мир горизонт не копит (см. последний блок файла). Поэтому фейки
 * объявляют ждущее действие явно — иначе они молча проверяли бы другое свойство.
 */
const PENDING = '2028-04-26T09:00:00.000Z';

/** Часы, которыми управляет тест: шаг не имеет права зависеть от настоящего wall clock. */
const fakeClock = (values: readonly number[]) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
};

const recordingTick = () => {
  const horizons: string[] = [];
  const port = async ({ horizon }: { horizon: string }) => {
    horizons.push(horizon);
    return await Promise.resolve({ claimed: 0, worldTime: START, nextDueAt: PENDING });
  };
  return { horizons, port };
};

describe('D1: шаг worker-а двигает мир по темпу, а не по числу опросов', () => {
  it('горизонт отсчитывается от момента СОЗДАНИЯ шага, а не от каждого вызова', async () => {
    const tick = recordingTick();
    // Первое значение потребляет `createWorldStep` как точку отсчёта.
    const step = createWorldStep({
      startWorldTime: START,
      realNowMs: fakeClock([1_000_000, 1_010_000, 1_040_000]),
      tempo: { worldMinutesPerRealSecond: 1 },
      tick: tick.port,
    });

    await step();
    await step();

    expect(tick.horizons).toEqual(['2028-04-26T06:10:00.000Z', '2028-04-26T06:40:00.000Z']);
  });

  /**
   * Ключевое свойство: частота опроса на мир не влияет. Десять опросов за то же реальное время
   * дают тот же горизонт, что один, — иначе «скорость мира» зависела бы от `pollIntervalMs`,
   * то есть от настройки процесса, а не от решения владельца.
   */
  it('число опросов за то же реальное время не меняет горизонт', async () => {
    const tick = recordingTick();
    const step = createWorldStep({
      startWorldTime: START,
      realNowMs: fakeClock([0, 5000, 5000, 5000]),
      tempo: { worldMinutesPerRealSecond: 1 },
      tick: tick.port,
    });

    await step();
    await step();
    await step();

    expect(new Set(tick.horizons).size).toBe(1);
    expect(tick.horizons[0]).toBe('2028-04-26T06:05:00.000Z');
  });

  it('шаг ничего не решает сверх горизонта: в tick не уходит ничего от зрителя', async () => {
    const seen: unknown[] = [];
    const step = createWorldStep({
      startWorldTime: START,
      realNowMs: fakeClock([0, 1000]),
      tempo: DEFAULT_WORLD_TEMPO,
      tick: async (input) => {
        seen.push(input);
        return await Promise.resolve({ claimed: 0, worldTime: START, nextDueAt: PENDING });
      },
    });

    await step();

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] as Record<string, unknown>)).toEqual(['horizon']);
  });

  it('шаг, ничего не захвативший, не пишет в журнал', async () => {
    const lines: string[] = [];
    const step = createWorldStep({
      startWorldTime: START,
      realNowMs: fakeClock([0, 1000]),
      tempo: DEFAULT_WORLD_TEMPO,
      tick: async () => await Promise.resolve({ claimed: 0, worldTime: START, nextDueAt: PENDING }),
      logger: { info: (_fields, msg) => lines.push(msg) },
    });

    await step();
    expect(lines).toEqual([]);
  });

  it('шаг, продвинувший мир, пишет горизонт и новое мировое время', async () => {
    const fields: Record<string, unknown>[] = [];
    const step = createWorldStep({
      startWorldTime: START,
      realNowMs: fakeClock([0, 60_000]),
      tempo: { worldMinutesPerRealSecond: 1 },
      tick: async () =>
        await Promise.resolve({
          claimed: 2,
          worldTime: '2028-04-26T06:40:00.000Z',
          nextDueAt: PENDING,
        }),
      logger: { info: (f) => fields.push(f) },
    });

    await step();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      claimed: 2,
      worldTime: '2028-04-26T06:40:00.000Z',
      horizon: '2028-04-26T07:00:00.000Z',
    });
  });
});

/**
 * КРЕДИТ ТЕМПА — дефект, найденный независимым архитектурным аудитом I03 и записанный там как
 * нормативная развилка. Развилки нет: код противоречит СОБСТВЕННОМУ записанному решению.
 *
 * `world-step.ts` объявляет: «простой — это простой; мир продолжается с того момента, где
 * остановился», и отвергает догон пропущенного как перемотку. Точка отсчёта, взятая один раз при
 * старте, защищает это только от простоя ДО запуска процесса. Простой ВО ВРЕМЯ работы копится:
 * мировое время двигают события (ADR-004), поэтому в тишине оно стоит, а горизонт растёт от
 * реального. Разница и есть неизрасходованный кредит.
 *
 * Стоимость измерена, а не предположена: E2E-сценарий D13 упал на этом — путь длиной сорок
 * мировых минут завершался мгновенно, и состояние «в пути» не существовало ни в один
 * наблюдаемый момент (`REVIEW.md`, шестой случай).
 *
 * Проверенное направление починки — привязать горизонт к текущему мировому времени — ОТВЕРГНУТО
 * исполнением: мир встаёт совсем, потому что горизонт, привязанный к времени, которое двигают
 * только события, никогда не дорастает до первого срока.
 *
 * Здесь третий вариант: точка отсчёта переставляется, ПОКА МИРУ НЕЧЕГО ДЕЛАТЬ, и замирает, как
 * только появилось ждущее действие. Кредит не копится, тупика нет, канонический журнал не
 * меняется вовсе — мировое время по-прежнему двигают только события, поэтому D2/SIM-01 не
 * затронуты.
 */
describe('кредит темпа: простой не оплачивает будущее', () => {
  const TEMPO = { worldMinutesPerRealSecond: 1 } as const;
  const ARRIVAL = '2028-04-26T06:40:00.000Z';

  /**
   * Мир из одного пути: сорок мировых минут, начатых после `startAfterMs` реального простоя.
   * Возвращает реальное время, к которому путь завершился.
   */
  const runIdleThenJourney = async (startAfterMs: number): Promise<number> => {
    let nowMs = 0;
    let worldTime = START;
    let nextDueAt: string | null = null;
    let arrivedAtMs: number | null = null;
    const horizons: string[] = [];

    const step = createWorldStep({
      startWorldTime: START,
      realNowMs: () => nowMs,
      tempo: TEMPO,
      tick: async ({ horizon }) => {
        horizons.push(horizon);
        let claimed = 0;
        if (nextDueAt !== null && horizon >= nextDueAt) {
          worldTime = nextDueAt;
          nextDueAt = null;
          arrivedAtMs = nowMs;
          claimed = 1;
        }
        return await Promise.resolve({ claimed, worldTime, nextDueAt });
      },
    });

    // Опрос раз в секунду, как в продукте. Путь ставится по СОХРАНЁННОМУ мировому времени —
    // именно так его штампует команда, и в этом суть дефекта.
    for (let tick = 1; tick <= 600 && arrivedAtMs === null; tick += 1) {
      nowMs = tick * 1000;
      if (nowMs === startAfterMs) nextDueAt = ARRIVAL;
      await step();
    }

    expect(arrivedAtMs).not.toBeNull();
    return arrivedAtMs!;
  };

  it('путь занимает свою длительность и без простоя, и после него', async () => {
    const withoutIdle = (await runIdleThenJourney(3000)) - 3000;
    const afterLongIdle = (await runIdleThenJourney(300_000)) - 300_000;

    /**
     * Сорок мировых минут при темпе 1 — сорок реальных секунд, и НЕ МЕНЬШЕ: горизонт, которого
     * реальное время не оплатило, — это тот же кредит, только на секунду. Верхняя граница —
     * один интервал опроса: действие могло появиться сразу после опроса, и раньше следующего
     * мир о нём не узнает. Это задержка реакции, она постоянна и не копится.
     */
    expect(withoutIdle).toBeGreaterThanOrEqual(40_000);
    expect(withoutIdle).toBeLessThanOrEqual(41_000);

    // ТО ЖЕ САМОЕ после пяти минут тишины. Без починки здесь мгновенное прибытие: горизонт уже
    // на пять часов впереди мирового времени, и путь созревает первым же опросом.
    expect(afterLongIdle).toBeGreaterThanOrEqual(40_000);
    expect(afterLongIdle).toBeLessThanOrEqual(41_000);

    // Главное утверждение: длительность пути не зависит от того, сколько мир перед этим молчал.
    expect(afterLongIdle).toBe(withoutIdle);
  });

  it('переустановка отсчёта не останавливает мир: ждущее действие замораживает её', async () => {
    let nowMs = 0;
    const horizons: string[] = [];
    const step = createWorldStep({
      startWorldTime: START,
      realNowMs: () => nowMs,
      tempo: TEMPO,
      // Мир, которому ВСЕГДА есть что делать: отсчёт не имеет права переставляться ни разу,
      // иначе горизонт никогда не дорастёт до срока — это и был отвергнутый вариант починки.
      tick: async ({ horizon }) => {
        horizons.push(horizon);
        return await Promise.resolve({ claimed: 0, worldTime: START, nextDueAt: PENDING });
      },
    });

    for (let tick = 1; tick <= 100; tick += 1) {
      nowMs = tick * 1000;
      await step();
    }

    expect(horizons.at(-1)).toBe('2028-04-26T07:40:00.000Z');
  });
});
