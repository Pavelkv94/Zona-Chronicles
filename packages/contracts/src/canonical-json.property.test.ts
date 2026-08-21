import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, isCanonicalizationError } from './canonical-json.ts';

/**
 * Инварианты canonical serialization v1 (A3, SIM-01).
 *
 * Example-тесты в `canonical-json.contract.test.ts` перечисляют границы, которые мы знали.
 * Здесь проверяется то, чего никто не выписывал руками: произвольные вложенные структуры и
 * произвольный порядок вставки ключей.
 *
 * Урок I00-F5 применён к генератору напрямую: пул ключей задан явно и включает пары, на
 * которых расходятся правила сравнения (`I`/`i`/`ı`/`İ` под турецкой локалью, `～` против
 * суррогатной пары `😀`, общий префикс `a`/`ab`). Со «случайными строками» такие пары
 * встречались бы исчезающе редко, и детектор был бы мерцающим.
 */

/** Ключи, включающие все известные точки расхождения правил сравнения. */
const canonicalKey = fc.constantFrom(
  '',
  'a',
  'ab',
  'A',
  'I',
  'i',
  'İ',
  'ı',
  '～',
  '\u{1F600}',
  '0',
  '_',
  'world_time',
  'worldTime',
);

const canonicalLeaf = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
  fc.string(),
  canonicalKey,
);

const canonicalValue = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 4, depthSize: 'small' },
    canonicalLeaf,
    fc.array(tie('node'), { maxLength: 4 }),
    // `noNullPrototype: true` обязателен: иначе fast-check выдаёт объекты с прототипом null,
    // они не проходят `toStrictEqual` против `JSON.parse`, а главное — молча выпадали бы из
    // `rebuildWithKeyOrder`, обесценивая проверку независимости от порядка вставки.
    fc.dictionary(canonicalKey, tie('node'), { maxKeys: 6, noNullPrototype: true }),
  ),
})).node;

/** Плотный объект вместо `unknown[]`: только простые объекты пересобираются по ключам. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Рекурсивно пересобирает структуру, вставляя ключи каждого объекта в новом порядке. */
function rebuildWithKeyOrder(value: unknown, reorder: (keys: string[]) => string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => rebuildWithKeyOrder(element, reorder));
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const rebuilt: Record<string, unknown> = {};
  for (const key of reorder(Object.keys(value))) {
    rebuilt[key] = rebuildWithKeyOrder(value[key], reorder);
  }
  return rebuilt;
}

function serialize(value: unknown): string {
  const result = canonicalize(value);
  if (isCanonicalizationError(result)) {
    throw new Error(`${result.path}: ${result.error}`);
  }
  return result.json;
}

describe('canonical serialization: инварианты', () => {
  it('результат не зависит от порядка вставки ключей', () => {
    fc.assert(
      fc.property(canonicalValue, fc.integer({ min: 0, max: 8 }), (value, rotation) => {
        const original = serialize(value);
        const reversed = serialize(rebuildWithKeyOrder(value, (keys) => [...keys].reverse()));
        const rotated = serialize(
          rebuildWithKeyOrder(value, (keys) =>
            keys.length === 0 ? keys : [...keys.slice(rotation % keys.length), ...keys],
          ),
        );
        expect(reversed).toBe(original);
        expect(rotated).toBe(original);
      }),
      { numRuns: 500 },
    );
  });

  it('вывод — валидный JSON, разбор которого структурно равен входу', () => {
    fc.assert(
      fc.property(canonicalValue, (value) => {
        expect(JSON.parse(serialize(value))).toStrictEqual(value);
      }),
      { numRuns: 500 },
    );
  });

  it('идемпотентность: повторная сериализация разобранного вывода даёт ту же строку', () => {
    fc.assert(
      fc.property(canonicalValue, (value) => {
        const once = serialize(value);
        expect(serialize(JSON.parse(once))).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it('ключи каждого объекта идут строго по возрастанию кодовых точек', () => {
    fc.assert(
      fc.property(canonicalValue, (value) => {
        const parsed: unknown = JSON.parse(serialize(value));
        const visit = (node: unknown): void => {
          if (Array.isArray(node)) {
            node.forEach(visit);
            return;
          }
          if (!isPlainRecord(node)) {
            return;
          }
          // JSON.parse сохраняет порядок ключей исходной строки для нецифровых ключей;
          // цифровые ключи ("0") переупорядочиваются движком, поэтому сравнение идёт по
          // кодовым точкам, а не по индексу.
          const keys = Object.keys(node).filter((key) => !/^\d+$/.test(key));
          const points = keys.map((key) => Array.from(key).map((c) => c.codePointAt(0)!));
          for (let i = 1; i < points.length; i += 1) {
            expect(comparePointArrays(points[i - 1]!, points[i]!)).toBeLessThan(0);
          }
          Object.values(node).forEach(visit);
        };
        visit(parsed);
      }),
      { numRuns: 500 },
    );
  });
});

function comparePointArrays(a: number[], b: number[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) {
      return a[i]! - b[i]!;
    }
  }
  return a.length - b.length;
}
