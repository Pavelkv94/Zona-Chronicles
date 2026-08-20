import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpointStore } from './file-checkpoint-store.ts';
import type { Checkpoint } from './types.ts';

const baseCheckpoint: Checkpoint = {
  task_id: 'I00-T02',
  iteration_id: 'I00',
  objective: 'harness пятичасового usage window',
  plan_status: 'in_progress',
  branch: 'main',
  worktree: '/repo',
  base_sha: 'bcfb8cf',
  head_sha: 'bcfb8cf',
  changed_files: [],
  dirty_files: [],
  own_commits: [],
  last_red: 'n/a',
  last_green: 'n/a',
  unfinished_processes: [],
  decisions: [],
  risks: [],
  next_exact_action: 'continue',
  usage_window_remaining_percent: 1.5,
  reported_reset_at: '2026-08-20T12:00:00.000Z',
  checkpointed_at: '2026-08-20T10:00:00.000Z',
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'usage-continuity-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('FileCheckpointStore', () => {
  it('read возвращает null, если checkpoint ещё не записан', () => {
    const store = new FileCheckpointStore({ root });
    expect(store.read('I00-T02')).toBeNull();
  });

  it('write затем read возвращают тот же checkpoint', () => {
    const store = new FileCheckpointStore({ root });
    store.write(baseCheckpoint);
    expect(store.read('I00-T02')).toEqual(baseCheckpoint);
  });

  it('write пишет атомарно: путь не содержит осиротевший .tmp файл после записи', () => {
    const store = new FileCheckpointStore({ root });
    store.write(baseCheckpoint);
    const checkpointPath = join(root, '.claude', 'checkpoints', 'I00-T02.md');
    expect(existsSync(checkpointPath)).toBe(true);
    expect(existsSync(`${checkpointPath}.tmp`)).toBe(false);
    expect(readFileSync(checkpointPath, 'utf8').startsWith('---\n')).toBe(true);
  });

  it('write дважды перезаписывает checkpoint того же task_id', () => {
    const store = new FileCheckpointStore({ root });
    store.write(baseCheckpoint);
    store.write({ ...baseCheckpoint, plan_status: 'done' });
    expect(store.read('I00-T02')?.plan_status).toBe('done');
  });

  it('archive переносит checkpoint в переданный каталог и убирает его из активных', () => {
    const archiveDir = join(root, 'archive-target');
    const store = new FileCheckpointStore({ root, archiveDir });
    store.write(baseCheckpoint);
    store.archive('I00-T02');
    expect(store.read('I00-T02')).toBeNull();
    const archivedPath = join(archiveDir, 'I00-T02.md');
    expect(existsSync(archivedPath)).toBe(true);
    expect(readFileSync(archivedPath, 'utf8')).toContain('"I00-T02"');
  });

  it('archive без существующего checkpoint бросает ошибку с причиной', () => {
    const store = new FileCheckpointStore({ root });
    expect(() => store.archive('missing-task')).toThrow(/missing-task/);
  });
});
