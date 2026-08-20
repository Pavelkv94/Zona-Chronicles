import { describe, expect, it } from 'vitest';
import { matchesAnyGlob, matchesGlob } from './glob.ts';

describe('matchesGlob', () => {
  it('matches an exact path (positive)', () => {
    expect(matchesGlob('security/policy.json', 'security/policy.json')).toBe(true);
  });

  it('matches nested paths under a ** prefix (positive)', () => {
    expect(matchesGlob('tools/security-scan/src/__fixtures__/foo.ts', '**/__fixtures__/**')).toBe(
      true,
    );
  });

  it('does not match an unrelated path (negative)', () => {
    expect(matchesGlob('packages/domain/src/index.ts', '**/__fixtures__/**')).toBe(false);
  });
});

describe('matchesAnyGlob', () => {
  it('matches when at least one pattern matches (positive)', () => {
    expect(matchesAnyGlob('security/exceptions.json', ['*.md', 'security/*.json'])).toBe(true);
  });

  it('returns false when no pattern matches (negative)', () => {
    expect(matchesAnyGlob('security/exceptions.json', ['*.md', 'docs/**'])).toBe(false);
  });
});
