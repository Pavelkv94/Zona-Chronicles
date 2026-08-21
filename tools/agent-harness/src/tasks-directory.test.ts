import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTaskDeclarations, loadTaskDeclarationsFromGit } from './tasks-directory.ts';

let dir: string | undefined;

const makeDir = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'agent-harness-tasks-'));
  return dir;
};

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('loadTaskDeclarations', () => {
  it('каталог отсутствует — absent', () => {
    expect(loadTaskDeclarations('/nonexistent/.claude/tasks').kind).toBe('absent');
  });

  it('каталог существует, но пуст — absent', () => {
    const d = makeDir();
    expect(loadTaskDeclarations(d).kind).toBe('absent');
  });

  it('каталог содержит только не-JSON файлы — absent', () => {
    const d = makeDir();
    writeFileSync(join(d, 'README.md'), '# notes');
    expect(loadTaskDeclarations(d).kind).toBe('absent');
  });

  it('загружает и объединяет одну задачу из одного файла', () => {
    const d = makeDir();
    writeFileSync(
      join(d, 'I00.json'),
      JSON.stringify({
        iteration_id: 'I00',
        lead_paths: ['docs/**'],
        tasks: [
          { task_id: 'I00-T02', owner_role: 'tooling-implementer', write_paths: ['tools/a/**'] },
        ],
      }),
    );
    const result = loadTaskDeclarations(d);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      // iteration_id файла проставляется в каждую его задачу (finding раунда I00-F5, живой прогон:
      // нужно для того, чтобы checkOwnership отличал конфликт внутри итерации от повторной правки
      // того же пути в следующей итерации — см. task-ownership.ts).
      expect(result.tasks).toEqual([
        {
          task_id: 'I00-T02',
          owner_role: 'tooling-implementer',
          write_paths: ['tools/a/**'],
          iteration_id: 'I00',
        },
      ]);
      expect(result.leadPaths).toEqual(['docs/**']);
    }
  });

  it('объединяет задачи из нескольких файлов итерации', () => {
    const d = makeDir();
    writeFileSync(
      join(d, 'I00.json'),
      JSON.stringify({
        tasks: [{ task_id: 'I00-T02', owner_role: 'r', write_paths: ['tools/a/**'] }],
        lead_paths: ['docs/**'],
      }),
    );
    writeFileSync(
      join(d, 'I01.json'),
      JSON.stringify({
        tasks: [{ task_id: 'I01-T01', owner_role: 'r', write_paths: ['packages/b/**'] }],
        lead_paths: ['README.md'],
      }),
    );
    const result = loadTaskDeclarations(d);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect([...result.tasks.map((t) => t.task_id)].sort()).toEqual(['I00-T02', 'I01-T01']);
      expect([...result.leadPaths].sort()).toEqual(['README.md', 'docs/**']);
    }
  });

  it('работает без lead_paths (необязательное поле)', () => {
    const d = makeDir();
    writeFileSync(
      join(d, 'I00.json'),
      JSON.stringify({ tasks: [{ task_id: 'T', owner_role: 'r', write_paths: ['a/**'] }] }),
    );
    const result = loadTaskDeclarations(d);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') expect(result.leadPaths).toEqual([]);
  });

  it('fail-closed на невалидный JSON', () => {
    const d = makeDir();
    writeFileSync(join(d, 'broken.json'), '{not json');
    expect(loadTaskDeclarations(d).kind).toBe('invalid');
  });

  it('fail-closed, если tasks не массив TaskDeclaration', () => {
    const d = makeDir();
    writeFileSync(join(d, 'bad.json'), JSON.stringify({ tasks: 'nope' }));
    expect(loadTaskDeclarations(d).kind).toBe('invalid');
  });

  it('fail-closed, если элемент tasks без обязательных полей', () => {
    const d = makeDir();
    writeFileSync(join(d, 'bad.json'), JSON.stringify({ tasks: [{ task_id: 'T' }] }));
    expect(loadTaskDeclarations(d).kind).toBe('invalid');
  });

  it('fail-closed, если lead_paths не список строк', () => {
    const d = makeDir();
    writeFileSync(
      join(d, 'bad.json'),
      JSON.stringify({
        tasks: [{ task_id: 'T', owner_role: 'r', write_paths: ['a/**'] }],
        lead_paths: 'docs/**',
      }),
    );
    expect(loadTaskDeclarations(d).kind).toBe('invalid');
  });
});

describe('loadTaskDeclarationsFromGit (N1/N2 review finding)', () => {
  let repo: string | undefined;

  const git = (args: readonly string[], cwd: string): void => {
    execFileSync('git', [...args], { cwd, stdio: 'pipe' });
  };

  const makeRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-harness-tasks-git-'));
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

  const commitTasksFile = (root: string, name: string, content: Record<string, unknown>): void => {
    mkdirSync(join(root, '.claude', 'tasks'), { recursive: true });
    writeFileSync(join(root, '.claude', 'tasks', name), JSON.stringify(content));
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'lead: declare tasks map'], root);
  };

  it('читает и объединяет закоммиченные *.json', () => {
    const root = makeRepo();
    commitTasksFile(root, 'I00.json', {
      lead_paths: ['docs/**'],
      tasks: [{ task_id: 'I00-T02', owner_role: 'r', write_paths: ['tools/a/**'] }],
    });
    const result = loadTaskDeclarationsFromGit(root, 'HEAD');
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.tasks.map((t) => t.task_id)).toEqual(['I00-T02']);
      expect(result.leadPaths).toEqual(['docs/**']);
    }
  });

  it('N1/N2: файл, добавленный ТОЛЬКО в рабочее дерево (без коммита), не учитывается', () => {
    const root = makeRepo();
    commitTasksFile(root, 'I00.json', {
      lead_paths: ['docs/**'],
      tasks: [{ task_id: 'I00-T02', owner_role: 'r', write_paths: ['tools/a/**'] }],
    });
    // Приём N2: task-сессия дописывает/расширяет карту задач в рабочем дереве без коммита.
    writeFileSync(
      join(root, '.claude', 'tasks', 'forged.json'),
      JSON.stringify({ lead_paths: ['**'], tasks: [] }),
    );
    const result = loadTaskDeclarationsFromGit(root, 'HEAD');
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') expect(result.leadPaths).toEqual(['docs/**']);
  });

  it('отсутствующая директория задач в git-объекте — absent', () => {
    const root = makeRepo();
    git(['commit', '-q', '-m', 'empty', '--allow-empty'], root);
    expect(loadTaskDeclarationsFromGit(root, 'HEAD').kind).toBe('absent');
  });

  it('fail-closed: ref не резолвится (нет ни одного коммита)', () => {
    const root = makeRepo();
    expect(loadTaskDeclarationsFromGit(root, 'HEAD').kind).toBe('invalid');
  });

  it('fail-closed на невалидный JSON, даже если он закоммичен', () => {
    const root = makeRepo();
    mkdirSync(join(root, '.claude', 'tasks'), { recursive: true });
    writeFileSync(join(root, '.claude', 'tasks', 'broken.json'), '{not json');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'broken'], root);
    expect(loadTaskDeclarationsFromGit(root, 'HEAD').kind).toBe('invalid');
  });
});
