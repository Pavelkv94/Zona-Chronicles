import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SERIALIZATION_VERSION,
  canonicalize,
  isCanonicalizationError,
  requireCanonical,
} from './canonical-json.ts';

/** Разворачивает успешный результат; падает с текстом ошибки, если он неуспешен. */
function json(value: unknown): string {
  const result = canonicalize(value);
  if (isCanonicalizationError(result)) {
    throw new Error(`ожидался успех, получена ошибка: ${result.path} — ${result.error}`);
  }
  return result.json;
}

/** Разворачивает ошибку; падает, если значение неожиданно оказалось сериализуемым. */
function failure(value: unknown): { error: string; path: string } {
  const result = canonicalize(value);
  if (!isCanonicalizationError(result)) {
    throw new Error(`ожидалась ошибка, получено: ${result.json}`);
  }
  return result;
}

describe('версия алгоритма — часть контракта', () => {
  it('canonical serialization v1 объявляет свою версию', () => {
    // Смена любого правила ниже обязана менять эту строку: §7 07_MVP_MECHANICS_SPEC
    // объявляет смену алгоритма versioned migration, а не молчаливым улучшением.
    expect(CANONICAL_SERIALIZATION_VERSION).toBe('canonical-json/1');
  });
});

describe('порядок ключей не зависит от порядка вставки (A3, SIM-01)', () => {
  it('два объекта с одинаковым содержимым и разным порядком вставки дают одну строку', () => {
    const first = { b: 2, a: 1, c: 3 };
    const second: Record<string, number> = {};
    second['c'] = 3;
    second['a'] = 1;
    second['b'] = 2;
    expect(json(first)).toBe('{"a":1,"b":2,"c":3}');
    expect(json(second)).toBe(json(first));
  });

  it('сортирует ключи на всех уровнях вложенности', () => {
    expect(json({ z: { y: 1, x: { w: 2, v: 3 } }, a: 4 })).toBe(
      '{"a":4,"z":{"x":{"v":3,"w":2},"y":1}}',
    );
  });

  it('сохраняет порядок элементов массива — он семантичен, а не случаен', () => {
    expect(json({ ids: ['c', 'a', 'b'] })).toBe('{"ids":["c","a","b"]}');
  });

  it('сортирует ключи объектов внутри массивов', () => {
    expect(json([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });
});

describe('порядок ключей не зависит от локали (A3)', () => {
  /**
   * Турецкая локаль меняет отношение "I"/"i"/"ı"/"İ": `localeCompare` под `tr_TR` даёт другой
   * порядок, чем под `C`. Контракт фиксирует порядок кодовых точек, поэтому ожидаемый ответ
   * один и тот же везде: I(U+0049) < i(U+0069) < İ(U+0130) < ı(U+0131).
   */
  it('сортирует турецкие I по кодовым точкам, а не по правилам локали', () => {
    expect(json({ ı: 4, İ: 3, i: 2, I: 1 })).toBe('{"I":1,"i":2,"İ":3,"ı":4}');
  });

  /**
   * Граница, на которой UTF-16 и код-пойнтовый порядок расходятся: суррогатная пара
   * начинается с 0xD83D, что МЕНЬШЕ 0xFF5E, хотя сама кодовая точка U+1F600 больше U+FF5E.
   * Наивное `a < b` поставило бы эмодзи первым.
   */
  it('сортирует по кодовым точкам, а не по UTF-16 code units', () => {
    expect(json({ '\u{1F600}': 1, '～': 2 })).toBe('{"～":2,"\u{1F600}":1}');
  });
});

describe('числа: только безопасные целые (A5, SIM-01)', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [Number.MIN_SAFE_INTEGER, '-9007199254740991'],
  ])('сериализует %j как %s', (value, expected) => {
    expect(json(value)).toBe(expected);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('отвергает %s на границе, а не превращает в null', (_label, value) => {
    // Проверка структурная, а не по подстроке со значением: сообщение интерполирует само
    // значение ("нефинитное число (NaN)"), поэтому /NaN|Infinity/ находилось бы независимо от
    // того, распознана ли ПРИЧИНА отказа, — прежняя редакция была тавтологией (minor test
    // reviewer-а). Проверяется, что причина названа нефинитностью и НЕ спутана с соседними
    // категориями отказа (дробное, вне безопасного диапазона).
    const withoutValue = failure(value).error.replace(String(value), '<значение>');
    expect(withoutValue).toMatch(/нефинитн/i);
    expect(withoutValue).not.toMatch(/дробн|безопасн/i);
  });

  it.each([
    ['дробное 1.5', 1.5],
    ['дробное 0.1', 0.1],
    ['результат деления 1/3', 1 / 3],
  ])('отвергает %s: дробные величины кодируются minor units', (_label, value) => {
    expect(failure(value).error).toMatch(/цел/i);
  });

  it.each([
    ['2^53', 2 ** 53],
    ['-2^53', -(2 ** 53)],
    ['1e21', 1e21],
  ])('отвергает %s: за пределом безопасного целого', (_label, value) => {
    expect(failure(value).error).toMatch(/цел|безопасн/i);
  });

  it('никогда не использует экспоненциальную запись', () => {
    expect(json(1_000_000_000_000_000)).toBe('1000000000000000');
  });
});

describe('отсутствующие и неподдерживаемые значения', () => {
  it('опускает ключ со значением undefined — это отсутствующее поле', () => {
    expect(json({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('сохраняет явный null — это присутствующее значение, а не отсутствие', () => {
    expect(json({ a: null })).toBe('{"a":null}');
  });

  it('отвергает undefined в массиве, а не подменяет его на null', () => {
    expect(failure([1, undefined, 3]).path).toBe('$[1]');
  });

  it('отвергает undefined в корне', () => {
    expect(isCanonicalizationError(canonicalize(undefined))).toBe(true);
  });

  it.each([
    ['функцию', () => 1],
    ['symbol', Symbol('x')],
    ['bigint', 10n],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['Date', new Date(0)],
    ['Uint8Array', new Uint8Array([1])],
  ])('отвергает %s', (_label, value) => {
    expect(isCanonicalizationError(canonicalize(value))).toBe(true);
  });

  it('отвергает объект с toJSON: скрытое преобразование делает результат непроверяемым', () => {
    expect(failure({ at: { toJSON: () => '2026-01-01' } }).error).toMatch(/toJSON/);
  });

  it('отвергает объект с собственными symbol-ключами: они бы молча потерялись', () => {
    const value = { a: 1, [Symbol('hidden')]: 2 };
    expect(failure(value).error).toMatch(/symbol/i);
  });

  it('отвергает экземпляр класса: канонично сериализуются только простые объекты', () => {
    class Route {
      readonly id = 'route:a';
    }
    expect(isCanonicalizationError(canonicalize(new Route()))).toBe(true);
  });

  it('принимает объект с прототипом null', () => {
    const value = Object.create(null) as Record<string, number>;
    value['a'] = 1;
    expect(json(value)).toBe('{"a":1}');
  });

  it('отвергает цикл ошибкой, а не переполнением стека', () => {
    const value: Record<string, unknown> = { a: 1 };
    value['self'] = value;
    expect(failure(value).error).toMatch(/цикл/i);
  });

  it('не считает циклом повторное использование одного и того же поддерева', () => {
    const shared = { a: 1 };
    expect(json({ left: shared, right: shared })).toBe('{"left":{"a":1},"right":{"a":1}}');
  });
});

describe('строки и UTF-8', () => {
  it('оставляет не-ASCII символы литеральными, а не \\u-экранированными', () => {
    expect(json({ name: 'Зона' })).toBe('{"name":"Зона"}');
  });

  it('экранирует кавычку, обратный слэш и управляющие символы', () => {
    expect(json('a"b\\c\nd\u0001')).toBe('"a\\"b\\\\c\\nd\\u0001"');
  });

  it('экранирует одиночный суррогат вместо выдачи неверного UTF-8', () => {
    expect(json('\uD800')).toBe('"\\ud800"');
  });

  it('пустой объект и пустой массив имеют фиксированную форму', () => {
    expect(json({})).toBe('{}');
    expect(json([])).toBe('[]');
  });

  it('не добавляет пробелов и переводов строк', () => {
    expect(json({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });
});

describe('requireCanonical', () => {
  it('возвращает строку для валидного значения', () => {
    expect(requireCanonical({ a: 1 }, 'snapshot')).toBe('{"a":1}');
  });

  it('бросает ошибку с меткой источника и путём', () => {
    expect(() => requireCanonical({ a: Number.NaN }, 'snapshot')).toThrow(/snapshot.*\$\.a/s);
  });
});
