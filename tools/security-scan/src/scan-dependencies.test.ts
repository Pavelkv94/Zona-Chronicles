import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyDependencyPolicy, parseAuditJson } from './scan-dependencies.ts';
import { parsePolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';

const loadRealPolicy = (): SecurityPolicy => {
  const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
  const result = parsePolicy(raw);
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.policy;
};

const policy = loadRealPolicy();

describe('parseAuditJson', () => {
  it('parses a clean audit result with no advisories (positive)', () => {
    const result = parseAuditJson(JSON.stringify({ advisories: {}, metadata: {} }));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.advisories).toEqual([]);
  });

  it('parses an audit result with a high-severity advisory (positive)', () => {
    const raw = JSON.stringify({
      advisories: {
        '1001': {
          id: 1001,
          module_name: 'left-pad',
          severity: 'high',
          title: 'Example vulnerability',
          url: 'advisory-reference-not-a-url',
        },
      },
    });
    const result = parseAuditJson(raw);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.advisories).toEqual([
        {
          id: '1001',
          package: 'left-pad',
          severity: 'high',
          title: 'Example vulnerability',
          url: 'advisory-reference-not-a-url',
        },
      ]);
    }
  });

  it('fails closed on malformed JSON (negative)', () => {
    const result = parseAuditJson('not json at all');
    expect(result.kind).toBe('invalid');
  });

  it('fails closed when "advisories" key is missing (negative: unexpected format)', () => {
    const result = parseAuditJson(JSON.stringify({ metadata: {} }));
    expect(result.kind).toBe('invalid');
  });
});

describe('applyDependencyPolicy', () => {
  it('blocks an advisory at or above min_blocking_severity (positive)', () => {
    const findings = applyDependencyPolicy(
      [{ id: '1', package: 'left-pad', severity: 'critical', title: 't', url: 'u' }],
      policy,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.package).toBe('left-pad');
  });

  it('does not block an advisory below min_blocking_severity (negative)', () => {
    const findings = applyDependencyPolicy(
      [{ id: '1', package: 'left-pad', severity: 'low', title: 't', url: 'u' }],
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('blocks an advisory with an unknown severity per unknown_severity_behavior=block (positive)', () => {
    const findings = applyDependencyPolicy(
      [{ id: '1', package: 'left-pad', severity: 'mystery', title: 't', url: 'u' }],
      policy,
    );
    expect(findings).toHaveLength(1);
  });
});
