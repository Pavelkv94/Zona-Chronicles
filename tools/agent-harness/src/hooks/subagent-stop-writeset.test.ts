import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('./subagent-stop-writeset.ts', import.meta.url));

let repo: string | undefined;

const git = (args: readonly string[], cwd: string): void => {
  execFileSync('git', [...args], { cwd, stdio: 'pipe' });
};

/** Git-репозиторий с одним seed-коммитом (нужен для `git diff --name-only HEAD`). */
const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-harness-stop-hook-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, 'tools', 'agent-harness'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'agent-harness', 'seed.ts'), 'export const seed = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
  repo = dir;
  return dir;
};

afterEach(() => {
  if (repo !== undefined) {
    rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

/**
 * Lead коммитит `.claude/writeset.json`/`.claude/tasks/*.json` до запуска subagent-а (это часть
 * orchestration-flow, не работы задачи) — поэтому здесь фикстуры коммитятся сразу, а не остаются
 * untracked. Иначе git diff видел бы сам control-файл как изменение task-сессии и ошибочно бы
 * репортил protected-path violation на `.claude/**`, никак не относящийся к B2.
 */
const commitAll = (root: string, message: string): void => {
  git(['add', '.'], root);
  git(['commit', '-q', '-m', message], root);
};

const writeWriteSet = (root: string, writeSet: Record<string, unknown>): void => {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'writeset.json'), JSON.stringify(writeSet));
  commitAll(root, 'lead: declare write set');
};

const writeTasksFile = (root: string, name: string, content: Record<string, unknown>): void => {
  mkdirSync(join(root, '.claude', 'tasks'), { recursive: true });
  writeFileSync(join(root, '.claude', 'tasks', name), JSON.stringify(content));
  commitAll(root, 'lead: declare tasks map');
};

const runHook = (
  cwd: string,
  payload: Record<string, unknown>,
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('node', [HOOK], {
    cwd,
    input: JSON.stringify({ cwd, ...payload }),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('subagent-stop-writeset.ts (real process)', () => {
  it('lead-сессия: не ограничена write set-ом, код 0, ничего не пишет в stderr', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'changed by lead\n');
    const result = runHook(root, {});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('task-сессия, валидный writeset.json, diff внутри write set — код 0', () => {
    const root = makeRepo();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    writeFileSync(join(root, 'tools', 'agent-harness', 'seed.ts'), 'export const seed = 2;\n');
    const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('task-сессия, валидный writeset.json, diff вне write set — код 2 с причиной', () => {
    const root = makeRepo();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    writeFileSync(join(root, 'README.md'), 'изменено задачей вне write set\n');
    const result = runHook(root, { agent_id: 'agent-1' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('README.md');
    expect(result.stderr).toContain('I00-R1');
  });

  it('task-сессия без writeset.json, но с покрывающей .claude/tasks/*.json — код 0', () => {
    const root = makeRepo();
    writeTasksFile(root, 'I00.json', {
      iteration_id: 'I00',
      lead_paths: ['README.md'],
      tasks: [
        {
          task_id: 'I00-R1',
          owner_role: 'tooling-implementer',
          write_paths: ['tools/agent-harness/**'],
        },
      ],
    });
    writeFileSync(join(root, 'tools', 'agent-harness', 'seed.ts'), 'export const seed = 3;\n');
    const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('task-сессия без writeset.json, .claude/tasks/*.json не покрывает файл — код 2', () => {
    const root = makeRepo();
    writeTasksFile(root, 'I00.json', {
      iteration_id: 'I00',
      tasks: [{ task_id: 'I00-R2', owner_role: 'r', write_paths: ['packages/domain/**'] }],
    });
    writeFileSync(join(root, 'tools', 'agent-harness', 'seed.ts'), 'export const seed = 4;\n');
    const result = runHook(root, { agent_id: 'agent-1' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('tools/agent-harness/seed.ts');
  });

  it('B2: task-сессия без writeset.json и без .claude/tasks — код 2, явная причина', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'tools', 'agent-harness', 'seed.ts'), 'export const seed = 5;\n');
    const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('.claude/writeset.json');
    expect(result.stderr).toContain('.claude/tasks');
  });

  it('B2: воспроизводит rm -f .claude/writeset.json той же task-сессией — завершение блокируется', () => {
    const root = makeRepo();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    writeFileSync(join(root, 'tools', 'agent-harness', 'seed.ts'), 'export const seed = 6;\n');

    // До удаления: diff внутри write set — прошло бы.
    const before = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(before.status).toBe(0);

    // Ревью-сценарий: task-сессия удаляет собственный дискриминатор.
    rmSync(join(root, '.claude', 'writeset.json'));
    // И нет .claude/tasks/*.json, который мог бы стать fallback-ом.

    const after = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(after.status).toBe(2);
    expect(after.stderr.length).toBeGreaterThan(0);
  });

  it('fail-closed на повреждённый .claude/writeset.json (task-сессия)', () => {
    const root = makeRepo();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'writeset.json'), '{not json');
    const result = runHook(root, { agent_id: 'agent-1' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Fail-closed');
  });
});
