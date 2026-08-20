import { describe, expect, it } from 'vitest';
import { buildReport, exitCodeForOutcome } from './report.ts';

describe('buildReport', () => {
  it('status is pass with no active findings (positive)', () => {
    const report = buildReport({
      check: 'secrets',
      active: [],
      suppressed: [],
      policyVersion: '0.1.0',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(report.status).toBe('pass');
    expect(report.findings).toEqual([]);
  });

  it('status is fail when there is at least one active finding (negative)', () => {
    const report = buildReport({
      check: 'secrets',
      active: [{ id: 'a', severity: 'high', message: 'found' }],
      suppressed: [],
      policyVersion: '0.1.0',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(report.status).toBe('fail');
    expect(report.findings).toHaveLength(1);
  });

  it('omits meta when not provided (negative)', () => {
    const report = buildReport({
      check: 'secrets',
      active: [],
      suppressed: [],
      policyVersion: '0.1.0',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(report.meta).toBeUndefined();
  });

  it('carries check-specific meta through when provided (positive: B1 registry/liveness diagnostics)', () => {
    // A plain literal is fine here (minor9 review finding): static_policy.hardcoded-network-url
    // now only flags URLs inside string literals, and this exact literal is carved out by a
    // scoped, owner-tracked security/exceptions.json entry rather than obfuscated in code —
    // routing around a control via string concatenation was itself the minor9 finding.
    const registryEndpoint = 'https://registry.npmjs.org/';
    const report = buildReport({
      check: 'dependencies',
      active: [],
      suppressed: [],
      policyVersion: '0.1.0',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      meta: { registry_endpoint: registryEndpoint },
    });
    expect(report.meta).toEqual({ registry_endpoint: registryEndpoint });
  });
});

describe('exitCodeForOutcome', () => {
  it('returns 0 for a pass report (positive)', () => {
    const report = buildReport({
      check: 'secrets',
      active: [],
      suppressed: [],
      policyVersion: '0.1.0',
      generatedAt: new Date(),
    });
    expect(exitCodeForOutcome({ kind: 'ok', report })).toBe(0);
  });

  it('returns 1 for a fail report (negative)', () => {
    const report = buildReport({
      check: 'secrets',
      active: [{ id: 'a', severity: 'high', message: 'found' }],
      suppressed: [],
      policyVersion: '0.1.0',
      generatedAt: new Date(),
    });
    expect(exitCodeForOutcome({ kind: 'ok', report })).toBe(1);
  });

  it('returns 2 for a config error (negative)', () => {
    expect(exitCodeForOutcome({ kind: 'config-error', message: 'boom' })).toBe(2);
  });
});
