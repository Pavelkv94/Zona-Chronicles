import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectSourceFiles } from './source-files.ts';

/**
 * N11 (review finding): `collectSourceFiles` used to walk only `apps/`, `packages/`,
 * `tools/` — `scripts/` and `tests/` were invisible to `security:static`/`security:no-llm`.
 * These tests build a throwaway repo-shaped directory tree (outside the real repo) and
 * assert on the io function itself, since the pure `findStaticFindings`/`findLlmFindings`
 * functions already accept an arbitrary file list and can't demonstrate this gap on
 * their own — the bug lives entirely in which files get collected.
 */

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'zona-source-files-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

const write = (relativePath: string, content: string): void => {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
};

// This test file itself lives under `tools/**` and is always scanned. Fixture
// content only needs to prove a *path* was collected (these tests never run
// findStaticFindings/findLlmFindings), so dangerous-looking substrings are built
// by concatenation — same convention as __fixtures__/static-samples.ts and
// __fixtures__/no-llm-samples.ts — to avoid self-triggering security:static /
// security:no-llm on this file and on scripts/security/scan-*.ts's own source.
const EVAL_LOOKING_CONTENT = `${['ev', 'al'].join('')}("2+2")`;
const LLM_IMPORT_LOOKING_CONTENT = `import Thing from ${['"open', 'ai"'].join('')};`;

describe('collectSourceFiles', () => {
  it('collects files under apps/packages/tools (positive: unchanged pre-N11 coverage)', () => {
    write('apps/api/src/a.ts', 'a');
    write('packages/domain/src/b.ts', 'b');
    write('tools/x/src/c.ts', 'c');
    const paths = collectSourceFiles(repoRoot).map((f) => f.path);
    expect(paths.sort()).toEqual([
      'apps/api/src/a.ts',
      'packages/domain/src/b.ts',
      'tools/x/src/c.ts',
    ]);
  });

  it('collects files under scripts/ (positive: N11 — was invisible to the scan before this fix)', () => {
    write('scripts/__probe__/ev.ts', EVAL_LOOKING_CONTENT);
    const paths = collectSourceFiles(repoRoot).map((f) => f.path);
    expect(paths).toContain('scripts/__probe__/ev.ts');
  });

  it('collects files under tests/ (positive: N11 — was invisible to the scan before this fix)', () => {
    write('tests/__probe.ts', LLM_IMPORT_LOOKING_CONTENT);
    const paths = collectSourceFiles(repoRoot).map((f) => f.path);
    expect(paths).toContain('tests/__probe.ts');
  });

  it('still excludes node_modules/dist/.turbo/coverage even under the newly added scripts/tests roots (negative)', () => {
    write('scripts/node_modules/dep/index.js', 'noise');
    write('tests/dist/generated.js', 'noise');
    const paths = collectSourceFiles(repoRoot).map((f) => f.path);
    expect(paths).toEqual([]);
  });

  it('collects explicitly listed root config files when present (positive: N11 — root build/lint configs)', () => {
    write('eslint.config.mjs', 'export default [];');
    write('vitest.config.ts', 'export default {};');
    write('.dependency-cruiser.cjs', 'module.exports = {};');
    const paths = collectSourceFiles(repoRoot).map((f) => f.path);
    expect(paths.sort()).toEqual([
      '.dependency-cruiser.cjs',
      'eslint.config.mjs',
      'vitest.config.ts',
    ]);
  });

  it('does not fail when a root config file is absent (negative: optional)', () => {
    write('apps/api/src/a.ts', 'a');
    expect(() => collectSourceFiles(repoRoot)).not.toThrow();
  });

  it('does not walk unrelated top-level directories such as docs/ (negative: scope stays bounded)', () => {
    write('docs/00_README.md', '# not scanned, and not even a scanned extension');
    write('docs/probe.ts', EVAL_LOOKING_CONTENT);
    const paths = collectSourceFiles(repoRoot).map((f) => f.path);
    expect(paths).toEqual([]);
  });
});
