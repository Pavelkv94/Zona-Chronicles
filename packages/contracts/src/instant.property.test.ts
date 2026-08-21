import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMinutes, compareInstants, isInstantError, parseInstant } from './instant.ts';

/**
 * Инварианты контракта момента времени (SIM-01).
 *
 * Example-based тесты в `instant.test.ts` перечисляют граничные случаи, которые мы **знали**:
 * високосный год, эпоха, отрицательное время, годы 0–99, границы веков. Property-тест
 * проверяет то, чего мы не перечисляли, — включая комбинации, которые никто не выписал бы
 * руками.
 *
 * Это тот инвариант, на котором в I01 будет стоять world time: если разбор и арифметика
 * момента зависят от чего-то, кроме собственных аргументов, детерминированность replay
 * недостижима, и обнаружится это не здесь, а на расхождении двух прогонов симуляции.
 */

/**
 * Независимая наивная реализация счёта дней: прямой перебор лет и месяцев с обычным
 * правилом високосности. Медленная и заведомо не та, что в проверяемом коде.
 *
 * Она здесь не для красоты. Round-trip, монотонность и согласованность порядка доказывают
 * только **внутреннюю непротиворечивость**: при систематически смещённой арифметике все три
 * инварианта продолжают выполняться. Проверено мутацией — поломка правила високосных
 * столетий не красит ни один из них. Дифференциальная проверка против другой реализации —
 * единственный инвариант в этом файле, который привязан к календарю, а не к самому себе.
 */
const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const NAIVE_DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function naiveDaysFromEpoch(year: number, month: number, day: number): number {
  let days = 0;
  if (year >= 1970) {
    for (let y = 1970; y < year; y += 1) days += isLeap(y) ? 366 : 365;
  } else {
    for (let y = year; y < 1970; y += 1) days -= isLeap(y) ? 366 : 365;
  }
  for (let m = 1; m < month; m += 1) {
    days += NAIVE_DAYS_IN_MONTH[m - 1]! + (m === 2 && isLeap(year) ? 1 : 0);
  }
  return days + day - 1;
}

/** Момент в диапазоне, покрывающем и годы до 100, и время до эпохи, и далёкое будущее. */
const isoInstant = fc
  .record({
    year: fc.integer({ min: 1, max: 9999 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
    ms: fc.integer({ min: 0, max: 999 }),
  })
  .map(({ year, month, day, hour, minute, second, ms }) => {
    const pad = (value: number, width: number): string => String(value).padStart(width, '0');
    return (
      `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
      `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(ms, 3)}Z`
    );
  });

describe('Instant: инварианты', () => {
  it('round-trip: iso -> epochMs -> iso сохраняет метку', () => {
    fc.assert(
      fc.property(isoInstant, (iso) => {
        const parsed = parseInstant(iso);
        expect(isInstantError(parsed)).toBe(false);
        if (isInstantError(parsed)) return;
        expect(parsed.iso).toBe(iso);
        // Повторный разбор собственного вывода обязан давать тот же момент: иначе
        // сериализация состояния мира теряет информацию между прогонами.
        const reparsed = parseInstant(parsed.iso);
        expect(isInstantError(reparsed)).toBe(false);
        if (isInstantError(reparsed)) return;
        expect(reparsed.epochMs).toBe(parsed.epochMs);
      }),
      { numRuns: 500 },
    );
  });

  it('addMinutes: сдвиг вперёд и назад на одно и то же число минут возвращает исходный момент', () => {
    fc.assert(
      fc.property(isoInstant, fc.integer({ min: -100_000, max: 100_000 }), (iso, minutes) => {
        const parsed = parseInstant(iso);
        if (isInstantError(parsed)) return;
        const there = addMinutes(parsed, minutes);
        const back = addMinutes(there, -minutes);
        expect(back.epochMs).toBe(parsed.epochMs);
      }),
      { numRuns: 500 },
    );
  });

  it('addMinutes монотонен: положительный сдвиг строго увеличивает момент', () => {
    fc.assert(
      fc.property(isoInstant, fc.integer({ min: 1, max: 100_000 }), (iso, minutes) => {
        const parsed = parseInstant(iso);
        if (isInstantError(parsed)) return;
        expect(compareInstants(addMinutes(parsed, minutes), parsed)).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  it('порядок по compareInstants согласован с порядком по epochMs', () => {
    fc.assert(
      fc.property(isoInstant, isoInstant, (a, b) => {
        const pa = parseInstant(a);
        const pb = parseInstant(b);
        if (isInstantError(pa) || isInstantError(pb)) return;
        const byCompare = Math.sign(compareInstants(pa, pb));
        const byEpoch = Math.sign(pa.epochMs - pb.epochMs);
        expect(byCompare).toBe(byEpoch);
      }),
      { numRuns: 500 },
    );
  });

  it('дифференциальная проверка: epochMs совпадает с независимой наивной реализацией', () => {
    fc.assert(
      fc.property(isoInstant, (iso) => {
        const parsed = parseInstant(iso);
        if (isInstantError(parsed)) return;
        const year = Number(iso.slice(0, 4));
        const month = Number(iso.slice(5, 7));
        const day = Number(iso.slice(8, 10));
        const hour = Number(iso.slice(11, 13));
        const minute = Number(iso.slice(14, 16));
        const second = Number(iso.slice(17, 19));
        const ms = Number(iso.slice(20, 23));
        const expected =
          naiveDaysFromEpoch(year, month, day) * 86_400_000 +
          hour * 3_600_000 +
          minute * 60_000 +
          second * 1_000 +
          ms;
        expect(parsed.epochMs).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it('addMinutes привязан к календарю: +60 минут сдвигает час ровно на единицу', () => {
    fc.assert(
      fc.property(isoInstant, (iso) => {
        const parsed = parseInstant(iso);
        if (isInstantError(parsed)) return;
        const shifted = addMinutes(parsed, 60);
        const hourBefore = Number(parsed.iso.slice(11, 13));
        const hourAfter = Number(shifted.iso.slice(11, 13));
        expect(hourAfter).toBe((hourBefore + 1) % 24);
        // Минуты, секунды и миллисекунды обязаны остаться прежними: сдвиг ровно на час.
        expect(shifted.iso.slice(14, 23)).toBe(parsed.iso.slice(14, 23));
      }),
      { numRuns: 500 },
    );
  });

  it('метка без смещения отвергается всегда, а не иногда', () => {
    fc.assert(
      fc.property(isoInstant, (iso) => {
        // Снятие "Z" делает момент зависимым от часового пояса хоста — регрессия N7.
        expect(isInstantError(parseInstant(iso.replace(/Z$/, '')))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
