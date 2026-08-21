import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEAN_IMPORT_SAMPLE,
  EMBEDDINGS_DIR_PATH_SAMPLE,
  ENV_VAR_DOTENV_SAMPLE,
  ENV_VAR_USAGE_SAMPLE,
  IMPORT_STATEMENT_SAMPLE,
  LOCKFILE_LINE_SAMPLE,
  PACKAGE_JSON_SAMPLE,
  PROMPTS_DIR_PATH_SAMPLE,
  REQUIRE_CALL_SAMPLE,
} from './__fixtures__/no-llm-samples.ts';
import { findLlmFindings, runNoLlmScan } from './scan-no-llm.ts';
import { parsePolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';

const loadRealPolicy = (): SecurityPolicy => {
  const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
  const result = parsePolicy(raw);
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.policy;
};

const policy = loadRealPolicy();

// Real repo root, used only to seed the throwaway fixture repos below with the real,
// checked-in `security/policy.json` — deterministic, no network. The rest of each
// fixture repo (lockfile, git history, tracked files) is built fresh per test.
const REAL_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const emptyInput = {
  lockfileContent: '',
  packageJsonFiles: [],
  sourceFiles: [],
  trackedPaths: [],
  trackedFilesForEnv: [],
};

describe('findLlmFindings', () => {
  it('flags a denied package imported from source (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        sourceFiles: [{ path: 'apps/worker/src/x.ts', content: IMPORT_STATEMENT_SAMPLE }],
      },
      policy,
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags a denied package required via require() (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        sourceFiles: [{ path: 'apps/worker/src/x.ts', content: REQUIRE_CALL_SAMPLE }],
      },
      policy,
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags a denied scoped package present in pnpm-lock.yaml (positive)', () => {
    const findings = findLlmFindings(
      { ...emptyInput, lockfileContent: LOCKFILE_LINE_SAMPLE },
      policy,
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags a denied package declared in package.json devDependencies (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        packageJsonFiles: [{ path: 'apps/worker/package.json', content: PACKAGE_JSON_SAMPLE }],
      },
      policy,
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags a tracked path under a prompts/ directory (positive)', () => {
    const findings = findLlmFindings(
      { ...emptyInput, trackedPaths: [PROMPTS_DIR_PATH_SAMPLE] },
      policy,
    );
    expect(findings.some((f) => f.id === 'llm-directory')).toBe(true);
  });

  it('flags a tracked path under an embeddings/ directory (positive)', () => {
    const findings = findLlmFindings(
      { ...emptyInput, trackedPaths: [EMBEDDINGS_DIR_PATH_SAMPLE] },
      policy,
    );
    expect(findings.some((f) => f.id === 'llm-directory')).toBe(true);
  });

  it('flags a provider API key read from process.env (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        trackedFilesForEnv: [{ path: 'apps/worker/src/x.ts', content: ENV_VAR_USAGE_SAMPLE }],
      },
      policy,
    );
    expect(findings.some((f) => f.id === 'llm-env-var')).toBe(true);
  });

  it('flags a provider API key set in a dotenv-style assignment (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        trackedFilesForEnv: [{ path: '.env.local', content: ENV_VAR_DOTENV_SAMPLE }],
      },
      policy,
    );
    expect(findings.some((f) => f.id === 'llm-env-var')).toBe(true);
  });

  it('finds nothing for clean, unrelated input (negative)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        sourceFiles: [{ path: 'apps/worker/src/x.ts', content: CLEAN_IMPORT_SAMPLE }],
      },
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('skips source files matching llm_policy.allowlisted_paths (negative: allowlist)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        sourceFiles: [
          {
            path: 'tools/security-scan/src/__fixtures__/no-llm-samples.ts',
            content: IMPORT_STATEMENT_SAMPLE,
          },
        ],
      },
      policy,
    );
    expect(findings).toEqual([]);
  });
});

/**
 * M-5 (review finding, round 3): `runNoLlmScan` used to treat an unreadable
 * `pnpm-lock.yaml` as an EMPTY lockfile — which passes every
 * `packageNameRegex(denied).test(...)` check trivially, so ACCEPTANCE A11
 * ("lockfile does not contain a provider SDK") reported `pass` having verified
 * nothing. These tests exercise the real io path end-to-end (not the pure
 * `findLlmFindings`), because that is exactly where the bug lived: the pure
 * function was never wrong, `collectInput`'s error handling was.
 */
describe('runNoLlmScan (io integration: M-5 review finding)', () => {
  let fixtureRepoRoot: string | undefined;

  afterEach(() => {
    if (fixtureRepoRoot !== undefined) rmSync(fixtureRepoRoot, { recursive: true, force: true });
    fixtureRepoRoot = undefined;
  });

  /**
   * io: builds a throwaway git repo OUTSIDE the real repo tree, seeded with the
   * real `security/policy.json` (checked-in, deterministic) and an empty, valid
   * `security/exceptions.json`. `git init` is required because `runNoLlmScan`
   * shells out to `git ls-files` (see `git.ts`); a bare tmpdir with no `.git`
   * would fail that call entirely, which is a different failure mode than the
   * one under test here.
   */
  const buildFixtureRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zona-no-llm-scan-'));
    mkdirSync(join(dir, 'security'), { recursive: true });
    writeFileSync(
      join(dir, 'security', 'policy.json'),
      readFileSync(join(REAL_REPO_ROOT, 'security', 'policy.json'), 'utf8'),
      'utf8',
    );
    writeFileSync(join(dir, 'security', 'exceptions.json'), '[]\n', 'utf8');
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    fixtureRepoRoot = dir;
    return dir;
  };

  it('returns config-error, not pass, when pnpm-lock.yaml exists but cannot be read (positive: M-5 review finding)', () => {
    const dir = buildFixtureRepo();
    // A directory in place of the lockfile makes readFileSync fail with EISDIR —
    // "exists but unreadable", not "absent". Deterministic and root-safe (unlike
    // chmod-based permission denial).
    mkdirSync(join(dir, 'pnpm-lock.yaml'));

    const outcome = runNoLlmScan(dir);

    expect(outcome.kind).toBe('config-error');
  });

  it('returns pass for a clean, readable fixture repo (negative: the happy path still works after the fix)', () => {
    const dir = buildFixtureRepo();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');

    const outcome = runNoLlmScan(dir);

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.report.status).toBe('pass');
  });
});
