/**
 * I01 — differential proof of `packages/contracts`' hand-rolled SHA-256 against `node:crypto`.
 *
 * `packages/contracts` cannot use `node:crypto` itself (see `sha256.ts`'s own doc comment):
 * it is a leaf package whose schemas travel to a web client, and `randomUUID`/`getRandomValues`
 * make `crypto` a banned source of nondeterminism under SIM-01/ADR-003 regardless. The FIPS
 * 180-4 known-answer vectors in `packages/contracts/src/sha256.test.ts` prove the
 * implementation against inputs the author thought to check. This file proves it against an
 * independent implementation, on inputs the author did not hand-pick.
 *
 * Expected to be GREEN immediately: `sha256Hex`/`sha256HexOfBytes` already exist and are
 * implemented (I01-T1, contract freeze `b7bc7d2`). This is the one file in this task that is
 * not supposed to be red.
 *
 * ## Why the generator is built this way, not left uniformly random
 *
 * A uniformly random string generator almost never lands on a SHA-256 padding-block boundary
 * (55-65 and 119-120 UTF-8 bytes — where the mandatory `0x80` padding byte plus the 64-bit
 * length field either fits in the current 64-byte block or forces a second one) or produces
 * multi-byte UTF-8 (Cyrillic, non-BMP emoji encoded as UTF-16 surrogate pairs) densely enough to
 * exercise `TextEncoder`'s surrogate handling. This is not hypothetical caution: I00's
 * property test for leap-century handling used a generator capped at `day <= 28`, so it never
 * reached the month boundary it existed to check, and stayed green over a real defect. The
 * generator below is required, not merely encouraged, to hit: 55-65 and 119-120 UTF-8 bytes
 * exactly; Cyrillic and non-BMP emoji mixed into those exact boundary lengths; and the empty
 * string.
 */
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@zona/contracts';

function nodeCryptoSha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

const CYRILLIC_UNIT = 'п'; // 2 UTF-8 bytes
const EMOJI_UNIT = '\u{1F600}'; // U+1F600, 4 UTF-8 bytes, a UTF-16 surrogate pair in JS strings

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Builds a string whose UTF-8 byte length is exactly `targetBytes`, mixing 1-byte ASCII,
 * 2-byte Cyrillic and 4-byte non-BMP-emoji units. `mixSeed` only decides the MIX — how many of
 * each multi-byte unit go in, and in what order — never the total length: the byte length is
 * exact by construction (verified by a self-check below), not a probable outcome.
 */
function buildExactByteLength(targetBytes: number, mixSeed: number): string {
  let remaining = targetBytes;
  const emojiBytes = utf8ByteLength(EMOJI_UNIT);
  const cyrillicBytes = utf8ByteLength(CYRILLIC_UNIT);

  const maxEmoji = Math.floor(remaining / emojiBytes);
  const emojiCount = maxEmoji === 0 ? 0 : mixSeed % (maxEmoji + 1);
  remaining -= emojiCount * emojiBytes;

  const maxCyrillic = Math.floor(remaining / cyrillicBytes);
  const cyrillicCount = maxCyrillic === 0 ? 0 : Math.floor(mixSeed / 7) % (maxCyrillic + 1);
  remaining -= cyrillicCount * cyrillicBytes;

  // Whatever bytes are left are filled 1-for-1 with ASCII: any remainder (including 0) works,
  // since ASCII is exactly 1 byte per character.
  const asciiCount = remaining;

  const units = [
    ...Array<string>(emojiCount).fill(EMOJI_UNIT),
    ...Array<string>(cyrillicCount).fill(CYRILLIC_UNIT),
    ...Array<string>(asciiCount).fill('a'),
  ];

  // Seeded interleave rather than a fixed emoji-then-cyrillic-then-ascii concatenation: a fixed
  // order would never place a multi-byte character mid-block, which is exactly the placement a
  // hand-rolled block/padding implementation is most likely to mishandle.
  for (let i = units.length - 1; i > 0; i -= 1) {
    const j = (mixSeed + i * 2_654_435_761) % (i + 1);
    const tmp = units[i]!;
    units[i] = units[j]!;
    units[j] = tmp;
  }

  const result = units.join('');
  if (utf8ByteLength(result) !== targetBytes) {
    // The generator itself must be trustworthy, not merely "should be right by arithmetic":
    // a silent off-by-one here would quietly stop testing the boundary it claims to cover.
    throw new Error(
      `generator built a string of ${utf8ByteLength(result)} UTF-8 bytes, not the requested ${targetBytes}`,
    );
  }
  return result;
}

/** 55-65: crosses the "does the 0x80 padding byte + 8-byte length fit in this 64-byte block"
 *  line. 119-120: crosses the same line one block later. */
const BOUNDARY_BYTE_LENGTHS = [55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 119, 120] as const;

const boundaryMultibyteString = fc
  .tuple(fc.constantFrom(...BOUNDARY_BYTE_LENGTHS), fc.nat())
  .map(([length, seed]) => buildExactByteLength(length, seed));

describe('sha256Hex — differential against node:crypto', () => {
  it('matches node:crypto on generic random strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (input) => {
        expect(sha256Hex(input)).toBe(nodeCryptoSha256Hex(input));
      }),
      { numRuns: 500 },
    );
  });

  it('matches node:crypto exactly at SHA-256 padding-block boundaries (55-65 and 119-120 UTF-8 bytes), with Cyrillic/emoji mixed into the boundary itself', () => {
    fc.assert(
      fc.property(boundaryMultibyteString, (input) => {
        expect(sha256Hex(input)).toBe(nodeCryptoSha256Hex(input));
      }),
      { numRuns: 300 },
    );
  });

  it.each([
    ['empty input', ''],
    ['pure Cyrillic', 'привет, мир! как поживаешь сегодня?'],
    ['pure non-BMP emoji (surrogate pairs)', '😀😀😀😀😀'],
    ['mixed Cyrillic+emoji at the 56-byte boundary', buildExactByteLength(56, 12_345)],
    ['mixed Cyrillic+emoji at the 120-byte boundary', buildExactByteLength(120, 987)],
    ['a lone low surrogate half (invalid UTF-16, WTF-8 edge case)', 'a\uD800b'],
  ])('matches node:crypto for %s', (_label, input) => {
    expect(sha256Hex(input)).toBe(nodeCryptoSha256Hex(input));
  });
});
