import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyLicensePolicy,
  classifyLicense,
  parseLicensesJson,
  partitionGraphs,
} from './scan-licenses.ts';
import { parsePolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';

const loadRealPolicy = (): SecurityPolicy => {
  const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
  const result = parsePolicy(raw);
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.policy;
};

const policy = loadRealPolicy();

const sampleLicensesJson = (license: string, name: string): string =>
  JSON.stringify({
    [license]: [{ name, versions: ['1.0.0'], license, paths: [`/node_modules/${name}`] }],
  });

describe('parseLicensesJson', () => {
  it('parses a well-formed pnpm licenses list --json result (positive)', () => {
    const result = parseLicensesJson(sampleLicensesJson('MIT', 'left-pad'));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.packages).toEqual([{ name: 'left-pad', version: '1.0.0', license: 'MIT' }]);
    }
  });

  it('fails closed on malformed JSON (negative)', () => {
    expect(parseLicensesJson('not json').kind).toBe('invalid');
  });

  it('fails closed when a license group is not an array (negative: unexpected format)', () => {
    expect(parseLicensesJson(JSON.stringify({ MIT: 'oops' })).kind).toBe('invalid');
  });
});

describe('partitionGraphs (M2/M3: production/development boundary)', () => {
  it('classifies a package present in both graphs as production, not dev-only (positive)', () => {
    const pkg = { name: 'left-pad', version: '1.0.0', license: 'MIT' };
    const result = partitionGraphs({ production: [pkg], full: [pkg] });
    expect(result.productionPackages).toEqual([pkg]);
    expect(result.devOnlyPackages).toEqual([]);
  });

  it('classifies a package present only in the full graph as dev-only (positive)', () => {
    const prodPkg = { name: 'left-pad', version: '1.0.0', license: 'MIT' };
    const devPkg = { name: 'lightningcss', version: '1.33.0', license: 'MPL-2.0' };
    const result = partitionGraphs({ production: [prodPkg], full: [prodPkg, devPkg] });
    expect(result.productionPackages).toEqual([prodPkg]);
    expect(result.devOnlyPackages).toEqual([devPkg]);
  });
});

describe('classifyLicense (M2/M3: production vs development allowlist)', () => {
  it('allows an allowed license in the production graph (negative: no finding)', () => {
    expect(classifyLicense('MIT', 'production', policy.license_policy)).toBe('ok');
  });

  it('blocks a denied license in the production graph regardless of split (positive)', () => {
    expect(classifyLicense('GPL-3.0', 'production', policy.license_policy)).toBe('denied');
  });

  it('blocks a denied license in the development graph too — denied is common/strict (positive)', () => {
    expect(classifyLicense('GPL-3.0', 'development', policy.license_policy)).toBe('denied');
  });

  it('allows a dev-only weak-copyleft license (MPL-2.0) in the development graph (positive: requirement #5)', () => {
    expect(classifyLicense('MPL-2.0', 'development', policy.license_policy)).toBe('ok');
  });

  it('flags the SAME dev-only license (MPL-2.0) as a boundary leak when found in the production graph (positive: requirement #5, executable boundary assertion)', () => {
    expect(classifyLicense('MPL-2.0', 'production', policy.license_policy)).toBe('dev-only-leak');
  });

  it('flags an unknown license as review-required in the production graph (positive: requirement #5)', () => {
    expect(classifyLicense('WTFPL', 'production', policy.license_policy)).toBe('review-required');
  });

  it('flags an unknown license as review-required in the development graph too (positive: requirement #5)', () => {
    expect(classifyLicense('WTFPL', 'development', policy.license_policy)).toBe('review-required');
  });
});

describe('applyLicensePolicy (M2/M3 end-to-end + m7 severity gating)', () => {
  it('allows a production package under an allowed license (negative: no finding)', () => {
    const findings = applyLicensePolicy(
      {
        productionPackages: [{ name: 'left-pad', version: '1.0.0', license: 'MIT' }],
        devOnlyPackages: [],
      },
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('allows lightningcss (MPL-2.0) when it is dev-only — no platform-specific exception needed (positive: M2/M3 root fix)', () => {
    const findings = applyLicensePolicy(
      {
        productionPackages: [],
        devOnlyPackages: [{ name: 'lightningcss', version: '1.33.0', license: 'MPL-2.0' }],
      },
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('blocks the same MPL-2.0 package when it appears in the production graph (positive: dev-only allowlist does not leak)', () => {
    const findings = applyLicensePolicy(
      {
        productionPackages: [{ name: 'lightningcss', version: '1.33.0', license: 'MPL-2.0' }],
        devOnlyPackages: [],
      },
      policy,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/production-графе/);
  });

  it('blocks a package under a denied copyleft license (positive)', () => {
    const findings = applyLicensePolicy(
      {
        productionPackages: [{ name: 'copyleft-thing', version: '1.0.0', license: 'GPL-3.0' }],
        devOnlyPackages: [],
      },
      policy,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.package).toBe('copyleft-thing@1.0.0');
  });

  it('flags an unknown license as review_required, blocking the check (positive)', () => {
    const findings = applyLicensePolicy(
      {
        productionPackages: [{ name: 'mystery-thing', version: '1.0.0', license: 'WTFPL' }],
        devOnlyPackages: [],
      },
      policy,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/review_required/);
  });

  it('drops findings below license_policy.min_blocking_severity (m7)', () => {
    const lowThresholdPolicy: SecurityPolicy = {
      ...policy,
      license_policy: { ...policy.license_policy, min_blocking_severity: 'critical' },
    };
    const findings = applyLicensePolicy(
      {
        productionPackages: [{ name: 'copyleft-thing', version: '1.0.0', license: 'GPL-3.0' }],
        devOnlyPackages: [],
      },
      lowThresholdPolicy,
    );
    // denied license findings are severity "high"; raising the threshold to "critical"
    // must drop them — proves min_blocking_severity is actually applied (m7).
    expect(findings).toEqual([]);
  });
});
