import { describe, expect, it } from 'vitest';
import { decideBashCommand } from './decide-bash.ts';

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
