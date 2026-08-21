import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('./pre-tool-use-bash.ts', import.meta.url));

let projectRoot: string | undefined;

const makeProjectRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-harness-bash-hook-'));
  projectRoot = dir;
  return dir;
};

afterEach(() => {
  if (projectRoot !== undefined) {
    rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

const writeWriteSet = (root: string, writeSet: Record<string, unknown>): void => {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'writeset.json'), JSON.stringify(writeSet));
};

const runHook = (
  payload: Record<string, unknown>,
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('pre-tool-use-bash.ts (real process)', () => {
  it('игнорирует не-Bash инструменты: нет stdout, код 0', () => {
    const root = makeProjectRoot();
    const result = runHook({ cwd: root, tool_name: 'Write', tool_input: { file_path: 'a.ts' } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('lead-сессия: разрешает lead-only команду, ничего не печатает', () => {
    const root = makeProjectRoot();
    const result = runHook({
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command: 'pnpm install' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stdout).not.toContain('permissionDecision');
  });

  it('task-сессия с валидным write set: обычная команда — ничего не печатает', () => {
    const root = makeProjectRoot();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    const result = runHook({
      cwd: root,
      agent_id: 'agent-1',
      agent_type: 'tooling-implementer',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test:unit' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('task-сессия с валидным write set: lead-only команда — deny с корректной формой ответа', () => {
    const root = makeProjectRoot();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    const result = runHook({
      cwd: root,
      agent_id: 'agent-1',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin HEAD' },
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
  });

  it('B2: task-сессия без .claude/writeset.json — deny даже безобидной команде', () => {
    const root = makeProjectRoot();
    const result = runHook({
      cwd: root,
      agent_id: 'agent-1',
      agent_type: 'tooling-implementer',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'без объявленного write set',
    );
  });

  it('M-8: cp/mv на .claude/ ВНЕ корня репозитория (cwd) не запрещён (регрессия ложного отказа)', () => {
    const root = makeProjectRoot();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    const result = runHook({
      cwd: root,
      agent_id: 'agent-1',
      agent_type: 'tooling-implementer',
      tool_name: 'Bash',
      tool_input: { command: 'cp -R /tmp/fixture-a /tmp/fixture-b/.claude/' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('M-7: reviewer-роль — git commit запрещён, обычная команда разрешена', () => {
    const root = makeProjectRoot();
    writeWriteSet(root, { task_id: 'I00-F5-R1', owner_role: 'reviewer', write_paths: [] });

    const readOnly = runHook({
      cwd: root,
      agent_id: 'agent-1',
      agent_type: 'reviewer',
      tool_name: 'Bash',
      tool_input: { command: 'git log --oneline -5' },
    });
    expect(readOnly.status).toBe(0);
    expect(readOnly.stdout).toBe('');

    const commitAttempt = runHook({
      cwd: root,
      agent_id: 'agent-1',
      agent_type: 'reviewer',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "x"' },
    });
    const parsed = JSON.parse(commitAttempt.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('B2: task-сессия после rm -f .claude/writeset.json — deny (не открывается)', () => {
    const root = makeProjectRoot();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    const payload = {
      cwd: root,
      agent_id: 'agent-1',
      agent_type: 'tooling-implementer',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm lint' },
    };

    expect(runHook(payload).stdout).toBe('');

    rmSync(join(root, '.claude', 'writeset.json'));

    const after = runHook(payload);
    const parsed = JSON.parse(after.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
