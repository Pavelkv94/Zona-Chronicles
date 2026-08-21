import { describe, expect, it } from 'vitest';
import { isInstantError, parseInstant } from './instant.ts';
import {
  CANONICAL_INSTANT_PATTERN,
  formatCanonicalInstant,
  isCanonicalInstant,
  parseCanonicalInstant,
} from './canonical-instant.ts';

function iso(value: string): string {
  const result = parseCanonicalInstant(value);
  if (isInstantError(result)) {
    throw new Error(`ожидался момент, получена ошибка: ${result.error}`);
  }
  return result.iso;
}

function errorOf(value: string): string {
  const result = parseCanonicalInstant(value);
  if (!isInstantError(result)) {
    throw new Error(`ожидалась ошибка, получен момент ${result.iso}`);
  }
  return result.error;
}

describe('канонический момент нормализован (SIM-01, A3)', () => {
  it.each([
    ['2026-08-20T12:00:00Z', '2026-08-20T12:00:00.000Z'],
    ['2026-08-20T12:00:00.1Z', '2026-08-20T12:00:00.100Z'],
    ['2026-08-20T12:00:00.12Z', '2026-08-20T12:00:00.120Z'],
    ['2026-08-20T12:00:00.123Z', '2026-08-20T12:00:00.123Z'],
  ])('дополняет дробную часть до миллисекунд: %s -> %s', (input, expected) => {
    expect(iso(input)).toBe(expected);
  });

  it.each([
    ['2026-08-20T20:00:00+02:00', '2026-08-20T18:00:00.000Z'],
    ['2026-08-20T13:00:00-05:00', '2026-08-20T18:00:00.000Z'],
    ['2026-08-20T18:00:00Z', '2026-08-20T18:00:00.000Z'],
  ])('приводит смещение к UTC: %s -> %s', (input, expected) => {
    expect(iso(input)).toBe(expected);
  });

  it('три записи одного момента дают одну каноническую строку, а значит один checksum', () => {
    const canonical = new Set([
      iso('2026-08-20T20:00:00+02:00'),
      iso('2026-08-20T13:00:00-05:00'),
      iso('2026-08-20T18:00:00Z'),
    ]);
    expect(canonical.size).toBe(1);
  });

  it('пересечение суток при смещении меняет дату', () => {
    expect(iso('2026-08-20T23:30:00-05:00')).toBe('2026-08-21T04:30:00.000Z');
    expect(iso('2026-01-01T00:30:00+02:00')).toBe('2025-12-31T22:30:00.000Z');
  });

  it('идемпотентность: разбор собственного вывода не меняет строку', () => {
    const once = iso('2026-08-20T20:00:00.5+02:00');
    expect(iso(once)).toBe(once);
  });

  it('epochMs совпадает с общим парсером — нормализация не сдвигает момент', () => {
    const lenient = parseInstant('2026-08-20T20:00:00.123+02:00');
    const canonical = parseCanonicalInstant('2026-08-20T20:00:00.123+02:00');
    if (isInstantError(lenient) || isInstantError(canonical)) {
      throw new Error('оба разбора обязаны быть успешны');
    }
    expect(canonical.epochMs).toBe(lenient.epochMs);
  });
});

describe('точность выше миллисекунды отвергается, а не усекается (A5)', () => {
  it.each([
    '2026-08-20T12:00:00.1234Z',
    '2026-08-20T12:00:00.123456Z',
    '2026-08-20T12:00:00.9999Z',
    '2026-08-20T12:00:00.0000001Z',
  ])('отвергает %s', (input) => {
    // Голый parseInstant усекает такие значения молча: `.1234` и `.1236` дают один epochMs,
    // но разный текст, то есть разный checksum одного и того же момента.
    expect(errorOf(input)).toMatch(/точн|миллисекунд/i);
  });

  /**
   * Регрессионная защита от прежнего дефекта, а не просто проверка отказа.
   *
   * Раньше `parseInstant` принимал обе метки, молча усекал разряды и возвращал ОДИН `epochMs`
   * при разном `iso` — то есть `Instant` был внутренне противоречив. Дефект закрыт в самом
   * `parseInstant`; тест переписан вместе с изменившимся поведением, а не удалён, потому что
   * именно эта пара его и доказывала.
   */
  it('пара, прежде схлопывавшаяся в один epochMs, теперь отвергается обеими сторонами', () => {
    for (const value of ['2026-08-20T12:00:00.1234Z', '2026-08-20T12:00:00.1236Z']) {
      expect(isInstantError(parseInstant(value))).toBe(true);
      expect(isInstantError(parseCanonicalInstant(value))).toBe(true);
    }
  });
});

describe('канонический момент наследует строгость общего контракта', () => {
  it.each([
    ['без смещения', '2026-08-20T12:00:00.000'],
    ['только дата', '2026-08-20'],
    ['пробел вместо T', '2026-08-20 12:00:00Z'],
    ['несуществующая дата', '2026-02-30T00:00:00Z'],
    ['несуществующее время', '2026-08-20T24:00:00Z'],
    ['мусор', 'вчера'],
    ['пустая строка', ''],
  ])('отвергает %s', (_label, input) => {
    expect(isInstantError(parseCanonicalInstant(input))).toBe(true);
  });
});

describe('formatCanonicalInstant: форматирование без Date', () => {
  it.each([
    [0, '1970-01-01T00:00:00.000Z'],
    [1, '1970-01-01T00:00:00.001Z'],
    [-1, '1969-12-31T23:59:59.999Z'],
    [1_787_227_200_000, '2026-08-20T12:00:00.000Z'],
    [-62_167_219_200_000, '0000-01-01T00:00:00.000Z'],
    [253_402_300_799_999, '9999-12-31T23:59:59.999Z'],
    [-62_135_596_800_000, '0001-01-01T00:00:00.000Z'],
  ])('форматирует %i как %s', (epochMs, expected) => {
    expect(formatCanonicalInstant(epochMs)).toBe(expected);
  });

  it('високосный день форматируется как 29 февраля, а не как 1 марта', () => {
    expect(formatCanonicalInstant(1_709_164_800_000)).toBe('2024-02-29T00:00:00.000Z');
  });

  it.each([
    ['ниже допустимого года', -62_167_219_200_001],
    ['выше допустимого года', 253_402_300_800_000],
    ['нецелое', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('бросает ошибку на %s', (_label, epochMs) => {
    expect(() => formatCanonicalInstant(epochMs)).toThrow();
  });
});

describe('isCanonicalInstant', () => {
  it.each([
    ['2026-08-20T12:00:00.000Z', true],
    ['2026-08-20T12:00:00.123Z', true],
    ['2026-08-20T12:00:00Z', false],
    ['2026-08-20T12:00:00.12Z', false],
    ['2026-08-20T12:00:00.1234Z', false],
    ['2026-08-20T14:00:00.000+02:00', false],
    ['2026-02-30T00:00:00.000Z', false],
    ['', false],
  ])('для %j возвращает %s', (input, expected) => {
    expect(isCanonicalInstant(input)).toBe(expected);
  });

  it('шаблон и предикат согласованы на календарно неверной дате', () => {
    // Одного регулярного выражения мало: `2026-02-30T00:00:00.000Z` ему соответствует.
    expect(CANONICAL_INSTANT_PATTERN.test('2026-02-30T00:00:00.000Z')).toBe(true);
    expect(isCanonicalInstant('2026-02-30T00:00:00.000Z')).toBe(false);
  });
});
