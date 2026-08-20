import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePolicy } from './policy.ts';

describe('parsePolicy', () => {
  it('parses the real security/policy.json without error (positive)', () => {
    const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
    const result = parsePolicy(raw);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.policy.dependency_policy.min_blocking_severity).toBe('high');
      expect(result.policy.license_policy.allowed).toContain('MIT');
      expect(result.policy.secret_policy.patterns.length).toBeGreaterThan(0);
    }
  });

  it('rejects invalid JSON (negative)', () => {
    const result = parsePolicy('{not json');
    expect(result.kind).toBe('invalid');
  });

  it('rejects a policy missing a required section (negative)', () => {
    const result = parsePolicy(JSON.stringify({ policy_version: '0.0.0' }));
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toMatch(/dependency_policy/);
    }
  });
});
