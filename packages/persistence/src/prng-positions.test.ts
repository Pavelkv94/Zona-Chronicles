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

/**
 * M-E (второй раунд верификации I02B). Восстановление потока было ПРОКРУТКОЙ: `catchUp` крутил
 * `inner.draw` вхолостую столько раз, какова сохранённая позиция. Ревьюер измерил цену:
 *
 * ```text
 * позиция     1 000:   0.6 мс на команду
 * позиция   100 000:   4.7 мс
 * позиция 1 000 000:  24.3 мс
 * позиция 5 000 000: 119.5 мс
 * ```
 *
 * Это время держится замок `FOR NO KEY UPDATE` на строке мира, то есть сериализует ВСЕ команды
 * мира, и растёт с возрастом мира: SIM-02 (30–50 агентов, 7 игровых дней) при розыгрыше на тик
 * даёт позиции порядка 10^5–10^7. Прокрутка при этом не нужна: значение draw — чистая функция
 * `(seed, keyHash, drawIndex)` без цепочки состояния, поэтому старт с индекса N возможен за O(1).
 *
 * **Про сам детектор — почему он такой, а не «замерить и сравнить».** Первая редакция брала
 * позицию, которую прокрутка не осилит (2·10^9), в расчёте на таймаут. Это не сработало:
 * прокрутка — СИНХРОННЫЙ цикл, таймаут vitest его не прерывает, и тест не падал, а висел 132
 * секунды, после чего сообщал о таймауте. Измерено, не предположено.
 *
 * Поэтому доказательств два, и главное из них — не про время. Структурное: доменный источник
 * умеет НАЧАТЬ поток с индекса N, и это проверяется мгновенно, сравнением значения с потоком,
 * дошедшим до N розыгрышами. Границу по времени оставляем второй, грубой проверкой — честно
 * назвав её грубой: она ловит возврат прокрутки, но её порог зависит от машины, поэтому запас
 * взят трёхзначный (прокрутка на этой позиции — секунды, O(1) — микросекунды).
 */
describe('M-E: восстановление потока не зависит от величины позиции', () => {
  it('значение на восстановленной позиции то же, что у потока, дошедшего до неё розыгрышами', () => {
    const uninterrupted = new DeterministicRandomSource(7);
    let last = uninterrupted.draw('agent:rook');
    for (let index = 1; index <= 5000; index += 1) last = uninterrupted.draw('agent:rook');

    const restored = new PersistentRandomSource({
      seed: 7,
      startPositions: { 'agent:rook': 5000 },
    });
    expect(restored.draw('agent:rook')).toEqual(last);
  });

  it('доменный источник начинает поток с заданного индекса, а не с нуля', () => {
    const started = new DeterministicRandomSource(7, { 'agent:rook': 5000 });
    const draw = started.draw('agent:rook');
    expect(draw.drawIndex).toBe(5000);

    const uninterrupted = new DeterministicRandomSource(7);
    let last = uninterrupted.draw('agent:rook');
    for (let index = 1; index <= 5000; index += 1) last = uninterrupted.draw('agent:rook');
    expect(draw).toEqual(last);
  });

  it(
    'грубая граница: позиция в сто миллионов не стоит секунд (прокрутка стоила бы)',
    { timeout: 1500 },
    () => {
      const source = new PersistentRandomSource({
        seed: 7,
        startPositions: { 'agent:rook': 100_000_000 },
      });
      expect(source.draw('agent:rook').drawIndex).toBe(100_000_000);
    },
  );
});
