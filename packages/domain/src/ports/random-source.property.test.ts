import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DeterministicRandomSource } from './random-source.ts';

/**
 * A7: "та же пара (seed, stream key) даёт ту же последовательность; разные stream key при
 * одном seed дают НЕЗАВИСИМЫЕ последовательности".
 *
 * Определяющая проблема (сформулирована lead-ом при постановке задачи): две
 * последовательности, отличающиеся только сдвигом друг относительно друга, формально разные
 * (не совпадают поэлементно), но зависимые — и такой мутант прошёл бы наивный тест "первые
 * значения не равны". Поэтому независимость проверяется двумя разными по природе способами:
 *
 * 1. **Точный (не статистический) тест на отсутствие сдвиговой связи.** Берём по
 *    `WINDOW * 2 + OVERLAP` draw из двух потоков одного seed и проверяем: не существует такого
 *    целого сдвига `w` в `[-WINDOW, WINDOW]`, при котором `OVERLAP` подряд идущих значений
 *    потока A совпадают со значениями потока B, сдвинутыми на `w`. Совпадение float-значений
 *    двух независимых детерминированных последовательностей на протяжении `OVERLAP` шагов
 *    подряд имеет исчезающую вероятность у НЕ связанных сдвигом потоков, поэтому тест не
 *    мерцает: он либо ловит настоящую сдвиговую связь, либо проходит.
 * 2. **Статистическая декорреляция** как второе, независимое подтверждение: коэффициент
 *    корреляции Пирсона между потоками близок к нулю. Порог выбран с большим запасом
 *    (`|r| < 0.35`), чтобы тест не был чувствителен к статистическому шуму при умеренном числе
 *    выборок — здесь это ПОДТВЕРЖДЕНИЕ, а не основной детектор; основной — пункт 1.
 */

const WINDOW = 10;
const OVERLAP = 24;
const SHIFT_PROBE_DRAWS = WINDOW * 2 + OVERLAP;

const streamKeyArb = fc.oneof(
  fc.constantFrom('world:prototype', 'agent:rook', 'agent:doc', 'scene:yard', 'system:weather'),
  fc
    .string({
      minLength: 1,
      maxLength: 24,
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz:-_0123456789'),
    })
    .filter((s) => s.length > 0),
);

function sequence(source: DeterministicRandomSource, streamKey: string, count: number): number[] {
  return Array.from({ length: count }, () => source.draw(streamKey).value);
}

/** Совпадает ли `OVERLAP` значений A (начиная с 0) со значениями B, сдвинутыми на `shift`? */
function matchesShift(a: readonly number[], b: readonly number[], shift: number): boolean {
  for (let i = 0; i < OVERLAP; i += 1) {
    const bIndex = i + WINDOW + shift;
    if (bIndex < 0 || bIndex >= b.length) {
      return false;
    }
    if (a[i + WINDOW] !== b[bIndex]) {
      return false;
    }
  }
  return true;
}

function pearsonCorrelation(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (varianceA === 0 || varianceB === 0) {
    return 0;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

describe('RandomSource: A7 воспроизводимость', () => {
  it('тот же (seed, streamKey) на независимых инстансах даёт ту же последовательность и тот же audit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        streamKeyArb,
        fc.integer({ min: 1, max: 40 }),
        (seed, streamKey, count) => {
          const a = new DeterministicRandomSource(seed);
          const b = new DeterministicRandomSource(seed);
          const drawsA = Array.from({ length: count }, () => a.draw(streamKey));
          const drawsB = Array.from({ length: count }, () => b.draw(streamKey));
          expect(drawsA).toStrictEqual(drawsB);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('RandomSource: A7 независимость потоков', () => {
  it('разные streamKey ни при каком целом сдвиге не совпадают на окне из OVERLAP значений', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        streamKeyArb,
        streamKeyArb,
        (seed, keyA, keyB) => {
          fc.pre(keyA !== keyB);
          const source = new DeterministicRandomSource(seed);
          const a = sequence(source, keyA, SHIFT_PROBE_DRAWS);
          const b = sequence(source, keyB, SHIFT_PROBE_DRAWS);
          for (let shift = -WINDOW; shift <= WINDOW; shift += 1) {
            expect(matchesShift(a, b, shift)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('корреляция Пирсона между разными потоками близка к нулю (подтверждение, не основной тест)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        streamKeyArb,
        streamKeyArb,
        (seed, keyA, keyB) => {
          fc.pre(keyA !== keyB);
          const source = new DeterministicRandomSource(seed);
          const a = sequence(source, keyA, 1_000);
          const b = sequence(source, keyB, 1_000);
          expect(Math.abs(pearsonCorrelation(a, b))).toBeLessThan(0.35);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('счётчик draw одного потока не зависит от того, сколько draw уже сделано в других потоках', () => {
    fc.assert(
      fc.property(
        streamKeyArb,
        streamKeyArb,
        fc.integer({ min: 0, max: 15 }),
        (keyA, keyB, priorDraws) => {
          fc.pre(keyA !== keyB);
          const warm = new DeterministicRandomSource(1);
          for (let i = 0; i < priorDraws; i += 1) {
            warm.draw(keyA);
          }
          const firstOfB = warm.draw(keyB);
          expect(firstOfB.drawIndex).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
