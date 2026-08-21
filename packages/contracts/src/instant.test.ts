import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  compareInstants,
  isInstantError,
  parseInstant,
  requireInstant,
  STRICT_ISO_8601_INSTANT_PATTERN,
} from './instant.ts';

/** 2026-08-20T12:00:00.000Z. */
const EPOCH_2026_08_20_T12Z = 1_787_227_200_000;
/** 0099-01-01T00:00:00.000Z — настоящий 99-й год. */
const EPOCH_0099_01_01_T00Z = -59_042_995_200_000;
/** 1999-01-01T00:00:00.000Z — куда прежняя реализация уводила год 0099 через `Date.UTC`. */
const EPOCH_1999_01_01_T00Z = 915_148_800_000;

describe('parseInstant', () => {
  it('парсит валидную ISO-8601 метку в Instant с epochMs', () => {
    const result = parseInstant('2026-08-20T12:00:00.000Z');
    expect(isInstantError(result)).toBe(false);
    if (!isInstantError(result)) {
      expect(result.iso).toBe('2026-08-20T12:00:00.000Z');
      expect(result.epochMs).toBe(EPOCH_2026_08_20_T12Z);
    }
  });

  it('возвращает { error }, а не бросает исключение, на мусорной строке', () => {
    const result = parseInstant('это не время');
    expect(isInstantError(result)).toBe(true);
  });

  it('возвращает { error } на пустой строке', () => {
    expect(isInstantError(parseInstant(''))).toBe(true);
  });

  describe('N7: строгая ISO-8601 валидация, а не голый Date.parse', () => {
    it.each([
      ['March 1, 2026', 'человекочитаемая дата, не ISO-8601'],
      ['2026', 'голый год'],
      ['12/31/2026', 'US-формат даты'],
      ['2026-01-01 05:00', 'пробел вместо "T" и отсутствие смещения'],
      ['2026-08-20T12:00:00.000', 'валидные компоненты, но отсутствует явное смещение'],
      ['2026-08-20T12:00:00', 'без миллисекунд и без смещения'],
    ])('отклоняет %s (%s)', (value) => {
      const result = parseInstant(value);
      expect(isInstantError(result)).toBe(true);
    });

    it('отклоняет 2026-02-30 — несуществующая календарная дата, а не молчаливый перенос на март', () => {
      const result = parseInstant('2026-02-30T00:00:00Z');
      expect(isInstantError(result)).toBe(true);
      if (isInstantError(result)) {
        expect(result.error).toMatch(/день месяца|несуществующая/);
      }
    });

    it('2024-02-29 — валиден (2024 високосный)', () => {
      const result = parseInstant('2024-02-29T00:00:00Z');
      expect(isInstantError(result)).toBe(false);
    });

    it('2026-02-29 — невалиден (2026 не високосный)', () => {
      const result = parseInstant('2026-02-29T00:00:00Z');
      expect(isInstantError(result)).toBe(true);
    });

    it('принимает корректное значение с "Z"', () => {
      const result = parseInstant('2026-08-20T12:00:00.000Z');
      expect(isInstantError(result)).toBe(false);
      if (!isInstantError(result)) {
        expect(result.epochMs).toBe(EPOCH_2026_08_20_T12Z);
      }
    });

    it('принимает корректное значение с явным смещением "+03:00" и даёт тот же epochMs, что и эквивалентный "Z"', () => {
      const withOffset = parseInstant('2026-08-20T15:00:00+03:00');
      const withZ = parseInstant('2026-08-20T12:00:00Z');
      expect(isInstantError(withOffset)).toBe(false);
      expect(isInstantError(withZ)).toBe(false);
      if (!isInstantError(withOffset) && !isInstantError(withZ)) {
        expect(withOffset.epochMs).toBe(withZ.epochMs);
      }
    });

    it('принимает отрицательное смещение "-05:00"', () => {
      const result = parseInstant('2026-08-20T07:00:00-05:00');
      expect(isInstantError(result)).toBe(false);
      if (!isInstantError(result)) {
        expect(result.epochMs).toBe(EPOCH_2026_08_20_T12Z);
      }
    });

    it('epochMs результата не зависит от TZ хоста (не полагается на голый Date.parse без смещения)', () => {
      // Регрессия N7: раньше "2026-01-01 05:00" молча принимался Date.parse и его epochMs
      // зависел от TZ хоста. Теперь такая строка отклоняется явной ошибкой конфигурации.
      const noOffset = parseInstant('2026-01-01 05:00');
      expect(isInstantError(noOffset)).toBe(true);
    });
  });
});

describe('requireInstant', () => {
  it('возвращает Instant для валидной метки', () => {
    const instant = requireInstant('2026-08-20T12:00:00.000Z', 'test');
    expect(instant.iso).toBe('2026-08-20T12:00:00.000Z');
  });

  it('бросает Error с меткой источника на невалидной строке — не "тихое ещё не наступило"', () => {
    expect(() => requireInstant('bad-timestamp', 'reported_reset_at')).toThrow(/reported_reset_at/);
    expect(() => requireInstant('bad-timestamp', 'reported_reset_at')).toThrow(/невалидное время/);
  });
});

describe('compareInstants', () => {
  it('положительно, отрицательно, ноль в соответствии с порядком времени', () => {
    const earlier = requireInstant('2026-08-20T09:00:00.000Z', 'test');
    const later = requireInstant('2026-08-20T10:00:00.000Z', 'test');
    expect(compareInstants(earlier, later)).toBeLessThan(0);
    expect(compareInstants(later, earlier)).toBeGreaterThan(0);
    expect(compareInstants(earlier, earlier)).toBe(0);
  });
});

describe('addMinutes', () => {
  it('сдвигает epochMs и выдаёт корректный ISO без RangeError', () => {
    const base = requireInstant('2026-08-20T12:00:00.000Z', 'test');
    const shifted = addMinutes(base, 5);
    expect(shifted.iso).toBe('2026-08-20T12:05:00.000Z');
    expect(shifted.epochMs).toBe(base.epochMs + 5 * 60_000);
  });

  it('не бросает RangeError на границе — арифметика работает над уже валидированным epochMs', () => {
    const base = requireInstant('2026-08-20T12:00:00.000Z', 'test');
    expect(() => addMinutes(base, 0)).not.toThrow();
  });
});

describe('parseInstant: целочисленная арифметика вместо Date.UTC (minor 1 раунда 3)', () => {
  it('не отображает годы 0–99 в 1900+year', () => {
    const result = parseInstant('0099-01-01T00:00:00Z');
    expect(isInstantError(result)).toBe(false);
    if (isInstantError(result)) return;

    // Прежняя реализация звала Date.UTC(99, 0, 1) и получала 1999-01-01 — момент, отстоящий
    // от заявленного на 1900 лет, при полностью валидной ISO-метке на входе.
    expect(result.epochMs).not.toBe(EPOCH_1999_01_01_T00Z);
    expect(result.epochMs).toBeLessThan(0);
    expect(result.epochMs).toBe(EPOCH_0099_01_01_T00Z);
  });

  it('совпадает с эталоном на високосных, эпохе, отрицательных и границах веков', () => {
    // Ожидания зафиксированы литералами, а не вычислены через `Date.parse`: эталон,
    // построенный тем же классом функций, который здесь заменяется, доказывал бы
    // только их взаимную согласованность. Значения сверены с независимой реализацией
    // при написании теста.
    const cases: readonly (readonly [string, number])[] = [
      ['1970-01-01T00:00:00Z', 0],
      ['1969-12-31T23:59:59Z', -1_000],
      ['2000-02-29T12:00:00Z', 951_825_600_000],
      ['2024-02-29T00:00:00.500Z', 1_709_164_800_500],
      ['1900-03-01T00:00:00Z', -2_203_891_200_000],
      ['2100-03-01T00:00:00Z', 4_107_542_400_000],
      ['2026-08-21T14:30:00+03:00', 1_787_311_800_000],
      ['2026-08-21T14:30:00-05:30', 1_787_342_400_000],
    ];
    for (const [value, expected] of cases) {
      const result = parseInstant(value);
      expect(isInstantError(result), value).toBe(false);
      if (isInstantError(result)) continue;
      expect(result.epochMs, value).toBe(expected);
    }
  });

  it('по-прежнему отвергает несуществующие даты и метки без смещения', () => {
    expect(isInstantError(parseInstant('2026-02-30T00:00:00Z'))).toBe(true);
    expect(isInstantError(parseInstant('2026-08-21T14:30:00'))).toBe(true);
    expect(isInstantError(parseInstant('March 1, 2026'))).toBe(true);
  });
});

describe('parseInstant: правило високосных столетий (blocker верификации I00-F5)', () => {
  // Мутация `isLeapYear` до `year % 4 === 0` заставляла принимать 1900-02-29 и 2100-02-29,
  // не покрасив ни одного из 227 тестов: генератор property-набора ограничивал день
  // диапазоном 1–28, поэтому граница февраля никогда не возникала.
  const leap = ['1996-02-29T00:00:00Z', '2000-02-29T00:00:00Z', '2400-02-29T00:00:00Z'];
  const notLeap = ['1900-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '2200-02-29T00:00:00Z'];

  it('принимает 29 февраля в високосном году, включая делящийся на 400', () => {
    for (const value of leap) {
      expect(isInstantError(parseInstant(value)), value).toBe(false);
    }
  });

  it('отвергает 29 февраля в столетии, не делящемся на 400', () => {
    for (const value of notLeap) {
      expect(isInstantError(parseInstant(value)), value).toBe(true);
    }
  });

  it('отвергает 31-е число в месяцах длиной 30 дней', () => {
    for (const value of [
      '2026-04-31T00:00:00Z',
      '2026-06-31T00:00:00Z',
      '2026-09-31T00:00:00Z',
      '2026-11-31T00:00:00Z',
    ]) {
      expect(isInstantError(parseInstant(value)), value).toBe(true);
    }
  });
});

/**
 * Точность выше миллисекунды отвергается, а не усекается (A5, SIM-01).
 *
 * Прежнее поведение было внутренне противоречивым: `.1234Z` и `.1236Z` давали ОДИН `epochMs`,
 * но сохраняли разный `iso`. То есть один и тот же `Instant` нёс два несогласованных
 * представления одного момента, и канонический checksum зависел бы от того, сколько лишних
 * разрядов записал источник. Молчаливое усечение — это и есть «неявное округление»,
 * запрещённое A5.
 *
 * Основание для правки: `tools/usage-continuity` удалён вместе с DEV-01 (ADR-009), поэтому
 * прежний довод «от лениентности зависит continuity harness» больше не действует —
 * потребителей `parseInstant` вне `packages/contracts` не осталось.
 */
describe('A5: точность выше миллисекунды', () => {
  it.each([
    '2026-08-20T12:00:00.1234Z',
    '2026-08-20T12:00:00.123456Z',
    '2026-08-20T12:00:00.9999Z',
    '2026-08-20T12:00:00.000000001Z',
    '2026-08-20T14:00:00.1234+02:00',
  ])('отвергает %s', (value) => {
    expect(isInstantError(parseInstant(value))).toBe(true);
  });

  it('называет причину отказа, а не сообщает «невалидная метка»', () => {
    const result = parseInstant('2026-08-20T12:00:00.1234Z');
    if (!isInstantError(result)) {
      throw new Error('ожидался отказ');
    }
    expect(result.error).toMatch(/точнее миллисекунды/i);
  });

  it.each([
    ['2026-08-20T12:00:00.1Z', 100],
    ['2026-08-20T12:00:00.12Z', 120],
    ['2026-08-20T12:00:00.123Z', 123],
    ['2026-08-20T12:00:00Z', 0],
  ])('принимает %s и даёт %i мс', (value, milliseconds) => {
    const result = parseInstant(value);
    if (isInstantError(result)) {
      throw new Error(`ожидался момент: ${result.error}`);
    }
    expect(result.epochMs % 1000).toBe(milliseconds);
  });

  it('две метки, прежде схлопывавшиеся в один epochMs, больше не принимаются обе', () => {
    // Именно эта пара доказывала противоречивость Instant до правки.
    expect(isInstantError(parseInstant('2026-08-20T12:00:00.1234Z'))).toBe(true);
    expect(isInstantError(parseInstant('2026-08-20T12:00:00.1236Z'))).toBe(true);
  });

  it('шаблон допускает не более трёх знаков дробной части', () => {
    expect(STRICT_ISO_8601_INSTANT_PATTERN.test('2026-08-20T12:00:00.123Z')).toBe(true);
    expect(STRICT_ISO_8601_INSTANT_PATTERN.test('2026-08-20T12:00:00.1234Z')).toBe(false);
  });
});
