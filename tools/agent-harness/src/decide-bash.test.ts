import { describe, expect, it } from 'vitest';
import { decideBashCommand, decideBashForSession } from './decide-bash.ts';
import type { WriteSetLoadResult } from './writeset.ts';

describe('decideBashCommand — разрешено', () => {
  it.each([
    'pnpm test:unit',
    'pnpm lint',
    'pnpm vitest run --project unit',
    'git status',
    'git diff --name-only HEAD',
    'git add tools/usage-continuity/src/runner.ts',
    'git commit -m "I00-T02: continuity runner"',
    'node scripts/security/scan-secrets.ts',
    'ls -la',
  ])('%s', (command) => {
    expect(decideBashCommand(command).decision).toBe('allow');
  });
});

describe('decideBashCommand — запрещено task-сессии', () => {
  it.each([
    ['pnpm install', 'зависимост'],
    ['pnpm add fastify', 'зависимост'],
    ['npm i -D vitest', 'зависимост'],
    ['yarn upgrade', 'зависимост'],
    ['corepack prepare pnpm@11 --activate', 'package manager'],
    ['git push origin HEAD', 'Интеграцию веток'],
    ['git merge iteration/I00-harness', 'Интеграцию веток'],
    ['git rebase main', 'Интеграцию веток'],
    ['git reset --hard HEAD~1', 'Destructive reset'],
    ['git stash push -u', 'stash'],
    ['git clean -fd', 'удаление'],
    ['git commit -m "x" --no-verify', 'Обход pre-commit'],
  ])('%s', (command, expectedFragment) => {
    const result = decideBashCommand(command);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain(expectedFragment);
  });

  it('видит запрещённую команду внутри цепочки', () => {
    expect(decideBashCommand('pnpm lint && git push origin HEAD').decision).toBe('deny');
  });

  it('не зависит от лишних пробелов', () => {
    expect(decideBashCommand('git    push   origin   HEAD').decision).toBe('deny');
  });
});

describe('decideBashForSession — B2: роль + write set', () => {
  const validWriteSet: WriteSetLoadResult = {
    kind: 'task',
    writeSet: {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    },
  };

  it('task-сессия с валидным write set: обычная команда разрешена', () => {
    const result = decideBashForSession({
      command: 'pnpm test:unit',
      sessionRole: 'task',
      writeSet: validWriteSet,
    });
    expect(result.decision).toBe('allow');
  });

  it('task-сессия с валидным write set: lead-only команда всё равно запрещена', () => {
    const result = decideBashForSession({
      command: 'git push origin HEAD',
      sessionRole: 'task',
      writeSet: validWriteSet,
    });
    expect(result.decision).toBe('deny');
  });

  it('task-сессия без write set (никогда не объявлен): deny даже безобидной команде', () => {
    const result = decideBashForSession({
      command: 'ls -la',
      sessionRole: 'task',
      writeSet: { kind: 'lead' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('без объявленного write set');
  });

  it('task-сессия после удаления writeset.json: deny (та же форма kind: lead)', () => {
    // Регрессия: `rm -f .claude/writeset.json` во время task-сессии переводит loadWriteSet
    // в тот же результат, что и «файл никогда не существовал» — оба обязаны деноситься.
    const result = decideBashForSession({
      command: 'pnpm lint',
      sessionRole: 'task',
      writeSet: { kind: 'lead' },
    });
    expect(result.decision).toBe('deny');
  });

  it('task-сессия с повреждённым writeset.json: fail-closed', () => {
    const result = decideBashForSession({
      command: 'ls',
      sessionRole: 'task',
      writeSet: { kind: 'invalid', reason: 'битый JSON' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Fail-closed');
  });

  it('lead-сессия: ограничений нет даже без write set', () => {
    const result = decideBashForSession({
      command: 'git push origin HEAD',
      sessionRole: 'lead',
      writeSet: { kind: 'lead' },
    });
    expect(result.decision).toBe('allow');
  });

  it('lead-сессия: ограничений нет, даже если на диске случайно лежит writeset.json', () => {
    const result = decideBashForSession({
      command: 'pnpm install',
      sessionRole: 'lead',
      writeSet: validWriteSet,
    });
    expect(result.decision).toBe('allow');
  });
});
