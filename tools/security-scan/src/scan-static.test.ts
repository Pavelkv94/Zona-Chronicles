import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHILD_PROCESS_TEMPLATE_SAMPLE,
  CLEAN_STATIC_SAMPLE,
  EVAL_CALL_SAMPLE,
  HARDCODED_URL_SAMPLE,
  NEW_FUNCTION_SAMPLE,
} from './__fixtures__/static-samples.ts';
import { findStaticFindings } from './scan-static.ts';
import { parsePolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';

const loadRealPolicy = (): SecurityPolicy => {
  const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
  const result = parsePolicy(raw);
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.policy;
};

const policy = loadRealPolicy();

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
