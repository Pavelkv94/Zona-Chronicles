import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWriteSet, loadWriteSetFromGit, parseWriteSet } from './writeset.ts';

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

  describe('M-7 (review, третий раунд): owner_role: "reviewer" допускает пустой write_paths', () => {
    it('принимает пустой write_paths для owner_role: reviewer', () => {
      const result = parseWriteSet(
        JSON.stringify({ task_id: 'I00-F5-R1', owner_role: 'reviewer', write_paths: [] }),
      );
      expect(result.kind).toBe('task');
      if (result.kind === 'task') expect(result.writeSet.write_paths).toEqual([]);
    });

    it('пустой write_paths остаётся invalid для любой другой роли (регрессия)', () => {
      const result = parseWriteSet(
        JSON.stringify({ task_id: 'x', owner_role: 'tooling-implementer', write_paths: [] }),
      );
      expect(result.kind).toBe('invalid');
    });

    it('write_paths обязан быть списком строк даже для reviewer (не просто «falsy»)', () => {
      const result = parseWriteSet(
        JSON.stringify({ task_id: 'x', owner_role: 'reviewer', write_paths: 'nope' }),
      );
      expect(result.kind).toBe('invalid');
    });
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

describe('loadWriteSetFromGit (N2 review finding)', () => {
  let repo: string | undefined;

  const git = (args: readonly string[], cwd: string): void => {
    execFileSync('git', [...args], { cwd, stdio: 'pipe' });
  };

  const makeRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-harness-writeset-git-'));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    repo = dir;
    return dir;
  };

  afterEach(() => {
    if (repo !== undefined) {
      rmSync(repo, { recursive: true, force: true });
      repo = undefined;
    }
  });

  const commitWriteSet = (root: string, writeSet: Record<string, unknown>): void => {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'writeset.json'), JSON.stringify(writeSet));
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'lead: declare write set'], root);
  };

  it('читает валидный, закоммиченный write set', () => {
    const root = makeRepo();
    commitWriteSet(root, {
      task_id: 'I00-F1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    const result = loadWriteSetFromGit(root, 'HEAD');
    expect(result.kind).toBe('task');
    if (result.kind === 'task') expect(result.writeSet.task_id).toBe('I00-F1');
  });

  it('N2: подмена в рабочем дереве (без коммита) не расширяет write_paths', () => {
    const root = makeRepo();
    commitWriteSet(root, {
      task_id: 'I00-F1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    });
    // Тот же приём, что и `cat > .claude/writeset.json`: правка рабочего дерева без коммита.
    writeFileSync(
      join(root, '.claude', 'writeset.json'),
      JSON.stringify({
        task_id: 'I00-F1',
        owner_role: 'tooling-implementer',
        write_paths: ['**'],
        allow_protected_paths: ['**'],
      }),
    );
    const result = loadWriteSetFromGit(root, 'HEAD');
    expect(result.kind).toBe('task');
    if (result.kind === 'task') {
      expect(result.writeSet.write_paths).toEqual(['tools/agent-harness/**']);
      expect(result.writeSet.allow_protected_paths).toBeUndefined();
    }
  });

  it('отсутствие файла в git-объекте — kind lead (в т.ч. никогда не коммитился)', () => {
    const root = makeRepo();
    git(['commit', '-q', '-m', 'empty', '--allow-empty'], root);
    expect(loadWriteSetFromGit(root, 'HEAD').kind).toBe('lead');
  });

  it('fail-closed: ref не резолвится (нет ни одного коммита)', () => {
    const root = makeRepo();
    const result = loadWriteSetFromGit(root, 'HEAD');
    expect(result.kind).toBe('invalid');
  });
});
