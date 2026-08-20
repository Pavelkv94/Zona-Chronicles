import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * M9: hook-скрипты запускаются как реальные процессы (execFileSync-подобно через spawnSync),
 * с реальным JSON payload на stdin — не только через покрывающие их чистые функции.
 */
const HOOK = fileURLToPath(new URL('./pre-tool-use-write.ts', import.meta.url));

let projectRoot: string | undefined;

const makeProjectRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-harness-write-hook-'));
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
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('pre-tool-use-write.ts (real process)', () => {
  it('игнорирует инструменты, не связанные с записью: нет stdout, код 0', () => {
    const root = makeProjectRoot();
    const result = runHook({
      cwd: root,
      tool_name: 'Read',
      tool_input: { file_path: `${root}/README.md` },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('lead-сессия: разрешает запись в protected path, ничего не печатает', () => {
    const root = makeProjectRoot();
    const result = runHook({
      cwd: root,
      tool_name: 'Write',
      tool_input: { file_path: `${root}/pnpm-lock.yaml`, content: 'x' },
    });
    expect(result.status).toBe(0);
    // Разрешённая операция не должна печатать permissionDecision: "allow" — иначе hook
    // обходил бы обычный permission flow, который и так разрешает операцию.
    expect(result.stdout).toBe('');
    expect(result.stdout).not.toContain('permissionDecision');
  });

  it('task-сессия с валидным write set: разрешённый путь — ничего не печатает', () => {
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
      tool_name: 'Edit',
      tool_input: {
        file_path: `${root}/tools/agent-harness/src/decide-write.ts`,
        old_string: 'a',
        new_string: 'b',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('task-сессия с валидным write set: путь вне write set — deny с корректной формой ответа', () => {
    const root = makeProjectRoot();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    const result = runHook({
      cwd: root,
      agent_id: 'agent-1',
      tool_name: 'Write',
      tool_input: { file_path: `${root}/packages/domain/src/rules.ts`, content: 'x' },
    });
    expect(result.status).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    const reason = (parsed as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason;
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeGreaterThan(0);
  });

  it('B2: task-сессия без .claude/writeset.json — fail-closed deny, а не allow', () => {
    const root = makeProjectRoot();
    // Файл никогда не создавался — воспроизводит `rm -f .claude/writeset.json` до первого чтения.
    const result = runHook({
      cwd: root,
      agent_id: 'agent-1',
      agent_type: 'tooling-implementer',
      tool_name: 'Write',
      tool_input: { file_path: `${root}/tools/agent-harness/src/x.ts`, content: 'x' },
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'без объявленного write set',
    );
  });

  it('B2: task-сессия после удаления writeset.json — deny (та же сессия, что его удалила)', () => {
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
      tool_name: 'Write',
      tool_input: { file_path: `${root}/tools/agent-harness/src/x.ts`, content: 'x' },
    };

    // До удаления: разрешено (путь входит в write set).
    const before = runHook(payload);
    expect(before.stdout).toBe('');

    // rm -f .claude/writeset.json — ровно сценарий из ревью.
    rmSync(join(root, '.claude', 'writeset.json'));

    const after = runHook(payload);
    const parsed = JSON.parse(after.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
