import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    const paths = collectSourceFiles(repoRoot).files.map((f) => f.path);
    expect(paths.sort()).toEqual([
      'apps/api/src/a.ts',
      'packages/domain/src/b.ts',
      'tools/x/src/c.ts',
    ]);
  });

  it('collects files under scripts/ (positive: N11 — was invisible to the scan before this fix)', () => {
    write('scripts/__probe__/ev.ts', EVAL_LOOKING_CONTENT);
    const paths = collectSourceFiles(repoRoot).files.map((f) => f.path);
    expect(paths).toContain('scripts/__probe__/ev.ts');
  });

  it('collects files under tests/ (positive: N11 — was invisible to the scan before this fix)', () => {
    write('tests/__probe.ts', LLM_IMPORT_LOOKING_CONTENT);
    const paths = collectSourceFiles(repoRoot).files.map((f) => f.path);
    expect(paths).toContain('tests/__probe.ts');
  });

  it('still excludes node_modules/dist/.turbo/coverage even under the newly added scripts/tests roots (negative)', () => {
    write('scripts/node_modules/dep/index.js', 'noise');
    write('tests/dist/generated.js', 'noise');
    const paths = collectSourceFiles(repoRoot).files.map((f) => f.path);
    expect(paths).toEqual([]);
  });

  it('collects explicitly listed root config files when present (positive: N11 — root build/lint configs)', () => {
    write('eslint.config.mjs', 'export default [];');
    write('vitest.config.ts', 'export default {};');
    write('.dependency-cruiser.cjs', 'module.exports = {};');
    const paths = collectSourceFiles(repoRoot).files.map((f) => f.path);
    expect(paths.sort()).toEqual([
      '.dependency-cruiser.cjs',
      'eslint.config.mjs',
      'vitest.config.ts',
    ]);
  });

  it('does not fail when a root config file is absent (negative: optional)', () => {
    write('apps/api/src/a.ts', 'a');
    const result = collectSourceFiles(repoRoot);
    expect(() => collectSourceFiles(repoRoot)).not.toThrow();
    expect(result.unreadablePaths).toEqual([]);
  });

  it('does not walk unrelated top-level directories such as docs/ (negative: scope stays bounded)', () => {
    write('docs/00_README.md', '# not scanned, and not even a scanned extension');
    write('docs/probe.ts', EVAL_LOOKING_CONTENT);
    const paths = collectSourceFiles(repoRoot).files.map((f) => f.path);
    expect(paths).toEqual([]);
  });

  // M-5 (review finding, round 3): a lockfile that fails to read used to be
  // silently treated as "empty" (= confirmed clean) by scan-no-llm.ts. The same
  // class of bug existed here: an unreadable SCAN_ROOT/file/ROOT_CONFIG_FILE was
  // silently dropped, which reads exactly like "there was nothing there" to every
  // caller — `security:static`/`security:no-llm` would report `pass` having never
  // looked at that content. These tests assert the fixed contract: unreadable-but-
  // present paths are surfaced via `unreadablePaths`, distinct from paths that are
  // simply absent (ENOENT), which stay a legitimate, silent skip.

  it('does not report a missing SCAN_ROOT as unreadable (negative: absent is not an error, same convention as an absent root config file)', () => {
    write('apps/api/src/a.ts', 'a'); // packages/tools/scripts/tests are never created in this fixture
    const result = collectSourceFiles(repoRoot);
    expect(result.unreadablePaths).toEqual([]);
  });

  it('reports a SCAN_ROOT as unreadable when it exists but cannot be listed, e.g. a self-referential symlink (positive: M-5 review finding)', () => {
    // A symlink pointing at itself makes readdirSync fail with ELOOP, not ENOENT —
    // "path exists but is not readable", the exact case that must not silently
    // become "no findings here". Deterministic and works even as root (unlike
    // chmod-based permission denial, which root bypasses).
    symlinkSync('scripts', join(repoRoot, 'scripts'));
    const result = collectSourceFiles(repoRoot);
    expect(result.unreadablePaths).toContain('scripts');
    expect(result.files).toEqual([]);
  });

  it('reports an individual file as unreadable when it exists (was listed) but cannot be read, e.g. a self-referential symlink (positive: M-5 review finding)', () => {
    mkdirSync(join(repoRoot, 'apps'), { recursive: true });
    symlinkSync('loop.ts', join(repoRoot, 'apps', 'loop.ts'));
    const result = collectSourceFiles(repoRoot);
    expect(result.unreadablePaths).toContain('apps/loop.ts');
    expect(result.files).toEqual([]);
  });

  it('reports a root config file as unreadable when it exists but cannot be read, e.g. is a directory (positive: M-5 review finding — distinct from "absent")', () => {
    mkdirSync(join(repoRoot, 'eslint.config.mjs'));
    const result = collectSourceFiles(repoRoot);
    expect(result.unreadablePaths).toContain('eslint.config.mjs');
  });
});
