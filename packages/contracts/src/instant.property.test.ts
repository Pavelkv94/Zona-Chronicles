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
 * инварианта продолжают выполняться.
 *
 * Уточнение после верификации раунда I00-F5 (blocker, найден мутацией): дифференциальная
 * проверка ниже покрывает **арифметику** `daysFromCivil`, но не покрывала **валидацию** дня
 * месяца, потому что генератор ограничивал день диапазоном 1–28 и граница месяца физически
 * не возникала. Снятие правила високосных столетий заставляло `parseInstant` принимать
 * `1900-02-29` и `2100-02-29`, оставляя все 227 тестов зелёными. Прежняя редакция этого
 * комментария утверждала обратное и тем создавала впечатление доказанного покрытия.
 *
 * Поэтому реализация используется дважды: для счёта дней и для длины месяца, а генератор
 * `civilDate` даёт дни 1–31, то есть заведомо включает несуществующие даты.
 */
const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const NAIVE_DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function naiveDaysInMonth(year: number, month: number): number {
  return NAIVE_DAYS_IN_MONTH[month - 1]! + (month === 2 && isLeap(year) ? 1 : 0);
}

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

/**
 * Календарная дата с днём 1–31, включая заведомо несуществующие сочетания (31 апреля,
 * 29 февраля невисокосного года). Годы смещены к границам столетий, где правило
 * високосности и различает реализации.
 */
const anyYear = fc.integer({ min: 1, max: 9999 });
/** Годы, на которых расходятся правило «делится на 4» и настоящее правило столетий. */
const centuryYear = fc.constantFrom(1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400);
/** Месяцы длиной 30 дней — там различимы длины 30 и 31. */
const shortMonth = fc.constantFrom(4, 6, 9, 11);

const civilDate = fc.oneof(
  // Равномерная ветвь: ловит то, чего мы не предусмотрели.
  fc.record({
    year: anyYear,
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
  }),
  // Прицельные ветви. Без них граница месяца возникает с вероятностью порядка 0,02% на
  // прогон, и детектор становится мерцающим — то есть хуже отсутствующего. Проверено:
  // при равномерном генераторе снятие правила столетий краснило property лишь иногда.
  fc.record({ year: centuryYear, month: fc.constant(2), day: fc.constantFrom(28, 29, 30) }),
  fc.record({ year: anyYear, month: fc.constant(2), day: fc.constantFrom(28, 29, 30) }),
  fc.record({ year: anyYear, month: shortMonth, day: fc.constantFrom(30, 31) }),
  fc.record({ year: anyYear, month: fc.constantFrom(1, 3, 5, 7, 8, 10, 12), day: fc.constant(31) }),
);

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

  it('дата принимается ровно тогда, когда она существует по независимой реализации', () => {
    fc.assert(
      fc.property(civilDate, ({ year, month, day }) => {
        const pad = (value: number, width: number): string => String(value).padStart(width, '0');
        const iso = `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T00:00:00.000Z`;
        const accepted = !isInstantError(parseInstant(iso));
        // Единственный инвариант в файле, проверяющий ВАЛИДАЦИЮ, а не арифметику:
        // 2026-04-31 и 1900-02-29 обязаны отвергаться, 2000-02-29 — приниматься.
        expect(accepted, iso).toBe(day <= naiveDaysInMonth(year, month));
      }),
      { numRuns: 2_000 },
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

/**
 * Граница точности (A5).
 *
 * Генератор `isoInstant` выше всегда пишет ровно три знака дробной части, поэтому границу
 * «не точнее миллисекунды» он не достигает НИКОГДА — тот же дефект генератора, из-за которого
 * в I00 правило високосных столетий оставалось непроверенным (F5). Здесь длина дробной части
 * генерируется явно, в диапазоне 0–9, и обе стороны границы заведомо возникают.
 */
const instantWithFraction = fc
  .record({
    fractionDigits: fc.integer({ min: 0, max: 9 }),
    fraction: fc.integer({ min: 0, max: 999_999_999 }),
    offset: fc.constantFrom('Z', '+02:00', '-05:00', '+00:00'),
  })
  .map(({ fractionDigits, fraction, offset }) => {
    const digits = String(fraction).padStart(9, '0').slice(0, fractionDigits);
    const suffix = fractionDigits === 0 ? '' : `.${digits}`;
    return { iso: `2026-08-20T12:00:00${suffix}${offset}`, fractionDigits };
  });

describe('Instant: граница точности', () => {
  it('принимается ровно тогда, когда знаков дробной части не больше трёх', () => {
    fc.assert(
      fc.property(instantWithFraction, ({ iso, fractionDigits }) => {
        expect(isInstantError(parseInstant(iso))).toBe(fractionDigits > 3);
      }),
      { numRuns: 1000 },
    );
  });

  it('дробная часть переводится в миллисекунды без округления', () => {
    fc.assert(
      fc.property(instantWithFraction, ({ iso, fractionDigits }) => {
        const parsed = parseInstant(iso);
        if (fractionDigits > 3) return;
        expect(isInstantError(parsed)).toBe(false);
        if (isInstantError(parsed)) return;
        // ".1" -> 100 мс, ".12" -> 120 мс, ".123" -> 123 мс: дополнение нулями справа,
        // а не деление с потерей разрядов.
        const digits = iso.includes('.') ? iso.split('.')[1]!.replace(/[Z+-].*$/, '') : '';
        const expected = digits === '' ? 0 : Number(digits.padEnd(3, '0'));
        expect(((parsed.epochMs % 1000) + 1000) % 1000).toBe(expected);
      }),
      { numRuns: 1000 },
    );
  });
});
