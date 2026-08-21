/**
 * SHA-256 (FIPS 180-4) чистой функцией, без `node:crypto`.
 *
 * Причина не в изобретательстве, а в границе пакета: `packages/contracts` живёт под запретом
 * ADR-003/SIM-01 на источники недетерминизма, и `crypto` закрыт там одновременно как глобал и
 * как импорт — потому что `crypto.randomUUID`/`getRandomValues` недетерминированы. Просить
 * исключение ради `createHash` означало бы открыть в правиле дыру, ширина которой не
 * проверяется ничем. Тот же выбор уже сделан в `instant.ts`, где `Date.UTC` заменён на
 * целочисленный `daysFromCivil`.
 *
 * Функция чистая: одна и та же строка даёт один и тот же hex на любой машине, локали и
 * часовом поясе. Это прямое требование канонического checksum (`09_EVENT_AND_COMMAND_CONTRACTS`
 * §9, SIM-01).
 */

/** Первые 32 бита дробных частей кубических корней первых 64 простых чисел (FIPS 180-4 §4.2.2). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Первые 32 бита дробных частей квадратных корней первых 8 простых чисел (FIPS 180-4 §5.3.3). */
const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const HEX_DIGITS = '0123456789abcdef';

function rotr(word: number, bits: number): number {
  return ((word >>> bits) | (word << (32 - bits))) >>> 0;
}

const utf8Encoder = new TextEncoder();

/**
 * Длина сообщения в битах как пара 32-битных слов (big-endian) для padding-блока.
 *
 * Вынесено из `sha256HexOfBytes` не ради красоты: старшее слово отлично от нуля только для
 * входа от 512 МиБ, и внутри hash-функции эта ветка не проверяема в gate. Наивный `>>> 32`
 * в JavaScript равен `>>> 0` и молча вернул бы младшее слово в обоих позициях.
 */
export function messageLengthBitWords(byteLength: number): readonly [number, number] {
  const bitLength = byteLength * 8;
  return [Math.floor(bitLength / 0x1_0000_0000), bitLength >>> 0];
}

/** SHA-256 над UTF-8 байтами строки; возвращает 64 hex-символа в нижнем регистре. */
export function sha256Hex(input: string): string {
  return sha256HexOfBytes(utf8Encoder.encode(input));
}

/** SHA-256 над готовыми байтами — точка входа для не-строковых входов. */
export function sha256HexOfBytes(bytes: Uint8Array): string {
  // Padding: 0x80, затем нули до 56 mod 64, затем 64-битная длина в битах (big-endian).
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  // Длина пишется как 64 бита; разбор на слова — в `messageLengthBitWords`.
  const view = new DataView(padded.buffer);
  const [highLengthWord, lowLengthWord] = messageLengthBitWords(bytes.length);
  view.setUint32(paddedLength - 8, highLengthWord, false);
  view.setUint32(paddedLength - 4, lowLengthWord, false);

  const hash = new Uint32Array(INITIAL_HASH);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;

    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  let hex = '';
  for (const word of hash) {
    for (let shift = 28; shift >= 0; shift -= 4) {
      hex += HEX_DIGITS[(word >>> shift) & 0xf];
    }
  }
  return hex;
}
