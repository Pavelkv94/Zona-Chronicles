import { describe, expect, it } from 'vitest';
import {
  DRAW_COUNT_UNIT,
  DRAW_INDEX_UNIT,
  MILLISECOND_UNIT,
  NUMERIC_ROUNDING_MODES,
  SCHEMA_VERSION_UNIT,
  SEQUENCE_UNIT,
  WORLD_VERSION_UNIT,
  checkMinorUnits,
  defineNumericUnit,
  formatMinorUnits,
  isNumericError,
  parseDecimalMinorUnits,
  roundToMinorUnits,
} from './numeric.ts';

/** Тестовая единица с двумя знаками после точки — «деньги» без домена. */
const CENTS = defineNumericUnit({
  id: 'test.major',
  description: 'Тестовая величина с двумя знаками после точки.',
  minorUnitsPerMajor: 100,
  min: -1_000_000,
  max: 1_000_000,
});

function value(result: number | { error: string }): number {
  if (isNumericError(result)) {
    throw new Error(`ожидалось число, получена ошибка: ${result.error}`);
  }
  return result;
}

function errorOf(result: number | { error: string }): string {
  if (!isNumericError(result)) {
    throw new Error(`ожидалась ошибка, получено число: ${result}`);
  }
  return result.error;
}

describe('единицы измерения объявляются явно (A5, SIM-01)', () => {
  it.each([
    [SEQUENCE_UNIT, 'count.sequence', 1],
    [WORLD_VERSION_UNIT, 'count.world_version', 1],
    [SCHEMA_VERSION_UNIT, 'count.schema_version', 1],
    [DRAW_INDEX_UNIT, 'count.prng_draw_index', 1],
    [DRAW_COUNT_UNIT, 'count.prng_draw', 1],
    [MILLISECOND_UNIT, 'time.second', 1000],
  ])('единица %# объявляет id и масштаб', (unit, id, scale) => {
    expect(unit.id).toBe(id);
    expect(unit.minorUnitsPerMajor).toBe(scale);
    expect(unit.description.length).toBeGreaterThan(0);
  });

  it('единица знает свой диапазон в minor units', () => {
    expect(SEQUENCE_UNIT.min).toBe(1);
    expect(MILLISECOND_UNIT.min).toBe(-62_167_219_200_000);
    expect(MILLISECOND_UNIT.max).toBe(253_402_300_799_999);
  });

  it.each([
    ['масштаб не степень десяти', { minorUnitsPerMajor: 60 }],
    ['масштаб дробный', { minorUnitsPerMajor: 0.1 }],
    ['масштаб ноль', { minorUnitsPerMajor: 0 }],
    ['min больше max', { min: 10, max: 1 }],
    ['граница нецелая', { min: 0.5 }],
    ['граница нефинитная', { max: Number.POSITIVE_INFINITY }],
    ['пустой id', { id: '' }],
  ])('отвергает определение единицы: %s', (_label, override) => {
    expect(() =>
      defineNumericUnit({
        id: 'test.bad',
        description: 'Заведомо некорректное определение.',
        minorUnitsPerMajor: 100,
        min: 0,
        max: 100,
        ...override,
      }),
    ).toThrow();
  });
});

describe('checkMinorUnits: отказ на границе, а не молчаливое округление (A5)', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('отвергает %s', (_label, input) => {
    expect(errorOf(checkMinorUnits(input, CENTS))).toMatch(/конечн/i);
  });

  it('отвергает дробное значение в minor units вместо округления', () => {
    expect(errorOf(checkMinorUnits(10.5, CENTS))).toMatch(/цел/i);
  });

  it('отвергает значение за пределом безопасного целого', () => {
    expect(errorOf(checkMinorUnits(2 ** 53, SEQUENCE_UNIT))).toMatch(/диапазон|безопасн/i);
  });

  it.each([
    ['ниже min', -1_000_001],
    ['выше max', 1_000_001],
  ])('отвергает значение %s', (_label, input) => {
    expect(errorOf(checkMinorUnits(input, CENTS))).toMatch(/диапазон/i);
  });

  it.each([-1_000_000, -1, 0, 1, 1_000_000])('принимает граничное значение %i', (input) => {
    expect(value(checkMinorUnits(input, CENTS))).toBe(input);
  });

  it('нормализует -0 в 0: два представления нуля дали бы разные строки', () => {
    expect(Object.is(value(checkMinorUnits(-0, CENTS)), 0)).toBe(true);
  });

  it('sequence начинается с 1, а не с 0', () => {
    expect(isNumericError(checkMinorUnits(0, SEQUENCE_UNIT))).toBe(true);
    expect(value(checkMinorUnits(1, SEQUENCE_UNIT))).toBe(1);
  });

  it('draw index начинается с 0', () => {
    expect(value(checkMinorUnits(0, DRAW_INDEX_UNIT))).toBe(0);
    expect(isNumericError(checkMinorUnits(-1, DRAW_INDEX_UNIT))).toBe(true);
  });
});

describe('parseDecimalMinorUnits: точное десятичное значение без float (A5)', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['-1', -100],
    ['1.5', 150],
    ['1.50', 150],
    ['0.01', 1],
    ['-0.01', -1],
    ['1234.56', 123_456],
  ])('разбирает %j в %i minor units', (text, expected) => {
    expect(value(parseDecimalMinorUnits(text, CENTS))).toBe(expected);
  });

  it('отвергает значение точнее единицы вместо округления — прямое требование A5', () => {
    expect(errorOf(parseDecimalMinorUnits('1.005', CENTS))).toMatch(/точн|знак/i);
  });

  it('не теряет точность на значениях, которые ломает умножение float', () => {
    // 0.29 * 100 === 28.999999999999996: реализация через float дала бы 28 или потребовала
    // бы неявного допуска, то есть неописанного округления.
    expect(value(parseDecimalMinorUnits('0.29', CENTS))).toBe(29);
    expect(value(parseDecimalMinorUnits('1.15', CENTS))).toBe(115);
    expect(value(parseDecimalMinorUnits('8.11', CENTS))).toBe(811);
  });

  it.each([
    ['экспоненциальная запись', '1e2'],
    ['ведущий плюс', '+1'],
    ['пустая дробная часть', '1.'],
    ['отсутствующая целая часть', '.5'],
    ['пробел', ' 1'],
    ['разделитель тысяч', '1,000'],
    ['ведущий ноль', '01'],
    ['пустая строка', ''],
    ['не число', 'много'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['шестнадцатеричное', '0x10'],
  ])('отвергает %s (%j)', (_label, text) => {
    expect(isNumericError(parseDecimalMinorUnits(text, CENTS))).toBe(true);
  });

  it('отвергает значение вне диапазона единицы', () => {
    expect(errorOf(parseDecimalMinorUnits('10000.01', CENTS))).toMatch(/диапазон/i);
  });

  it('для целочисленной единицы дробная часть недопустима вовсе', () => {
    expect(value(parseDecimalMinorUnits('42', SEQUENCE_UNIT))).toBe(42);
    expect(errorOf(parseDecimalMinorUnits('42.5', SEQUENCE_UNIT))).toMatch(/точн|знак/i);
  });

  it('-0 разбирается в 0', () => {
    expect(Object.is(value(parseDecimalMinorUnits('-0', CENTS)), 0)).toBe(true);
  });
});

describe('formatMinorUnits', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [-1, '-0.01'],
    [150, '1.50'],
    [123_456, '1234.56'],
    [-123_456, '-1234.56'],
  ])('форматирует %i как %j', (minor, expected) => {
    expect(formatMinorUnits(minor, CENTS)).toBe(expected);
  });

  it('для целочисленной единицы не добавляет дробную часть', () => {
    expect(formatMinorUnits(42, SEQUENCE_UNIT)).toBe('42');
  });

  it('round-trip: parse(format(x)) === x', () => {
    for (const minor of [-123_456, -1, 0, 1, 99, 100, 123_456]) {
      expect(value(parseDecimalMinorUnits(formatMinorUnits(minor, CENTS), CENTS))).toBe(minor);
    }
  });
});

describe('roundToMinorUnits: округление всегда именованное и запрошенное (A5)', () => {
  it('перечисляет допустимые режимы', () => {
    expect([...NUMERIC_ROUNDING_MODES]).toEqual([
      'half-even',
      'half-away-from-zero',
      'floor',
      'ceil',
    ]);
  });

  it.each([
    ['half-even', 1.005, 100],
    ['half-even', 1.015, 102],
    ['half-even', 1.025, 102],
    ['half-away-from-zero', 1.005, 101],
    ['half-away-from-zero', -1.005, -101],
    ['floor', 1.009, 100],
    ['floor', -1.001, -101],
    ['ceil', 1.001, 101],
    ['ceil', -1.009, -100],
  ] as const)('режим %s переводит %d в %i minor units', (mode, input, expected) => {
    expect(value(roundToMinorUnits(input, CENTS, mode))).toBe(expected);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('отвергает %s даже при явном режиме округления', (_label, input) => {
    expect(isNumericError(roundToMinorUnits(input, CENTS, 'half-even'))).toBe(true);
  });

  it('отвергает результат вне диапазона единицы', () => {
    expect(errorOf(roundToMinorUnits(20_000, CENTS, 'floor'))).toMatch(/диапазон/i);
  });

  it('режим — обязательный аргумент, «по умолчанию» округления не существует', () => {
    // Отрицательный type-тест: вызов без режима не компилируется. Здесь фиксируется
    // рантайм-половина того же правила — неизвестный режим отвергается, а не молча
    // подменяется каким-то одним.
    expect(
      isNumericError(
        roundToMinorUnits(1.5, CENTS, 'nearest' as (typeof NUMERIC_ROUNDING_MODES)[number]),
      ),
    ).toBe(true);
  });
});
