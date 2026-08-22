/**
 * `PersistentRandomSource` — ACCEPTANCE C11: позиции PRNG переживают перезапуск.
 */
import { describe, expect, it } from 'vitest';
import { DeterministicRandomSource } from '@zona/domain';
import { PersistentRandomSource } from './prng-positions.ts';

const SEED = 42;
const STREAM_A = 'agent:rook';
const STREAM_B = 'world:prototype';

describe('PersistentRandomSource без сохранённых позиций эквивалентен свежему домену', () => {
  it('первый draw совпадает с DeterministicRandomSource(seed) с чистого листа', () => {
    const fresh = new DeterministicRandomSource(SEED);
    const restored = new PersistentRandomSource({ seed: SEED });

    const expected = fresh.draw(STREAM_A);
    const actual = restored.draw(STREAM_A);

    expect(actual).toEqual(expected);
  });
});

describe('C11: следующий розыгрыш продолжает поток с сохранённой позиции, а не начинает заново', () => {
  it('draw после restore даёт ТЕ ЖЕ значения, что непрерывный прогон той же длины', () => {
    // "Непрерывный прогон": один источник делает N розыгрышей, затем ещё несколько без разрыва.
    const continuous = new DeterministicRandomSource(SEED);
    const before = Array.from({ length: 5 }, () => continuous.draw(STREAM_A));
    const continuedWithoutRestart = Array.from({ length: 3 }, () => continuous.draw(STREAM_A));

    // "Восстановленный": другой процесс сделал те же 5 розыгрышей, записал позицию в снимок
    // (5 — количество уже сделанных draw), потом "перезапустился" и продолжил.
    const restored = new PersistentRandomSource({ seed: SEED, startPositions: { [STREAM_A]: 5 } });
    const continuedAfterRestart = Array.from({ length: 3 }, () => restored.draw(STREAM_A));

    expect(continuedAfterRestart).toEqual(continuedWithoutRestart);
    // Проверка не тавтологична: drawIndex первого draw после restore обязан быть 5, а не 0 —
    // это и есть "продолжает, а не начинает заново" в измеримом виде.
    expect(continuedAfterRestart[0]?.drawIndex).toBe(5);
    expect(before).toHaveLength(5); // before используется только для построения continuous-baseline
  });

  it('drawIndex восстановленного потока начинается ровно с сохранённой позиции, не с 0', () => {
    const restored = new PersistentRandomSource({ seed: SEED, startPositions: { [STREAM_A]: 12 } });
    expect(restored.draw(STREAM_A).drawIndex).toBe(12);
  });

  it('позиция 0 (или отсутствие потока в карте) — поведение свежего потока', () => {
    const restored = new PersistentRandomSource({ seed: SEED, startPositions: { [STREAM_A]: 0 } });
    expect(restored.draw(STREAM_A).drawIndex).toBe(0);

    const untouched = new PersistentRandomSource({ seed: SEED, startPositions: {} });
    expect(untouched.draw(STREAM_A).drawIndex).toBe(0);
  });
});

describe('потоки независимы друг от друга при восстановлении', () => {
  it('сохранённая позиция одного потока не влияет на другой', () => {
    const restored = new PersistentRandomSource({
      seed: SEED,
      startPositions: { [STREAM_A]: 20 },
    });
    // STREAM_B не упомянут в startPositions — обязан начаться с 0, а не унаследовать позицию A.
    expect(restored.draw(STREAM_B).drawIndex).toBe(0);
  });

  it('draw по одному потоку не расходует счётчик другого (лениво прокручивается каждый свой)', () => {
    const restored = new PersistentRandomSource({
      seed: SEED,
      startPositions: { [STREAM_A]: 3, [STREAM_B]: 7 },
    });
    expect(restored.draw(STREAM_B).drawIndex).toBe(7);
    expect(restored.draw(STREAM_A).drawIndex).toBe(3);
  });
});

describe('positions(): снимок текущего состояния всех известных потоков', () => {
  it('до первого draw возвращает ровно стартовые позиции', () => {
    const restored = new PersistentRandomSource({
      seed: SEED,
      startPositions: { [STREAM_A]: 4, [STREAM_B]: 9 },
    });
    expect(restored.positions()).toEqual({ [STREAM_A]: 4, [STREAM_B]: 9 });
  });

  it('после draw позиция потока продвигается на число сделанных розыгрышей', () => {
    const restored = new PersistentRandomSource({ seed: SEED, startPositions: { [STREAM_A]: 4 } });
    restored.draw(STREAM_A);
    restored.draw(STREAM_A);
    expect(restored.positions()[STREAM_A]).toBe(6);
  });

  it('поток, к которому не обращались в этом инстансе, сохраняет исходную позицию', () => {
    const restored = new PersistentRandomSource({
      seed: SEED,
      startPositions: { [STREAM_A]: 4, [STREAM_B]: 9 },
    });
    restored.draw(STREAM_A);
    // B не трогали — обязан пережить снимок НЕИЗМЕННЫМ, а не пропасть и не обнулиться.
    expect(restored.positions()[STREAM_B]).toBe(9);
  });

  it('поток, впервые встреченный в этом инстансе, появляется в positions() с 0', () => {
    const restored = new PersistentRandomSource({ seed: SEED });
    restored.draw(STREAM_A);
    expect(restored.positions()).toEqual({ [STREAM_A]: 1 });
  });
});

describe('детерминизм: то же (seed, startPositions) даёт ту же последовательность', () => {
  it('два независимых инстанса с одинаковым восстановлением дают одинаковые draw', () => {
    const first = new PersistentRandomSource({ seed: SEED, startPositions: { [STREAM_A]: 5 } });
    const second = new PersistentRandomSource({ seed: SEED, startPositions: { [STREAM_A]: 5 } });
    const firstDraws = Array.from({ length: 4 }, () => first.draw(STREAM_A));
    const secondDraws = Array.from({ length: 4 }, () => second.draw(STREAM_A));
    expect(secondDraws).toEqual(firstDraws);
  });
});

describe('валидация входных позиций', () => {
  it.each([
    ['отрицательная', -1],
    ['дробная', 1.5],
    ['NaN', Number.NaN],
  ])('отвергает позицию потока %s немедленно, в конструкторе', (_label, position) => {
    expect(
      () => new PersistentRandomSource({ seed: SEED, startPositions: { [STREAM_A]: position } }),
    ).toThrow(/PersistentRandomSource/);
  });
});
