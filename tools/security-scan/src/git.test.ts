import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNullSeparatedList, readTrackedFiles } from './git.ts';

describe('parseNullSeparatedList', () => {
  it('splits NUL-separated git output into paths (positive)', () => {
    expect(parseNullSeparatedList('a.ts\0b/c.ts\0')).toEqual(['a.ts', 'b/c.ts']);
  });

  it('returns an empty array for empty output (negative)', () => {
    expect(parseNullSeparatedList('')).toEqual([]);
  });
});

describe('readTrackedFiles', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'zona-read-tracked-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('collects readable tracked files (positive)', () => {
    writeFileSync(join(repoRoot, 'a.ts'), 'content', 'utf8');
    const result = readTrackedFiles(repoRoot, ['a.ts']);
    expect(result.files).toEqual([{ path: 'a.ts', content: 'content' }]);
    expect(result.unreadablePaths).toEqual([]);
  });

  // M-5 (review finding, round 3): a tracked-but-unreadable path (deleted after
  // `git ls-files -z`, EACCES, etc.) used to be silently dropped — indistinguishable
  // from "there was nothing to find here" to every caller (scan-no-llm.ts,
  // scan-secrets.ts). It must now be surfaced, not swallowed.
  it('reports a tracked path as unreadable instead of silently dropping it when the file cannot be read (positive: M-5 review finding)', () => {
    const result = readTrackedFiles(repoRoot, ['deleted-after-listing.ts']);
    expect(result.files).toEqual([]);
    expect(result.unreadablePaths).toEqual(['deleted-after-listing.ts']);
  });

  it('reports a tracked path as unreadable when it exists but cannot be read, e.g. a self-referential symlink (positive: M-5 review finding)', () => {
    symlinkSync('loop.ts', join(repoRoot, 'loop.ts'));
    const result = readTrackedFiles(repoRoot, ['loop.ts']);
    expect(result.files).toEqual([]);
    expect(result.unreadablePaths).toEqual(['loop.ts']);
  });

  it('collects the readable files and reports only the unreadable ones for a mixed input (negative: partial failure does not lose the readable files)', () => {
    writeFileSync(join(repoRoot, 'ok.ts'), 'ok', 'utf8');
    const result = readTrackedFiles(repoRoot, ['ok.ts', 'missing.ts']);
    expect(result.files).toEqual([{ path: 'ok.ts', content: 'ok' }]);
    expect(result.unreadablePaths).toEqual(['missing.ts']);
  });
});
