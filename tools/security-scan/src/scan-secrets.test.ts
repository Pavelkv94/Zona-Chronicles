import { describe, expect, it } from 'vitest';
import {
  AWS_ACCESS_KEY_ID_SAMPLE,
  CLEAN_SOURCE_SAMPLE,
  DOTENV_STYLE_SAMPLE,
  GENERIC_SECRET_ASSIGNMENT_SAMPLE,
  PEM_PRIVATE_KEY_SAMPLE,
} from './__fixtures__/secret-samples.ts';
import { findSecrets } from './scan-secrets.ts';
import type { SecurityPolicy } from './policy.ts';
import { parsePolicy } from './policy.ts';
import { readFileSync } from 'node:fs';

const loadRealPolicy = (): SecurityPolicy => {
  const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
  const result = parsePolicy(raw);
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.policy;
};

const policy = loadRealPolicy();

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
});
