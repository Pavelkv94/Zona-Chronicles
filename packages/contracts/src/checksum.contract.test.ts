import { describe, expect, it } from 'vitest';
import {
  CHECKSUM_ALGORITHM,
  CHECKSUM_PATTERN,
  canonicalChecksum,
  isChecksum,
  requireChecksum,
} from './checksum.ts';
import { isCanonicalizationError } from './canonical-json.ts';

function checksum(value: unknown): string {
  const result = canonicalChecksum(value);
  if (isCanonicalizationError(result)) {
    throw new Error(`ожидался checksum, получена ошибка: ${result.path} — ${result.error}`);
  }
  return result.checksum;
}

describe('canonicalChecksum (§9)', () => {
  it('объявляет алгоритм явно', () => {
    expect(CHECKSUM_ALGORITHM).toBe('sha256');
  });

  it.each([
    [{}, 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'],
    [[], 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'],
    [{ a: 1, b: 2 }, 'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'],
    [
      { world_id: 'world:prototype' },
      'sha256:70b59121123b4ec92442f1c0fe2729ccc05959c7742bc2a56f17142c0d980f4b',
    ],
  ])('является SHA-256 над канонической JSON-строкой для %j', (value, expected) => {
    // Эталон посчитан независимо (`node:crypto` вне пакета): checksum обязан быть
    // именно SHA-256 над каноническим текстом, а не «каким-то стабильным хешем».
    expect(checksum(value)).toBe(expected);
  });

  it('не зависит от порядка вставки ключей', () => {
    const reordered: Record<string, number> = {};
    reordered['b'] = 2;
    reordered['a'] = 1;
    expect(checksum(reordered)).toBe(checksum({ a: 1, b: 2 }));
  });

  it('различает содержимое: подмена значения меняет checksum (A9)', () => {
    expect(checksum({ a: 1 })).not.toBe(checksum({ a: 2 }));
  });

  it('различает структуру: отсутствующее и null-поле дают разные checksum', () => {
    expect(checksum({ a: 1, b: undefined })).not.toBe(checksum({ a: 1, b: null }));
  });

  it('имеет фиксированную форму `sha256:<64 hex>`', () => {
    expect(checksum({ any: 'value' })).toMatch(CHECKSUM_PATTERN);
  });

  it('пробрасывает ошибку канонизации вместо хеширования мусора (A5)', () => {
    const result = canonicalChecksum({ balance: Number.NaN });
    expect(isCanonicalizationError(result)).toBe(true);
    if (isCanonicalizationError(result)) {
      expect(result.path).toBe('$.balance');
    }
  });
});

describe('isChecksum', () => {
  it.each([
    ['sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', true],
    ['sha256:44136FA355B3678A1146AD16F7E8649E94FB4FC21FE77E8310C060F61CAAFF8A', false],
    ['sha256:4413', false],
    ['44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', false],
    ['md5:44136fa355b3678a1146ad16f7e8649e', false],
    ['', false],
  ])('для %j возвращает %s', (value, expected) => {
    expect(isChecksum(value)).toBe(expected);
  });
});

describe('requireChecksum', () => {
  it('возвращает checksum для валидного значения', () => {
    expect(requireChecksum({}, 'snapshot')).toMatch(CHECKSUM_PATTERN);
  });

  it('бросает ошибку с меткой источника, если значение неканонично', () => {
    expect(() => requireChecksum({ x: Number.POSITIVE_INFINITY }, 'snapshot')).toThrow(
      /snapshot.*\$\.x/s,
    );
  });
});
