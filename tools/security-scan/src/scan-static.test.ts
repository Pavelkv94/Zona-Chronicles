import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHILD_PROCESS_TEMPLATE_SAMPLE,
  CLEAN_STATIC_SAMPLE,
  DOC_DOMAIN_URL_SAMPLES,
  EVAL_CALL_SAMPLE,
  HARDCODED_URL_SAMPLE,
  LOOPBACK_LOOKALIKE_URL_SAMPLES,
  LOOPBACK_URL_SAMPLES,
  NEW_FUNCTION_SAMPLE,
} from './__fixtures__/static-samples.ts';
import { findStaticFindings, runStaticScan } from './scan-static.ts';
import { parsePolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';

const loadRealPolicy = (): SecurityPolicy => {
  const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
  const result = parsePolicy(raw);
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.policy;
};

const policy = loadRealPolicy();

const REAL_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('findStaticFindings', () => {
  it('flags eval calls (positive)', () => {
    const findings = findStaticFindings(
      [{ path: 'packages/domain/src/x.ts', content: EVAL_CALL_SAMPLE }],
      policy,
    );
    expect(findings.some((f) => f.id === 'eval-call')).toBe(true);
  });

  it('flags new-Function calls (positive)', () => {
    const findings = findStaticFindings(
      [{ path: 'packages/domain/src/x.ts', content: NEW_FUNCTION_SAMPLE }],
      policy,
    );
    expect(findings.some((f) => f.id === 'new-function')).toBe(true);
  });

  it('flags child_process exec with template interpolation (positive)', () => {
    const findings = findStaticFindings(
      [{ path: 'tools/x/src/y.ts', content: CHILD_PROCESS_TEMPLATE_SAMPLE }],
      policy,
    );
    expect(findings.some((f) => f.id === 'child-process-template-interpolation')).toBe(true);
  });

  it('flags a hardcoded http(s) URL (positive)', () => {
    const findings = findStaticFindings(
      [{ path: 'apps/api/src/z.ts', content: HARDCODED_URL_SAMPLE }],
      policy,
    );
    expect(findings.some((f) => f.id === 'hardcoded-network-url')).toBe(true);
  });

  /**
   * I03: границы сужения `hardcoded-network-url`. Три теста, потому что сужение может провалиться
   * тремя разными способами: не сработать вовсе, сработать слишком широко или сработать по
   * подстроке. Первое сделало бы gate шумным, второе — слепым, третье — обходимым.
   */
  it('does not flag loopback addresses (negative: собственный процесс — не внешний канал)', () => {
    const findings = findStaticFindings(
      [{ path: 'apps/api/src/config.ts', content: LOOPBACK_URL_SAMPLES }],
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('does not flag RFC 2606 .example documentation names (negative)', () => {
    const findings = findStaticFindings(
      [{ path: 'apps/api/src/config.test.ts', content: DOC_DOMAIN_URL_SAMPLES }],
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('still flags an external host that merely CONTAINS a loopback or doc name (positive: сужение привязано к концу адреса, а не к подстроке)', () => {
    const findings = findStaticFindings(
      [{ path: 'apps/api/src/z.ts', content: LOOPBACK_LOOKALIKE_URL_SAMPLES }],
      policy,
    );
    expect(findings.filter((f) => f.id === 'hardcoded-network-url')).toHaveLength(2);
  });

  it('does not flag safe execFileSync usage with array args (negative)', () => {
    const findings = findStaticFindings(
      [{ path: 'tools/x/src/y.ts', content: CLEAN_STATIC_SAMPLE }],
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('skips files matching static_policy.allowlisted_paths (negative: allowlist)', () => {
    const findings = findStaticFindings(
      [
        {
          path: 'tools/security-scan/src/__fixtures__/static-samples.ts',
          content: EVAL_CALL_SAMPLE,
        },
      ],
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('drops low-severity findings (hardcoded-network-url) below a raised static_policy.min_blocking_severity (m7: severity was previously ignored)', () => {
    const highThresholdPolicy: SecurityPolicy = {
      ...policy,
      static_policy: { ...policy.static_policy, min_blocking_severity: 'high' },
    };
    const findings = findStaticFindings(
      [{ path: 'apps/api/src/z.ts', content: HARDCODED_URL_SAMPLE }],
      highThresholdPolicy,
    );
    expect(findings).toEqual([]);
  });

  it('still flags a high-severity construct (eval-call) even with a raised threshold (positive: severity, not the whole check, is what changes)', () => {
    const highThresholdPolicy: SecurityPolicy = {
      ...policy,
      static_policy: { ...policy.static_policy, min_blocking_severity: 'high' },
    };
    const findings = findStaticFindings(
      [{ path: 'packages/domain/src/x.ts', content: EVAL_CALL_SAMPLE }],
      highThresholdPolicy,
    );
    expect(findings.some((f) => f.id === 'eval-call')).toBe(true);
  });
});

/**
 * M-5 (review finding, round 3): `collectSourceFiles` now surfaces unreadable
 * scan-root paths instead of silently dropping them (`source-files.ts`). This
 * covers the `scan-static.ts` consumer side of that fix: a `pass` must not be
 * possible when part of the scanned tree could not actually be read.
 */
describe('runStaticScan (io integration: M-5 review finding)', () => {
  let fixtureRepoRoot: string | undefined;

  afterEach(() => {
    if (fixtureRepoRoot !== undefined) rmSync(fixtureRepoRoot, { recursive: true, force: true });
    fixtureRepoRoot = undefined;
  });

  const buildFixtureRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zona-static-scan-'));
    mkdirSync(join(dir, 'security'), { recursive: true });
    writeFileSync(
      join(dir, 'security', 'policy.json'),
      readFileSync(join(REAL_REPO_ROOT, 'security', 'policy.json'), 'utf8'),
      'utf8',
    );
    writeFileSync(join(dir, 'security', 'exceptions.json'), '[]\n', 'utf8');
    fixtureRepoRoot = dir;
    return dir;
  };

  it('returns config-error, not pass, when a source file under a SCAN_ROOT exists but cannot be read (positive: M-5 review finding)', () => {
    const dir = buildFixtureRepo();
    mkdirSync(join(dir, 'apps', 'api', 'src'), { recursive: true });
    // Self-referential symlink -> ELOOP on read, "exists but unreadable" (not "absent").
    symlinkSync('loop.ts', join(dir, 'apps', 'api', 'src', 'loop.ts'));

    const outcome = runStaticScan(dir);

    expect(outcome.kind).toBe('config-error');
  });

  it('returns pass for a clean, fully readable fixture repo (negative: the happy path still works after the fix)', () => {
    const dir = buildFixtureRepo();
    mkdirSync(join(dir, 'apps', 'api', 'src'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'api', 'src', 'clean.ts'), CLEAN_STATIC_SAMPLE, 'utf8');

    const outcome = runStaticScan(dir);

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.report.status).toBe('pass');
  });
});
