import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTaskDeclarations } from './tasks-directory.ts';

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
      expect(result.tasks).toEqual([
        { task_id: 'I00-T02', owner_role: 'tooling-implementer', write_paths: ['tools/a/**'] },
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
