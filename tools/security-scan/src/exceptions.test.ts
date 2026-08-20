import { describe, expect, it } from 'vitest';
import { applyExceptions, parseExceptions } from './exceptions.ts';

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
