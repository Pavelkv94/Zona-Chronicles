import { describe, expect, it } from 'vitest';
import { parseCheckpoint, renderCheckpoint } from './checkpoint.ts';
import type { Checkpoint } from './types.ts';

const sampleCheckpoint: Checkpoint = {
  task_id: 'I00-T02',
  iteration_id: 'I00',
  objective: 'harness пятичасового usage window',
  plan_status: 'in_progress: state-machine done, checkpoint in progress',
  branch: 'main',
  worktree: '/Users/dev/Zona-Chronicles',
  base_sha: 'bcfb8cffacae2283869e0dc43129d5f06af0a138',
  head_sha: 'bcfb8cffacae2283869e0dc43129d5f06af0a138',
  changed_files: ['tools/usage-continuity/src/checkpoint.ts'],
  dirty_files: [],
  own_commits: [],
  last_red: 'pnpm vitest run state-machine.test.ts -> Cannot find module',
  last_green: 'pnpm vitest run state-machine.test.ts -> 9 passed',
  unfinished_processes: [],
  decisions: ['use JSON-in-YAML frontmatter for exact round trip'],
  risks: ['no real provider telemetry adapter yet'],
  next_exact_action: 'write file-checkpoint-store test',
  usage_window_remaining_percent: 1.5,
  reported_reset_at: '2026-08-20T12:00:00.000Z',
  checkpointed_at: '2026-08-20T10:15:00.000Z',
};

describe('renderCheckpoint / parseCheckpoint round trip', () => {
  it('parse(render(x)) равно x', () => {
    const rendered = renderCheckpoint(sampleCheckpoint);
    const parsed = parseCheckpoint(rendered);
    expect(parsed).toEqual(sampleCheckpoint);
  });

  it('render содержит YAML frontmatter со всеми обязательными полями', () => {
    const rendered = renderCheckpoint(sampleCheckpoint);
    expect(rendered.startsWith('---\n')).toBe(true);
    for (const key of [
      'task_id',
      'iteration_id',
      'objective',
      'plan_status',
      'branch',
      'worktree',
      'base_sha',
      'head_sha',
      'changed_files',
      'dirty_files',
      'own_commits',
      'last_red',
      'last_green',
      'unfinished_processes',
      'decisions',
      'risks',
      'next_exact_action',
      'usage_window_remaining_percent',
      'reported_reset_at',
      'checkpointed_at',
    ]) {
      expect(rendered).toContain(`${key}:`);
    }
  });

  it('capability_status опционален и round-trip сохраняет его при наличии', () => {
    const withCapability: Checkpoint = {
      ...sampleCheckpoint,
      capability_status: 'LIMIT_AUTOCONTINUE_UNAVAILABLE',
    };
    const parsed = parseCheckpoint(renderCheckpoint(withCapability));
    expect(parsed).toEqual(withCapability);
  });

  it('парсинг мусора возвращает { error }, а не бросает исключение', () => {
    const result = parseCheckpoint('это не checkpoint');
    expect(result).toHaveProperty('error');
  });

  it('парсинг frontmatter без обязательного поля возвращает { error }', () => {
    const rendered = renderCheckpoint(sampleCheckpoint);
    const withoutTaskId = rendered
      .split('\n')
      .filter((line) => !line.startsWith('task_id:'))
      .join('\n');
    const result = parseCheckpoint(withoutTaskId);
    expect(result).toHaveProperty('error');
  });
});
