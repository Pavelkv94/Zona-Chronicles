import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitPathKind, listJsonFilesInGitDir, readGitBlob, resolveCommit } from './git-source.ts';

let repo: string | undefined;

const git = (args: readonly string[], cwd: string): void => {
  execFileSync('git', [...args], { cwd, stdio: 'pipe' });
};

const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-harness-git-source-'));
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

const commitFile = (root: string, relPath: string, content: string): void => {
  const abs = join(root, ...relPath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  git(['add', '.'], root);
  git(['commit', '-q', '-m', `add ${relPath}`], root);
};

describe('resolveCommit', () => {
  it('HEAD резолвится, если есть хотя бы один коммит', () => {
    const root = makeRepo();
    commitFile(root, 'a.txt', 'x\n');
    expect(resolveCommit(root, 'HEAD').kind).toBe('ok');
  });

  it('fail-closed: HEAD не резолвится без единого коммита (unborn branch)', () => {
    const root = makeRepo();
    const result = resolveCommit(root, 'HEAD');
    expect(result.kind).toBe('error');
  });

  it('fail-closed: битый SHA не резолвится', () => {
    const root = makeRepo();
    commitFile(root, 'a.txt', 'x\n');
    expect(resolveCommit(root, 'deadbeef').kind).toBe('error');
  });
});

describe('readGitBlob', () => {
  it('читает содержимое из закоммиченного файла', () => {
    const root = makeRepo();
    commitFile(root, '.claude/writeset.json', '{"task_id":"T"}');
    const result = readGitBlob(root, 'HEAD', '.claude/writeset.json');
    expect(result).toEqual({ kind: 'ok', content: '{"task_id":"T"}' });
  });

  it('N2: не видит содержимое, изменённое ТОЛЬКО в рабочем дереве (без коммита)', () => {
    const root = makeRepo();
    commitFile(root, '.claude/writeset.json', '{"task_id":"original"}');
    // Подмена в рабочем дереве — именно то, что делает Bash-обход из N2.
    writeFileSync(join(root, '.claude', 'writeset.json'), '{"task_id":"forged"}');
    const result = readGitBlob(root, 'HEAD', '.claude/writeset.json');
    expect(result).toEqual({ kind: 'ok', content: '{"task_id":"original"}' });
  });

  it('путь, отсутствующий в дереве ref — absent, не error', () => {
    const root = makeRepo();
    commitFile(root, 'a.txt', 'x\n');
    expect(readGitBlob(root, 'HEAD', '.claude/writeset.json')).toEqual({ kind: 'absent' });
  });

  it('нерезолвящийся ref — error (fail-closed), не absent', () => {
    const root = makeRepo();
    commitFile(root, 'a.txt', 'x\n');
    const result = readGitBlob(root, 'not-a-real-ref', 'a.txt');
    expect(result.kind).toBe('error');
  });
});

describe('listJsonFilesInGitDir', () => {
  it('перечисляет только *.json из закоммиченной директории', () => {
    const root = makeRepo();
    commitFile(root, '.claude/tasks/I00.json', '{}');
    commitFile(root, '.claude/tasks/README.md', '# notes');
    const entries = listJsonFilesInGitDir(root, 'HEAD', '.claude/tasks');
    expect(entries).toEqual(['.claude/tasks/I00.json']);
  });

  it('отсутствующая директория — пустой список, не ошибка', () => {
    const root = makeRepo();
    commitFile(root, 'a.txt', 'x\n');
    expect(listJsonFilesInGitDir(root, 'HEAD', '.claude/tasks')).toEqual([]);
  });

  it('N1/N2: не видит файл, добавленный ТОЛЬКО в рабочее дерево (без коммита)', () => {
    const root = makeRepo();
    commitFile(root, '.claude/tasks/I00.json', '{}');
    mkdirSync(join(root, '.claude', 'tasks'), { recursive: true });
    writeFileSync(join(root, '.claude', 'tasks', 'forged.json'), '{}');
    expect(listJsonFilesInGitDir(root, 'HEAD', '.claude/tasks')).toEqual([
      '.claude/tasks/I00.json',
    ]);
  });
});

describe('gitPathKind', () => {
  it('blob для файла', () => {
    const root = makeRepo();
    commitFile(root, '.claude/writeset.json', '{}');
    expect(gitPathKind(root, 'HEAD', '.claude/writeset.json')).toBe('blob');
  });

  it('tree для директории', () => {
    const root = makeRepo();
    commitFile(root, '.claude/tasks/I00.json', '{}');
    expect(gitPathKind(root, 'HEAD', '.claude/tasks')).toBe('tree');
  });

  it('absent для отсутствующего пути', () => {
    const root = makeRepo();
    commitFile(root, 'a.txt', 'x\n');
    expect(gitPathKind(root, 'HEAD', 'nonexistent')).toBe('absent');
  });
});
