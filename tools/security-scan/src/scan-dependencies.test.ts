import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyDependencyPolicy,
  evaluateLivenessProbe,
  parseAuditJson,
  runDependenciesScan,
  type Advisory,
  type DependenciesScanIo,
} from './scan-dependencies.ts';
import { parsePolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';

const loadRealPolicy = (): SecurityPolicy => {
  const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
  const result = parsePolicy(raw);
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.policy;
};

const policy = loadRealPolicy();

// Repo root used only to load the real `security/policy.json`/`security/exceptions.json`
// (checked-in fixtures, deterministic) — the audit/liveness-probe/registry io itself is
// always injected below, so these tests never touch the network or spawn a subprocess.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const emptyAdvisoriesAuditJson = JSON.stringify({ advisories: {}, metadata: {} });

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
          installedVersions: [],
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

describe('evaluateLivenessProbe (B1)', () => {
  it('treats a fixture probe with known advisories as confirmed-live (positive)', () => {
    const outcome = evaluateLivenessProbe({
      kind: 'ok',
      advisories: [
        { id: '1', package: 'minimatch', severity: 'high', title: 'ReDoS', url: 'u' },
        { id: '2', package: 'minimatch', severity: 'high', title: 'ReDoS 2', url: 'u' },
      ],
    });
    expect(outcome).toEqual({ kind: 'live', fixtureAdvisoryCount: 2 });
  });

  it('treats an empty fixture probe result as unconfirmed — this is exactly the B1 fail-open shape (negative)', () => {
    const outcome = evaluateLivenessProbe({ kind: 'ok', advisories: [] });
    expect(outcome.kind).toBe('unconfirmed');
  });

  it('treats an invalid/malformed fixture probe response as unconfirmed (negative)', () => {
    const outcome = evaluateLivenessProbe({ kind: 'invalid', reason: 'boom' });
    expect(outcome.kind).toBe('unconfirmed');
    if (outcome.kind === 'unconfirmed') expect(outcome.reason).toMatch(/boom/);
  });
});

describe('parseAuditJson — minor2: extracts installed versions from findings[]', () => {
  it('collects deduped versions from the "findings" array (positive: real npm-audit-v1 shape)', () => {
    const raw = JSON.stringify({
      advisories: {
        '1096485': {
          id: 1096485,
          module_name: 'minimatch',
          severity: 'high',
          title: 'ReDoS',
          url: 'u',
          findings: [
            { version: '3.0.4', paths: ['.>minimatch'] },
            { version: '3.0.4', paths: ['.>dev>minimatch'] },
          ],
        },
      },
    });
    const result = parseAuditJson(raw);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.advisories[0]?.installedVersions).toEqual(['3.0.4']);
    }
  });

  it('is empty when the "findings" array is absent (negative: simplified/legacy shape)', () => {
    const raw = JSON.stringify({
      advisories: {
        '1': { id: 1, module_name: 'left-pad', severity: 'high', title: 't', url: 'u' },
      },
    });
    const result = parseAuditJson(raw);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.advisories[0]?.installedVersions).toEqual([]);
  });
});

describe('applyDependencyPolicy — minor2: package identifier includes @version only when unambiguous', () => {
  const advisoryWith = (installedVersions: readonly string[] | undefined): Advisory => ({
    id: '1',
    package: 'left-pad',
    severity: 'critical',
    title: 't',
    url: 'u',
    ...(installedVersions !== undefined ? { installedVersions } : {}),
  });

  it('qualifies the finding package as name@version when exactly one installed version is known (positive: enables exceptions.json package@version scope)', () => {
    const findings = applyDependencyPolicy([advisoryWith(['1.2.3'])], policy);
    expect(findings[0]?.package).toBe('left-pad@1.2.3');
  });

  it('keeps the bare package name when no installed version is known (negative: ambiguous)', () => {
    const findings = applyDependencyPolicy([advisoryWith([])], policy);
    expect(findings[0]?.package).toBe('left-pad');
  });

  it('keeps the bare package name when the advisory affects more than one installed version (negative: ambiguous, cannot pick one)', () => {
    const findings = applyDependencyPolicy([advisoryWith(['1.2.3', '1.2.4'])], policy);
    expect(findings[0]?.package).toBe('left-pad');
  });

  it('keeps the bare package name when installedVersions is entirely absent (negative: backward compatible with simplified fixtures)', () => {
    const findings = applyDependencyPolicy([advisoryWith(undefined)], policy);
    expect(findings[0]?.package).toBe('left-pad');
  });
});

describe('runDependenciesScan (N4: proves the wiring "empty advisories -> mandatory liveness probe -> config-error", not just the pure evaluateLivenessProbe function)', () => {
  const fakeResolveRegistry: DependenciesScanIo['resolveRegistryEndpoint'] = () =>
    'fake-registry-for-test';

  it('returns config-error when advisories are empty AND the liveness probe is unconfirmed (positive: N4 — exactly the B1 fail-open shape; review reproduced this by mutating `if (probeResult.kind === "unconfirmed")` to `if (false)`)', () => {
    const io: DependenciesScanIo = {
      runAudit: () => ({ ok: true, stdout: emptyAdvisoriesAuditJson }),
      runLivenessProbe: () => ({ kind: 'ok', advisories: [] }),
      resolveRegistryEndpoint: fakeResolveRegistry,
    };
    const outcome = runDependenciesScan(repoRoot, new Date('2026-01-01T00:00:00.000Z'), io);
    expect(outcome.kind).toBe('config-error');
    if (outcome.kind === 'config-error') {
      expect(outcome.message).toMatch(/пустой набор advisories не подтверждён/);
    }
  });

  it('returns ok/pass when advisories are empty but the liveness probe IS confirmed live (negative: proves the branch is not simply always config-error)', () => {
    const io: DependenciesScanIo = {
      runAudit: () => ({ ok: true, stdout: emptyAdvisoriesAuditJson }),
      runLivenessProbe: () => ({
        kind: 'ok',
        advisories: [{ id: '1', package: 'minimatch', severity: 'high', title: 'ReDoS', url: 'u' }],
      }),
      resolveRegistryEndpoint: fakeResolveRegistry,
    };
    const outcome = runDependenciesScan(repoRoot, new Date('2026-01-01T00:00:00.000Z'), io);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.report.status).toBe('pass');
  });

  it('skips the liveness probe entirely when the audit already returned real advisories (positive: probe would be redundant, endpoint already proven live)', () => {
    let probeCalled = false;
    const io: DependenciesScanIo = {
      runAudit: () => ({
        ok: true,
        stdout: JSON.stringify({
          advisories: {
            '1': {
              id: 1,
              module_name: 'left-pad',
              severity: 'critical',
              title: 'known vuln',
              url: 'u',
            },
          },
        }),
      }),
      runLivenessProbe: () => {
        probeCalled = true;
        return { kind: 'ok', advisories: [] };
      },
      resolveRegistryEndpoint: fakeResolveRegistry,
    };
    const outcome = runDependenciesScan(repoRoot, new Date('2026-01-01T00:00:00.000Z'), io);
    expect(probeCalled).toBe(false);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') expect(outcome.report.status).toBe('fail');
  });
});
