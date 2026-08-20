import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyLicensePolicy, parseLicensesJson } from './scan-licenses.ts';
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

describe('applyLicensePolicy', () => {
  it('allows a package under an allowed license (negative: no finding)', () => {
    const findings = applyLicensePolicy(
      [{ name: 'left-pad', version: '1.0.0', license: 'MIT' }],
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('blocks a package under a denied copyleft license (positive)', () => {
    const findings = applyLicensePolicy(
      [{ name: 'copyleft-thing', version: '1.0.0', license: 'GPL-3.0' }],
      policy,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.package).toBe('copyleft-thing@1.0.0');
  });

  it('flags an unknown license as review_required, blocking the check (positive)', () => {
    const findings = applyLicensePolicy(
      [{ name: 'mystery-thing', version: '1.0.0', license: 'MPL-2.0' }],
      policy,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/review_required/);
  });
});
