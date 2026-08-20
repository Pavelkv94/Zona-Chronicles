import { describe, expect, it } from 'vitest';
import { findDiffViolations, formatViolations } from './diff-violations.ts';
import type { WriteSet } from './writeset.ts';

const writeSet: WriteSet = {
  task_id: 'I00-T03',
  owner_role: 'tooling-implementer',
  write_paths: ['apps/api/**', 'apps/worker/**'],
};

describe('findDiffViolations', () => {
  it('не находит нарушений, когда diff внутри write set', () => {
    const violations = findDiffViolations(
      ['apps/api/src/server.ts', 'apps/worker/src/main.ts'],
      writeSet,
    );
    expect(violations).toEqual([]);
  });

  it('находит protected path', () => {
    const violations = findDiffViolations(['apps/api/src/server.ts', 'pnpm-lock.yaml'], writeSet);
    expect(violations).toEqual([{ path: 'pnpm-lock.yaml', rule: 'protected-path' }]);
  });

  it('находит запись вне write set', () => {
    const violations = findDiffViolations(['packages/domain/src/a.ts'], writeSet);
    expect(violations).toEqual([{ path: 'packages/domain/src/a.ts', rule: 'outside-write-set' }]);
  });

  it('находит секреты отдельным правилом', () => {
    expect(findDiffViolations(['.env'], writeSet)).toEqual([{ path: '.env', rule: 'human-only' }]);
  });

  it('игнорирует пустые строки вывода git', () => {
    expect(findDiffViolations(['', 'apps/api/src/server.ts'], writeSet)).toEqual([]);
  });

  it('учитывает явно выданный protected path', () => {
    const violations = findDiffViolations(['packages/contracts/src/index.ts'], {
      task_id: 'I01-T01',
      owner_role: 'contract-steward',
      write_paths: ['packages/contracts/**'],
      allow_protected_paths: ['packages/contracts/**'],
    });
    expect(violations).toEqual([]);
  });
});

describe('formatViolations', () => {
  it('перечисляет путь, правило и способ исправления', () => {
    const message = formatViolations(
      [{ path: 'pnpm-lock.yaml', rule: 'protected-path' }],
      'I00-T03',
    );
    expect(message).toContain('I00-T03');
    expect(message).toContain('pnpm-lock.yaml (protected-path)');
    expect(message).toContain('orchestrator/lead');
  });
});
