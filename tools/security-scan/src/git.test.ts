import { describe, expect, it } from 'vitest';
import { parseNullSeparatedList } from './git.ts';

describe('parseNullSeparatedList', () => {
  it('splits NUL-separated git output into paths (positive)', () => {
    expect(parseNullSeparatedList('a.ts\0b/c.ts\0')).toEqual(['a.ts', 'b/c.ts']);
  });

  it('returns an empty array for empty output (negative)', () => {
    expect(parseNullSeparatedList('')).toEqual([]);
  });
});
