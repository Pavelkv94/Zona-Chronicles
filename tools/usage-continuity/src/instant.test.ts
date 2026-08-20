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
