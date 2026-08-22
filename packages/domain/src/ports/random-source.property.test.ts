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
 * значения не равны". Прежняя реализация (чистый Mulberry32 с аффинным шагом продвижения,
 * см. разбор в docstring `random-source.ts`) СОДЕРЖАЛА ровно этот дефект: при seed 42 и 1000
 * одновременных потоках минимальный сдвиг между какой-то парой был 705 draw, а при 10 000
 * потоках — 11 draw (независимая верификация I01, blocker B1). Поэтому независимость
 * проверяется тремя разными по природе способами — каждый ловит свой класс мутанта:
 *
 * 1. **Точный (не статистический) поиск сдвиговой связи в реалистичном диапазоне.** Берём по
 *    `WINDOW * 2 + OVERLAP` draw из двух потоков одного seed и проверяем: не существует такого
 *    целого сдвига `w` в `[-WINDOW, WINDOW]`, при котором `OVERLAP` подряд идущих значений
 *    потока A совпадают со значениями потока B, сдвинутыми на `w`. `WINDOW = 1000`: сопоставимо
 *    с задокументированным худшим случаем из отчёта (705 draw на 1000 потоках) с запасом — при
 *    более крупных мирах (10 000 потоков) минимальный сдвиг ещё меньше (11), то есть уже
 *    покрыт этим окном. Совпадение float-значений двух НЕ связанных сдвигом потоков на
 *    протяжении `OVERLAP` шагов подряд имеет исчезающую вероятность, поэтому тест не мерцает.
 * 2. **Конструктивный тест на буквальных парах-контрпримерах.** Не случайный поиск, а три
 *    конкретные пары `streamKey` при seed 42, которые lead привёл как воспроизведение дефекта
 *    прежней реализации (`agent:a73sq`/`agent:a3mzt` на сдвиге −6, `agent:a8032`/`agent:a8kel`
 *    на −8, `agent:a1ww7`/`agent:a5thi` на −3, все — 24 подряд идущих совпадения). На прежней
 *    реализации это красный тест: сдвиг находится ровно там, где указан. Независимо
 *    перепроверено вручную (та же формула) перед правкой — см. handoff задачи.
 * 3. **Отсутствие общего мутируемого состояния между потоками.** Значение потока B на СВЕЖЕМ
 *    инстансе обязано совпадать со значением того же потока B на инстансе, где до этого сделали
 *    произвольное число draw в ДРУГИХ потоках. Прежний тест №4 (ниже) проверял только
 *    `drawIndex` (бухгалтерию счётчика), поэтому не ловил ни общий счётчик draw на инстанс, ни
 *    XOR текущего состояния с битами предыдущего draw любого потока — оба мутанта проходили все
 *    четыре прежних теста (второй ревьюер).
 * 4. **Статистическая декорреляция** как ДОПОЛНИТЕЛЬНОЕ подтверждение: коэффициент корреляции
 *    Пирсона между потоками близок к нулю. Порог выбран с большим запасом (`|r| < 0.35`), чтобы
 *    тест не был чувствителен к статистическому шуму — здесь это подтверждение, а не основной
 *    детектор; основные — пункты 1–3.
 */

const WINDOW = 1000;
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

  it('конструктивный контрпример: буквальные пары streamKey, красные на прежнем Mulberry32', () => {
    // Пары и сдвиги — из независимой верификации I01 (lead, seed 42), воспроизведены вручную
    // на прежней (аффинной) реализации перед правкой этого файла: для каждой пары нашёлся
    // указанный целый сдвиг с 24 подряд идущими совпадениями. На текущей (counter-based)
    // реализации ни для одной пары сдвиг в [-WINDOW, WINDOW] найтись не должен.
    const reportedPairs: ReadonlyArray<{
      readonly keyA: string;
      readonly keyB: string;
      readonly oldShift: number;
    }> = [
      { keyA: 'agent:a73sq', keyB: 'agent:a3mzt', oldShift: -6 },
      { keyA: 'agent:a8032', keyB: 'agent:a8kel', oldShift: -8 },
      { keyA: 'agent:a1ww7', keyB: 'agent:a5thi', oldShift: -3 },
    ];
    for (const { keyA, keyB, oldShift } of reportedPairs) {
      const source = new DeterministicRandomSource(42);
      const a = sequence(source, keyA, SHIFT_PROBE_DRAWS);
      const b = sequence(source, keyB, SHIFT_PROBE_DRAWS);
      // Сдвиг, задокументированный для прежней реализации, тоже проверяем явно — если правка
      // не изменила конструкцию, этот assert упадёт первым и укажет на регресс.
      expect(matchesShift(a, b, oldShift)).toBe(false);
      for (let shift = -WINDOW; shift <= WINDOW; shift += 1) {
        expect(matchesShift(a, b, shift)).toBe(false);
      }
    }
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

  it('значение потока не зависит от того, сколько draw сделано в ДРУГИХ потоках того же инстанса', () => {
    // Ловит класс мутантов, не видимый предыдущему тесту (он проверял только drawIndex, то
    // есть бухгалтерию, а не значение): общий счётчик draw на инстанс вместо счётчика per
    // streamKey, или XOR текущего вычисления с битами предыдущего draw ЛЮБОГО потока. Оба
    // мутанта прошли бы все прежние тесты (второй ревьюер, независимая верификация I01).
    fc.assert(
      fc.property(
        streamKeyArb,
        streamKeyArb,
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 1, max: 5 }),
        (keyA, keyB, priorDraws, seed, drawsOfBToCompare) => {
          fc.pre(keyA !== keyB);
          const control = new DeterministicRandomSource(seed);
          const controlDraws = Array.from({ length: drawsOfBToCompare }, () => control.draw(keyB));

          const warmed = new DeterministicRandomSource(seed);
          for (let i = 0; i < priorDraws; i += 1) {
            warmed.draw(keyA);
          }
          const warmedDraws = Array.from({ length: drawsOfBToCompare }, () => warmed.draw(keyB));

          expect(warmedDraws).toStrictEqual(controlDraws);
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * Тест 7 — birthday-поиск сдвиговой связи среди МНОГИХ одновременных потоков.
 *
 * Введён по major верификации I01. Тест 1 ищет сдвиг между **одной случайной парой** за прогон
 * в окне ±1000. Для аффинной рекурренты сдвиг между парой равен `(s_B − s_A)·C⁻¹ mod 2³²` и
 * практически равномерен по 2³², поэтому вероятность попадания в окно ≈ 4.7·10⁻⁷ за прогон, а за
 * 200 прогонов ожидание ≈ 9·10⁻⁵. Тест 1 **математически неспособен** поймать этот класс.
 *
 * Тест 2 (буквальные пары ключей) ловит только исторический дефект: пары подобраны под константу
 * `0x6d2b79f5`, и при любой другой они бессмысленны. Проверено: возврат аффинной рекурренты с
 * константой `0x9e3779b9` проходил все 807 тестов репозитория.
 *
 * Здесь используется тот же приём, которым исходный дефект и был найден: при `N` одновременных
 * потоках минимальный попарный сдвиг ≈ 2³²/N², то есть при нескольких тысячах потоков он
 * закономерно попадает в проверяемое окно, а не по удаче.
 *
 * Ключевая деталь — **подтверждение**. Одиночное совпадение значений ничего не доказывает:
 * при `N·W` сравнениях случайные коллизии 32-битных значений неизбежны (для чисел ниже их
 * ожидание ≈ 3). Сдвиговая связь отличается тем, что после совпадения выравниваются и все
 * последующие значения. Измерено на этой самой конструкции:
 *
 *   текущий код: 3 одиночных (ожидание 3.1), подтверждённых 0
 *   аффинный мутант: 8 одиночных, подтверждённых 2 (пример: сдвиг 1068)
 */
describe('RandomSource: A7 — birthday-поиск сдвига среди многих потоков', () => {
  // Обнаружение растёт как N²·W, а стоимость — как N·W, поэтому выгоднее увеличивать число
  // потоков, а не окно. Ожидаемое число сдвиговых пар при аффинной рекурренте = N²·W/2³²:
  //
  //   N=2000  W=1200 -> 1.12 пары, P(обнаружения) 67%   (первая редакция — детектор-монетка)
  //   N=12000 W=300  -> 10.1 пары, P(обнаружения) 99.996%
  //
  // Первая редакция этого теста мутант НЕ ловила, и это было поймано мутационной пробой, а не
  // рассуждением — тот же класс ошибки, что она призвана обнаруживать.
  const STREAMS = 12_000;
  const SHIFT_WINDOW = 300;
  const CONFIRM = 24;

  it('ни одна пара из тысяч потоков не является сдвигом другой', () => {
    const seed = 42;
    const key = (index: number): string => `agent:birthday-${index}`;

    const firstValueOwner = new Map<number, number>();
    for (let stream = 0; stream < STREAMS; stream += 1) {
      firstValueOwner.set(new DeterministicRandomSource(seed).draw(key(stream)).value, stream);
    }

    const confirmed: string[] = [];
    for (let stream = 0; stream < STREAMS; stream += 1) {
      const source = new DeterministicRandomSource(seed);
      const values: number[] = [];
      for (let i = 0; i < SHIFT_WINDOW + CONFIRM; i += 1) {
        values.push(source.draw(key(stream)).value);
      }

      for (let shift = 1; shift < SHIFT_WINDOW; shift += 1) {
        const owner = firstValueOwner.get(values[shift]!);
        if (owner === undefined || owner === stream) {
          continue;
        }
        // Совпало одно значение — это может быть случайной коллизией. Сдвиговая связь
        // отличается тем, что выравниваются и следующие значения.
        const other = new DeterministicRandomSource(seed);
        const otherValues: number[] = [];
        for (let i = 0; i < CONFIRM; i += 1) {
          otherValues.push(other.draw(key(owner)).value);
        }
        if (otherValues.every((value, i) => value === values[shift + i])) {
          confirmed.push(`поток ${stream} со сдвигом ${shift} совпадает с потоком ${owner}`);
        }
        break;
      }
    }

    expect(
      confirmed,
      `найдена сдвиговая связь между потоками — это дефект класса B1:\n${confirmed.join('\n')}`,
    ).toEqual([]);
  });
});
