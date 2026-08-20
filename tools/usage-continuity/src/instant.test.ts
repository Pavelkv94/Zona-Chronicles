import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  compareInstants,
  isInstantError,
  parseInstant,
  requireInstant,
} from './instant.ts';

describe('parseInstant', () => {
  it('парсит валидную ISO-8601 метку в Instant с epochMs', () => {
    const result = parseInstant('2026-08-20T12:00:00.000Z');
    expect(isInstantError(result)).toBe(false);
    if (!isInstantError(result)) {
      expect(result.iso).toBe('2026-08-20T12:00:00.000Z');
      expect(result.epochMs).toBe(Date.parse('2026-08-20T12:00:00.000Z'));
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
        expect(result.epochMs).toBe(Date.parse('2026-08-20T12:00:00.000Z'));
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
        expect(result.epochMs).toBe(Date.parse('2026-08-20T12:00:00Z'));
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
