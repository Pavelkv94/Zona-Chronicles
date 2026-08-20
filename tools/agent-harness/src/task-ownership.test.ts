import { describe, expect, it } from 'vitest';
import { checkOwnership, formatOwnershipProblem } from './task-ownership.ts';
import type { TaskDeclaration } from './task-ownership.ts';

const tasks: readonly TaskDeclaration[] = [
  {
    task_id: 'I00-T02',
    owner_role: 'tooling-implementer',
    write_paths: ['tools/usage-continuity/**'],
  },
  {
    task_id: 'I00-T03',
    owner_role: 'tooling-implementer',
    write_paths: ['apps/api/**', 'apps/worker/**'],
  },
  {
    task_id: 'I00-T04',
    owner_role: 'persistence-implementer',
    write_paths: ['packages/persistence/**'],
  },
];

describe('checkOwnership', () => {
  it('назначает владельца каждому изменённому файлу', () => {
    const report = checkOwnership(
      ['tools/usage-continuity/src/runner.ts', 'apps/api/src/server.ts'],
      tasks,
    );
    expect(report.problems).toEqual([]);
    expect(report.ownedBy['tools/usage-continuity/src/runner.ts']).toBe('I00-T02');
    expect(report.ownedBy['apps/api/src/server.ts']).toBe('I00-T03');
  });

  it('находит файл без владельца', () => {
    const report = checkOwnership(['packages/domain/src/rules.ts'], tasks);
    expect(report.problems).toEqual([{ kind: 'unowned', path: 'packages/domain/src/rules.ts' }]);
  });

  it('разрешает пути, явно оставленные за lead-ом', () => {
    const report = checkOwnership(['docs/iterations/I00-x/REPORT.md'], tasks, ['docs/**']);
    expect(report.problems).toEqual([]);
    expect(report.ownedBy['docs/iterations/I00-x/REPORT.md']).toBe('lead');
  });

  it('находит пересечение write sets', () => {
    const overlapping: readonly TaskDeclaration[] = [
      { task_id: 'A', owner_role: 'r', write_paths: ['apps/**'] },
      { task_id: 'B', owner_role: 'r', write_paths: ['apps/api/**'] },
    ];
    const report = checkOwnership(['apps/api/src/a.ts'], overlapping);
    expect(report.problems).toEqual([
      { kind: 'overlap', path: 'apps/api/src/a.ts', taskIds: ['A', 'B'] },
    ]);
  });

  it('запрещает protected path даже владельцу без явного разрешения', () => {
    const report = checkOwnership(['packages/persistence/src/migrations/001.ts'], tasks);
    expect(report.problems).toEqual([
      { kind: 'protected', path: 'packages/persistence/src/migrations/001.ts', taskId: 'I00-T04' },
    ]);
  });

  it('пропускает protected path, выданный задаче явно', () => {
    const report = checkOwnership(
      ['packages/persistence/src/migrations/001.ts'],
      [
        {
          task_id: 'I00-T04',
          owner_role: 'persistence-implementer',
          write_paths: ['packages/persistence/**'],
          allow_protected_paths: ['packages/persistence/src/migrations/**'],
        },
      ],
    );
    expect(report.problems).toEqual([]);
  });

  it('секреты запрещены любой задаче', () => {
    const report = checkOwnership(['.env'], tasks);
    expect(report.problems).toEqual([{ kind: 'human-only', path: '.env' }]);
  });
});

describe('formatOwnershipProblem', () => {
  it('объясняет каждое нарушение', () => {
    expect(formatOwnershipProblem({ kind: 'unowned', path: 'a.ts' })).toContain('не принадлежит');
    expect(
      formatOwnershipProblem({ kind: 'overlap', path: 'a.ts', taskIds: ['A', 'B'] }),
    ).toContain('A, B');
    expect(formatOwnershipProblem({ kind: 'protected', path: 'a.ts', taskId: 'T' })).toContain(
      'protected',
    );
    expect(formatOwnershipProblem({ kind: 'human-only', path: '.env' })).toContain('человек');
  });
});
