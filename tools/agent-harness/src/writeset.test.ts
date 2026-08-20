import { describe, expect, it } from 'vitest';
import { loadWriteSet, parseWriteSet } from './writeset.ts';

describe('parseWriteSet', () => {
  it('принимает валидный write set', () => {
    const result = parseWriteSet(
      JSON.stringify({
        task_id: 'I00-T02',
        owner_role: 'tooling-implementer',
        write_paths: ['tools/**'],
      }),
    );
    expect(result.kind).toBe('task');
  });

  it('отклоняет невалидный JSON', () => {
    expect(parseWriteSet('{').kind).toBe('invalid');
  });

  it('требует task_id, owner_role и непустой write_paths', () => {
    expect(parseWriteSet(JSON.stringify({ owner_role: 'x', write_paths: ['a'] })).kind).toBe(
      'invalid',
    );
    expect(parseWriteSet(JSON.stringify({ task_id: 'x', write_paths: ['a'] })).kind).toBe(
      'invalid',
    );
    expect(
      parseWriteSet(JSON.stringify({ task_id: 'x', owner_role: 'y', write_paths: [] })).kind,
    ).toBe('invalid');
  });

  it('отклоняет allow_protected_paths неверного типа', () => {
    const result = parseWriteSet(
      JSON.stringify({
        task_id: 'x',
        owner_role: 'y',
        write_paths: ['a'],
        allow_protected_paths: 'packages/**',
      }),
    );
    expect(result.kind).toBe('invalid');
  });
});

describe('loadWriteSet', () => {
  it('отсутствие файла означает lead-сессию', () => {
    expect(loadWriteSet('/nonexistent/writeset.json').kind).toBe('lead');
  });
});
