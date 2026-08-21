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

  it('разрешает пути, явно оставленные за lead-ом (режим по умолчанию — lead-audit)', () => {
    const report = checkOwnership(['docs/iterations/I00-x/REPORT.md'], tasks, ['docs/**']);
    expect(report.problems).toEqual([]);
    expect(report.ownedBy['docs/iterations/I00-x/REPORT.md']).toBe('lead');
  });

  it('lead-audit: то же самое явно с mode="lead-audit"', () => {
    const report = checkOwnership(
      ['docs/iterations/I00-x/REPORT.md'],
      tasks,
      ['docs/**'],
      'lead-audit',
    );
    expect(report.problems).toEqual([]);
    expect(report.ownedBy['docs/iterations/I00-x/REPORT.md']).toBe('lead');
  });

  it('N1: task-session — совпадение только с lead_paths это нарушение, а не владение', () => {
    // Ровно воспроизведённый обход: task-сессия удаляет .claude/writeset.json, hook падает на
    // карту задач, и README.md/.claude/** попадают только в lead_paths, не в write_paths ни одной
    // задачи. В режиме 'task-session' это обязано быть проблемой (lead-only), а не ownedBy: 'lead'.
    const report = checkOwnership(
      ['README.md', '.claude/settings.autonomous.json'],
      tasks,
      ['README.md', '.claude/**'],
      'task-session',
    );
    expect(report.ownedBy).toEqual({});
    expect(report.problems).toEqual([
      { kind: 'lead-only', path: 'README.md' },
      { kind: 'lead-only', path: '.claude/settings.autonomous.json' },
    ]);
  });

  it('N1: task-session — путь, не покрытый ни задачей, ни lead_paths, остаётся unowned', () => {
    const report = checkOwnership(
      ['packages/domain/src/rules.ts'],
      tasks,
      ['docs/**'],
      'task-session',
    );
    expect(report.problems).toEqual([{ kind: 'unowned', path: 'packages/domain/src/rules.ts' }]);
  });

  it('N1: task-session — файл внутри write_paths реальной задачи по-прежнему владение задачей', () => {
    const report = checkOwnership(
      ['tools/usage-continuity/src/runner.ts'],
      tasks,
      ['tools/usage-continuity/**'], // даже если lead_paths тоже совпадает — write_paths задачи главнее
      'task-session',
    );
    expect(report.problems).toEqual([]);
    expect(report.ownedBy['tools/usage-continuity/src/runner.ts']).toBe('I00-T02');
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

  describe('cross-iteration (finding раунда I00-F5, живой прогон): overlap только внутри одной итерации', () => {
    it('НЕ считает пересечением, если путь заявлен задачами разных итераций', () => {
      // Точное воспроизведение из отчёта: I00-T04 (итерация I00) и I00-F5-T4 (итерация I00-F5)
      // объявляют один и тот же путь в РАЗНЫХ итерациях, разнесённых во времени — это не конфликт
      // (путь просто правится снова), а не одновременное владение.
      const crossIteration: readonly TaskDeclaration[] = [
        {
          task_id: 'I00-T04',
          owner_role: 'persistence-implementer',
          write_paths: ['packages/persistence/**'],
          iteration_id: 'I00',
        },
        {
          task_id: 'I00-F5-T4',
          owner_role: 'persistence-implementer',
          write_paths: ['packages/persistence/**'],
          iteration_id: 'I00-F5',
        },
      ];
      const report = checkOwnership(
        ['packages/persistence/src/migration-ledger.ts'],
        crossIteration,
      );
      expect(report.problems).toEqual([]);
      // Детерминированный выбор для отчёта — последняя по порядку задача (не смысловой факт).
      expect(report.ownedBy['packages/persistence/src/migration-ledger.ts']).toBe('I00-F5-T4');
    });

    it('всё ещё считает пересечением два владельца ОДНОЙ итерации (регрессия)', () => {
      const sameIteration: readonly TaskDeclaration[] = [
        {
          task_id: 'A',
          owner_role: 'r',
          write_paths: ['apps/**'],
          iteration_id: 'I00-F5',
        },
        {
          task_id: 'B',
          owner_role: 'r',
          write_paths: ['apps/api/**'],
          iteration_id: 'I00-F5',
        },
      ];
      const report = checkOwnership(['apps/api/src/a.ts'], sameIteration);
      expect(report.problems).toEqual([
        { kind: 'overlap', path: 'apps/api/src/a.ts', taskIds: ['A', 'B'] },
      ]);
    });

    it('три итерации, две из которых конфликтуют — конфликт виден, третья не мешает', () => {
      const mixed: readonly TaskDeclaration[] = [
        { task_id: 'OLD', owner_role: 'r', write_paths: ['apps/**'], iteration_id: 'I00' },
        { task_id: 'A', owner_role: 'r', write_paths: ['apps/api/**'], iteration_id: 'I00-F5' },
        { task_id: 'B', owner_role: 'r', write_paths: ['apps/api/**'], iteration_id: 'I00-F5' },
      ];
      const report = checkOwnership(['apps/api/src/a.ts'], mixed);
      expect(report.problems).toEqual([
        { kind: 'overlap', path: 'apps/api/src/a.ts', taskIds: ['A', 'B'] },
      ]);
    });

    it('protected path всё ещё проверяется для выбранного кросс-итерационного владельца', () => {
      const crossIteration: readonly TaskDeclaration[] = [
        {
          task_id: 'I00-T04',
          owner_role: 'persistence-implementer',
          write_paths: ['packages/persistence/**'],
          iteration_id: 'I00',
        },
        {
          task_id: 'I00-F5-T4',
          owner_role: 'persistence-implementer',
          write_paths: ['packages/persistence/**'],
          iteration_id: 'I00-F5',
          // Нет allow_protected_paths для migrations/** — путь ниже обязан остаться protected.
        },
      ];
      const report = checkOwnership(['packages/persistence/src/migrations/001.ts'], crossIteration);
      expect(report.problems).toEqual([
        {
          kind: 'protected',
          path: 'packages/persistence/src/migrations/001.ts',
          taskId: 'I00-F5-T4',
        },
      ]);
    });
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
    expect(formatOwnershipProblem({ kind: 'lead-only', path: 'README.md' })).toContain('lead');
  });
});
