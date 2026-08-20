import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCheckpoint, renderCheckpoint } from './checkpoint.ts';
import type { Checkpoint } from './types.ts';

const stringArb = fc.string({ maxLength: 40 });
const stringArrayArb = fc.array(stringArb, { maxLength: 5 });
const isoTimestampArb = fc
  .date({ min: new Date(0), max: new Date(Date.UTC(2100, 0, 1)), noInvalidDate: true })
  .map((date) => date.toISOString());

const checkpointArb: fc.Arbitrary<Checkpoint> = fc.record(
  {
    task_id: stringArb,
    iteration_id: stringArb,
    objective: stringArb,
    plan_status: stringArb,
    branch: stringArb,
    worktree: stringArb,
    base_sha: stringArb,
    head_sha: stringArb,
    changed_files: stringArrayArb,
    dirty_files: stringArrayArb,
    own_commits: stringArrayArb,
    last_red: stringArb,
    last_green: stringArb,
    unfinished_processes: stringArrayArb,
    decisions: stringArrayArb,
    risks: stringArrayArb,
    next_exact_action: stringArb,
    usage_window_remaining_percent: fc.double({ min: 0, max: 100, noNaN: true }),
    reported_reset_at: isoTimestampArb,
    checkpointed_at: isoTimestampArb,
    capability_status: stringArb,
    resume_attempted_at: isoTimestampArb,
    resume_completed_at: isoTimestampArb,
    resume_result: fc.constantFrom('ok', 'failed'),
    last_resume_validation_error: stringArb,
  },
  {
    requiredKeys: [
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
    ],
  },
);

describe('property: renderCheckpoint/parseCheckpoint round trip', () => {
  it('parseCheckpoint(renderCheckpoint(x)) равно x для произвольного Checkpoint', () => {
    fc.assert(
      fc.property(checkpointArb, (checkpoint) => {
        const parsed = parseCheckpoint(renderCheckpoint(checkpoint));
        expect(parsed).toEqual(checkpoint);
      }),
      { numRuns: 200 },
    );
  });
});
