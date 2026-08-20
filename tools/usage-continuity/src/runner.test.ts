import { describe, expect, it } from 'vitest';
import { runContinuityLoop } from './runner.ts';
import type {
  ActionRunnerPort,
  CheckpointStorePort,
  ClockPort,
  RepoStatePort,
  UsageTelemetryPort,
  WakeSchedulerPort,
} from './ports.ts';
import type { Checkpoint, UsageWindowSample } from './types.ts';

const seed: Checkpoint = {
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
  next_exact_action: 'pnpm test:unit',
  usage_window_remaining_percent: 50,
  reported_reset_at: '2026-08-20T12:00:00.000Z',
  checkpointed_at: '2026-08-20T09:00:00.000Z',
};

function sample(
  remaining_percent: number,
  reported_reset_at = '2026-08-20T12:00:00.000Z',
): UsageWindowSample {
  return {
    remaining_percent,
    reported_reset_at,
    source: 'test',
    observed_at: '2026-08-20T09:00:00.000Z',
  };
}

function fixedTelemetry(s: UsageWindowSample): UsageTelemetryPort {
  return { read: () => s };
}

function sequenceTelemetry(samples: UsageWindowSample[]): UsageTelemetryPort {
  let index = 0;
  return {
    read: () => {
      const next = samples[Math.min(index, samples.length - 1)];
      index += 1;
      if (next === undefined) {
        throw new Error('test setup error: empty sample sequence');
      }
      return next;
    },
  };
}

function collectingStore(): { store: CheckpointStorePort; writes: Checkpoint[] } {
  const writes: Checkpoint[] = [];
  return {
    writes,
    store: {
      write: (c) => writes.push(c),
      read: () => null,
      archive: () => {
        /* not used in these tests */
      },
    },
  };
}

function collectingActions(): { actions: ActionRunnerPort; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      run: (id) => {
        calls.push(id);
        return 'ok';
      },
    },
  };
}

function collectingScheduler(): {
  scheduler: WakeSchedulerPort;
  calls: { at: string; reason: string }[];
} {
  const calls: { at: string; reason: string }[] = [];
  return { calls, scheduler: { scheduleWake: (at, reason) => calls.push({ at, reason }) } };
}

const fixedClock: ClockPort = { now: () => '2026-08-20T09:30:00.000Z' };

const matchingRepoState: RepoStatePort = {
  branch: () => seed.branch,
  headSha: () => seed.head_sha,
  changedFiles: () => [],
};

describe('runContinuityLoop — checkpoint_only', () => {
  it('не запускает action, но пишет checkpoint, пока remaining держится в (1%, 2%]', () => {
    const { store, writes } = collectingStore();
    const { actions, calls } = collectingActions();
    const { scheduler } = collectingScheduler();

    expect(() =>
      runContinuityLoop({
        telemetry: fixedTelemetry(sample(2)),
        store,
        scheduler,
        clock: fixedClock,
        actions,
        repoState: matchingRepoState,
        checkpointSeed: seed,
        maxIterations: 3,
      }),
    ).toThrow(/maxIterations/);

    expect(calls).toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]?.usage_window_remaining_percent).toBe(2);
  });
});

describe('runContinuityLoop — waiting_for_usage_reset', () => {
  it('не запускает ни один action и ставит wake на reported_reset_at + safety margin', () => {
    const { store } = collectingStore();
    const { actions, calls } = collectingActions();
    const { scheduler, calls: wakeCalls } = collectingScheduler();

    expect(() =>
      runContinuityLoop({
        telemetry: fixedTelemetry(sample(0.5, '2026-08-20T12:00:00.000Z')),
        store,
        scheduler,
        clock: fixedClock,
        actions,
        repoState: matchingRepoState,
        checkpointSeed: seed,
        maxIterations: 3,
      }),
    ).toThrow(/maxIterations/);

    expect(calls).toEqual([]);
    expect(wakeCalls.length).toBeGreaterThan(0);
    expect(wakeCalls[0]?.at).toBe('2026-08-20T12:05:00.000Z');
    expect(wakeCalls[0]?.reason).toContain('I00-T02');
  });
});

describe('runContinuityLoop — resume после reset', () => {
  it('выполняет next_exact_action ровно один раз после полного цикла 2% -> 1% -> reset', () => {
    const { store, writes } = collectingStore();
    const { actions, calls } = collectingActions();
    const { scheduler } = collectingScheduler();

    const result = runContinuityLoop({
      telemetry: sequenceTelemetry([sample(2), sample(1), sample(100)]),
      store,
      scheduler,
      clock: fixedClock,
      actions,
      repoState: matchingRepoState,
      checkpointSeed: seed,
      maxIterations: 10,
    });

    expect(calls).toEqual(['pnpm test:unit']);
    expect(result.finalState).toBe('in_progress');
    expect(result.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'normal->checkpoint_only',
      'checkpoint_only->waiting_for_usage_reset',
      'waiting_for_usage_reset->validating_resume',
      'validating_resume->in_progress',
    ]);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('расхождение checkpoint с фактическим repo state даёт явную ошибку, а не тихое продолжение', () => {
    const { store } = collectingStore();
    const { actions, calls } = collectingActions();
    const { scheduler } = collectingScheduler();
    const divergedRepoState: RepoStatePort = {
      branch: () => seed.branch,
      headSha: () => 'deadbeef-not-matching',
      changedFiles: () => [],
    };

    expect(() =>
      runContinuityLoop({
        telemetry: sequenceTelemetry([sample(2), sample(1), sample(100)]),
        store,
        scheduler,
        clock: fixedClock,
        actions,
        repoState: divergedRepoState,
        checkpointSeed: seed,
        maxIterations: 10,
      }),
    ).toThrow(/diverged|head_sha|resume/i);

    expect(calls).toEqual([]);
  });
});

describe('runContinuityLoop — telemetry недоступна (A9)', () => {
  it('telemetry.read() === null: пишет capability_status=LIMIT_AUTOCONTINUE_UNAVAILABLE в checkpoint и не запускает action', () => {
    const { store, writes } = collectingStore();
    const { actions, calls } = collectingActions();
    const { scheduler } = collectingScheduler();
    const noTelemetry: UsageTelemetryPort = { read: () => null };

    const result = runContinuityLoop({
      telemetry: noTelemetry,
      store,
      scheduler,
      clock: fixedClock,
      actions,
      repoState: matchingRepoState,
      checkpointSeed: seed,
      maxIterations: 5,
    });

    expect(calls).toEqual([]);
    expect(result.checkpoint.capability_status).toBe('LIMIT_AUTOCONTINUE_UNAVAILABLE');
    expect(writes.length).toBe(1);
    expect(writes[0]?.capability_status).toBe('LIMIT_AUTOCONTINUE_UNAVAILABLE');
  });
});

describe('runContinuityLoop — конечность цикла', () => {
  it('бросает ошибку с упоминанием maxIterations, если состояние никогда не разрешается', () => {
    let reads = 0;
    const telemetry: UsageTelemetryPort = {
      read: () => {
        reads += 1;
        return sample(50);
      },
    };
    const { store } = collectingStore();
    const { actions } = collectingActions();
    const { scheduler } = collectingScheduler();

    expect(() =>
      runContinuityLoop({
        telemetry,
        store,
        scheduler,
        clock: fixedClock,
        actions,
        repoState: matchingRepoState,
        checkpointSeed: seed,
        maxIterations: 5,
      }),
    ).toThrow(/maxIterations/);
    expect(reads).toBe(5);
  });
});
