/**
 * D1 — worker предъявляет миру горизонт, растущий от реального времени, и ничего больше.
 */
import { describe, expect, it } from 'vitest';
import { createWorldStep } from './world-step.ts';
import { DEFAULT_WORLD_TEMPO } from './world-tempo.ts';

const START = '2028-04-26T06:00:00.000Z';

/** Часы, которыми управляет тест: шаг не имеет права зависеть от настоящего wall clock. */
const fakeClock = (values: readonly number[]) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
};

const recordingTick = () => {
  const horizons: string[] = [];
  const port = async ({ horizon }: { horizon: string }) => {
    horizons.push(horizon);
    return await Promise.resolve({ claimed: 0, worldTime: START });
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
        return await Promise.resolve({ claimed: 0, worldTime: START });
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
      tick: async () => await Promise.resolve({ claimed: 0, worldTime: START }),
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
        await Promise.resolve({ claimed: 2, worldTime: '2028-04-26T06:40:00.000Z' }),
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
