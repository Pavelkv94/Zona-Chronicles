/**
 * Внутренние детерминированные примитивы перемешивания, общие для `RandomSource` и `IdFactory`
 * (ADR-003, SIM-01). НЕ экспортируется из `index.ts` — деталь реализации портов, а не публичный
 * контракт домена.
 *
 * `crypto` запрещён в домене (A6), поэтому оба порта используют один и тот же
 * некриптографический, но детерминированный набор функций: FNV-1a (хеш строки в 32 бита) и
 * SplitMix32 (перемешивание 32-битного состояния с хорошим avalanche-эффектом — маленькое
 * изменение входа даёт полностью другой выход, что и делает потоки/id независимыми, а не
 * сдвинутыми копиями друг друга).
 */

/** FNV-1a, 32 бита. Только ASCII/BMP код-юниты (`streamKey`/`prefix` — namespaced id/ULID prefix). */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Один шаг SplitMix32 над 32-битным состоянием. */
export function splitmix32Next(state: number): number {
  let z = (state + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}
