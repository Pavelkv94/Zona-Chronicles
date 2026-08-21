import { afterEach, describe, expect, it } from 'vitest';
import {
  AWS_ACCESS_KEY_ID_SAMPLE,
  CLEAN_SOURCE_SAMPLE,
  DOTENV_STYLE_SAMPLE,
  GENERIC_SECRET_ASSIGNMENT_SAMPLE,
  PEM_PRIVATE_KEY_SAMPLE,
} from './__fixtures__/secret-samples.ts';
import { findSecrets, runSecretsScan } from './scan-secrets.ts';
import type { SecurityPolicy } from './policy.ts';
import { parsePolicy } from './policy.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const loadRealPolicy = (): SecurityPolicy => {
  const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
  const result = parsePolicy(raw);
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.policy;
};

const policy = loadRealPolicy();

const REAL_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('findSecrets', () => {
  it('detects a PEM private key (positive)', () => {
    const findings = findSecrets([{ path: 'app.ts', content: PEM_PRIVATE_KEY_SAMPLE }], policy);
    expect(findings.some((f) => f.id === 'pem-private-key')).toBe(true);
  });

  it('detects an AWS access key id (positive)', () => {
    const findings = findSecrets([{ path: 'app.ts', content: AWS_ACCESS_KEY_ID_SAMPLE }], policy);
    expect(findings.some((f) => f.id === 'aws-access-key-id')).toBe(true);
  });

  it('detects a generic api_key/secret/token assignment (positive)', () => {
    const findings = findSecrets(
      [{ path: 'app.ts', content: GENERIC_SECRET_ASSIGNMENT_SAMPLE }],
      policy,
    );
    expect(findings.some((f) => f.id === 'generic-secret-assignment')).toBe(true);
  });

  it('detects a dotenv-style assignment line (positive)', () => {
    const findings = findSecrets([{ path: '.env.local', content: DOTENV_STYLE_SAMPLE }], policy);
    expect(findings.some((f) => f.id === 'dotenv-style-assignment')).toBe(true);
  });

  it('finds nothing in clean source (negative)', () => {
    const findings = findSecrets([{ path: 'app.ts', content: CLEAN_SOURCE_SAMPLE }], policy);
    expect(findings).toEqual([]);
  });

  it('skips a file whose path matches secret_policy.allowlisted_paths (negative: allowlist)', () => {
    const findings = findSecrets(
      [
        {
          path: 'tools/security-scan/src/__fixtures__/secret-samples.ts',
          content: PEM_PRIVATE_KEY_SAMPLE,
        },
      ],
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('still flags the same content at a non-allowlisted path (positive: allowlist is path-specific)', () => {
    const findings = findSecrets(
      [{ path: 'apps/api/src/leaked.ts', content: PEM_PRIVATE_KEY_SAMPLE }],
      policy,
    );
    expect(findings.some((f) => f.id === 'pem-private-key')).toBe(true);
  });

  it('drops findings below secret_policy.min_blocking_severity (m7: severity was previously ignored)', () => {
    const highThresholdPolicy: SecurityPolicy = {
      ...policy,
      secret_policy: { ...policy.secret_policy, min_blocking_severity: 'critical' },
    };
    // dotenv-style-assignment is severity "moderate" — below a "critical" threshold.
    const findings = findSecrets(
      [{ path: '.env.local', content: DOTENV_STYLE_SAMPLE }],
      highThresholdPolicy,
    );
    expect(findings).toEqual([]);
  });

  it('still flags a critical-severity pattern (PEM key) even with a raised threshold (positive: severity, not the whole check, is what changes)', () => {
    const highThresholdPolicy: SecurityPolicy = {
      ...policy,
      secret_policy: { ...policy.secret_policy, min_blocking_severity: 'critical' },
    };
    const findings = findSecrets(
      [{ path: 'app.ts', content: PEM_PRIVATE_KEY_SAMPLE }],
      highThresholdPolicy,
    );
    expect(findings.some((f) => f.id === 'pem-private-key')).toBe(true);
  });
});

/**
 * M-5 (review finding, round 3): `readTrackedFiles` now surfaces tracked-but-
 * unreadable paths instead of silently dropping them (`git.ts`). This covers
 * the `scan-secrets.ts` consumer side of that fix: a `pass` must not be
 * possible when a tracked file could not actually be read.
 */
describe('runSecretsScan (io integration: M-5 review finding)', () => {
  let fixtureRepoRoot: string | undefined;

  afterEach(() => {
    if (fixtureRepoRoot !== undefined) rmSync(fixtureRepoRoot, { recursive: true, force: true });
    fixtureRepoRoot = undefined;
  });

  const buildFixtureRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zona-secrets-scan-'));
    mkdirSync(join(dir, 'security'), { recursive: true });
    writeFileSync(
      join(dir, 'security', 'policy.json'),
      readFileSync(join(REAL_REPO_ROOT, 'security', 'policy.json'), 'utf8'),
      'utf8',
    );
    writeFileSync(join(dir, 'security', 'exceptions.json'), '[]\n', 'utf8');
    spawnSync('git', ['init', '-q'], { cwd: dir });
    fixtureRepoRoot = dir;
    return dir;
  };

  it('returns config-error, not pass, when a tracked file is deleted from disk after being tracked (positive: M-5 review finding)', () => {
    const dir = buildFixtureRepo();
    writeFileSync(join(dir, 'a.ts'), CLEAN_SOURCE_SAMPLE, 'utf8');
    spawnSync('git', ['add', 'a.ts'], { cwd: dir });
    // Still tracked (staged), but no longer readable — `git ls-files` still lists it.
    rmSync(join(dir, 'a.ts'));

    const outcome = runSecretsScan(dir);

    expect(outcome.kind).toBe('config-error');
  });

  it('returns pass for a clean, fully readable fixture repo (negative: the happy path still works after the fix)', () => {
    const dir = buildFixtureRepo();
    writeFileSync(join(dir, 'a.ts'), CLEAN_SOURCE_SAMPLE, 'utf8');
    spawnSync('git', ['add', 'a.ts'], { cwd: dir });

    const outcome = runSecretsScan(dir);

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.report.status).toBe('pass');
  });
});
