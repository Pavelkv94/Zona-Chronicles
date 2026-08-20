import { describe, expect, it } from 'vitest';
import { applyExceptions, parseExceptions, type CheckName } from './exceptions.ts';

const NOW = new Date('2026-08-20T00:00:00.000Z');

const valid = {
  id: 'exc-001',
  check: 'dependencies' as const,
  scope: 'lodash',
  reason: 'Обоснование для теста',
  compensating_control: 'Компенсирующий контроль для теста',
  owner: 'security-owner',
  created_at: '2026-01-01',
  expiry: '2099-01-01',
};

describe('parseExceptions', () => {
  it('accepts an empty array (positive, matches the shipped security/exceptions.json)', () => {
    const result = parseExceptions('[]', NOW);
    expect(result.valid).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('accepts a well-formed exception (positive)', () => {
    const result = parseExceptions(JSON.stringify([valid]), NOW);
    expect(result.errors).toEqual([]);
    expect(result.valid).toHaveLength(1);
  });

  it('rejects an exception missing a required field (negative: owner)', () => {
    const { owner: _owner, ...withoutOwner } = valid;
    const result = parseExceptions(JSON.stringify([withoutOwner]), NOW);
    expect(result.valid).toHaveLength(0);
    expect(result.errors.some((error) => error.message.includes('owner'))).toBe(true);
    expect(result.errors[0]?.check).toBe('dependencies');
  });

  it('rejects scope equal to "*" (negative: blanket)', () => {
    const result = parseExceptions(JSON.stringify([{ ...valid, scope: '*' }]), NOW);
    expect(result.valid).toHaveLength(0);
    expect(result.errors.some((error) => /blanket|wildcard/i.test(error.message))).toBe(true);
  });

  it('rejects scope containing only wildcard characters (negative: blanket)', () => {
    const result = parseExceptions(JSON.stringify([{ ...valid, scope: '**' }]), NOW);
    expect(result.valid).toHaveLength(0);
  });

  it('rejects scope containing a wildcard alongside a real path (negative: no partial wildcards)', () => {
    const result = parseExceptions(JSON.stringify([{ ...valid, scope: 'packages/*' }]), NOW);
    expect(result.valid).toHaveLength(0);
  });

  it('rejects an expired exception, compared against injected now (negative)', () => {
    const result = parseExceptions(JSON.stringify([{ ...valid, expiry: '2020-01-01' }]), NOW);
    expect(result.valid).toHaveLength(0);
    expect(result.errors.some((error) => /expir/i.test(error.message))).toBe(true);
  });

  it('rejects duplicate ids, invalidating all entries sharing the id (negative)', () => {
    const duplicate = { ...valid, scope: 'other-package' };
    const result = parseExceptions(JSON.stringify([valid, duplicate]), NOW);
    expect(result.valid).toHaveLength(0);
    expect(result.errors.some((error) => /duplicate/i.test(error.message))).toBe(true);
  });

  it('rejects malformed top-level JSON (negative)', () => {
    const result = parseExceptions('{not an array', NOW);
    expect(result.valid).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-array JSON value (negative)', () => {
    const result = parseExceptions(JSON.stringify({ foo: 'bar' }), NOW);
    expect(result.valid).toHaveLength(0);
  });
});

describe('applyExceptions', () => {
  const findings = [
    { id: 'lodash', severity: 'high' as const, package: 'lodash', message: 'known vulnerability' },
    {
      id: 'left-pad',
      severity: 'high' as const,
      package: 'left-pad',
      message: 'known vulnerability',
    },
  ];

  it('suppresses a finding whose package/path exactly matches a valid exception scope for this check (positive)', () => {
    const result = applyExceptions(findings, [valid], 'dependencies');
    expect(result.active.map((f) => f.id)).toEqual(['left-pad']);
    expect(result.suppressed.map((f) => f.id)).toEqual(['lodash']);
  });

  it('does not suppress findings for a different check (negative)', () => {
    const result = applyExceptions(findings, [valid], 'secrets');
    expect(result.active).toHaveLength(2);
    expect(result.suppressed).toHaveLength(0);
  });
});

describe('applyExceptions — M1: rule/category id must not act as a blanket scope', () => {
  /**
   * `finding.id` is an exact per-instance identifier ONLY for `check === 'dependencies'`
   * (npm advisory id). For every other check it names a RULE/CATEGORY shared by every
   * matching instance in the repo. An exception whose `scope` equals that rule name must
   * suppress NOTHING — only an exact `path`/`package` scope may suppress. One test per
   * check (M1 review finding).
   */
  const exceptionFor = (check: CheckName, scope: string) => ({
    ...valid,
    id: `exc-${check}`,
    check,
    scope,
  });

  it('secrets: an exception scoped to the pattern id ("aws-access-key-id") does not suppress any finding at any path (negative: category collapse)', () => {
    const secretFindings = [
      { id: 'aws-access-key-id', severity: 'critical', path: 'apps/api/src/a.ts', message: 'x' },
      { id: 'aws-access-key-id', severity: 'critical', path: 'apps/api/src/b.ts', message: 'x' },
    ];
    const result = applyExceptions(
      secretFindings,
      [exceptionFor('secrets', 'aws-access-key-id')],
      'secrets',
    );
    expect(result.suppressed).toHaveLength(0);
    expect(result.active).toHaveLength(2);
  });

  it('static: an exception scoped to the construct id ("eval-call") does not suppress any finding at any path (negative: category collapse)', () => {
    const staticFindings = [
      { id: 'eval-call', severity: 'high', path: 'packages/domain/src/a.ts', message: 'x' },
      { id: 'eval-call', severity: 'high', path: 'packages/domain/src/b.ts', message: 'x' },
    ];
    const result = applyExceptions(staticFindings, [exceptionFor('static', 'eval-call')], 'static');
    expect(result.suppressed).toHaveLength(0);
    expect(result.active).toHaveLength(2);
  });

  it('no-llm: an exception scoped to the finding id ("llm-import") does not suppress every LLM import repo-wide (negative: category collapse — this is exactly the ADR-006 gate the review flagged)', () => {
    const llmFindings = [
      {
        id: 'llm-import',
        severity: 'critical',
        path: 'apps/worker/src/a.ts',
        package: 'openai',
        message: 'x',
      },
      {
        id: 'llm-import',
        severity: 'critical',
        path: 'apps/worker/src/b.ts',
        package: '@anthropic-ai/sdk',
        message: 'x',
      },
    ];
    const result = applyExceptions(llmFindings, [exceptionFor('no-llm', 'llm-import')], 'no-llm');
    expect(result.suppressed).toHaveLength(0);
    expect(result.active).toHaveLength(2);
  });

  it('licenses: an exception scoped to the license string ("GPL-3.0") does not suppress every package under that license (negative: category collapse)', () => {
    const licenseFindings = [
      { id: 'GPL-3.0', severity: 'high', package: 'copyleft-a@1.0.0', message: 'x' },
      { id: 'GPL-3.0', severity: 'high', package: 'copyleft-b@2.0.0', message: 'x' },
    ];
    const result = applyExceptions(
      licenseFindings,
      [exceptionFor('licenses', 'GPL-3.0')],
      'licenses',
    );
    expect(result.suppressed).toHaveLength(0);
    expect(result.active).toHaveLength(2);
  });

  it('licenses: a legitimate exception scoped to an exact package suppresses only that package (positive: exact scope still works)', () => {
    const licenseFindings = [
      { id: 'GPL-3.0', severity: 'high', package: 'copyleft-a@1.0.0', message: 'x' },
      { id: 'GPL-3.0', severity: 'high', package: 'copyleft-b@2.0.0', message: 'x' },
    ];
    const result = applyExceptions(
      licenseFindings,
      [exceptionFor('licenses', 'copyleft-a@1.0.0')],
      'licenses',
    );
    expect(result.suppressed.map((f) => f.package)).toEqual(['copyleft-a@1.0.0']);
    expect(result.active.map((f) => f.package)).toEqual(['copyleft-b@2.0.0']);
  });

  it('dependencies: an exception scoped to the advisory id DOES suppress that instance (positive: id matching is only valid for dependencies)', () => {
    const dependencyFindings = [
      { id: '1001', severity: 'high', package: 'left-pad', message: 'x' },
      { id: '1002', severity: 'high', package: 'left-pad', message: 'x' },
    ];
    const result = applyExceptions(
      dependencyFindings,
      [exceptionFor('dependencies', '1001')],
      'dependencies',
    );
    expect(result.suppressed.map((f) => f.id)).toEqual(['1001']);
    expect(result.active.map((f) => f.id)).toEqual(['1002']);
  });
});
