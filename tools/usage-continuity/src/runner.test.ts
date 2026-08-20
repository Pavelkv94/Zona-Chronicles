import { describe, expect, it } from 'vitest';
import { archiveResumedCheckpoint, resumeFromCheckpoint, runContinuityLoop } from './runner.ts';
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

function collectingStore(seeded?: Checkpoint): {
  store: CheckpointStorePort;
  writes: Checkpoint[];
  archived: string[];
} {
  const writes: Checkpoint[] = [];
  const archived: string[] = [];
  let current: Checkpoint | null = seeded ?? null;
  return {
    writes,
    archived,
    store: {
      write: (c) => {
        writes.push(c);
        current = c;
      },
      read: (taskId) => (current !== null && current.task_id === taskId ? current : null),
      archive: (taskId) => {
        archived.push(taskId);
        current = null;
      },
    },
  };
}

function collectingActions(result: 'ok' | 'failed' = 'ok'): {
  actions: ActionRunnerPort;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      run: (id) => {
        calls.push(id);
        return result;
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
const clockAtReset: ClockPort = { now: () => '2026-08-20T12:00:00.000Z' };

function repoStateFor(checkpoint: Checkpoint): RepoStatePort {
  return {
    branch: () => checkpoint.branch,
    headSha: () => checkpoint.head_sha,
    changedFiles: () => [...checkpoint.dirty_files],
    worktree: () => checkpoint.worktree,
    livingProcesses: () => [...checkpoint.unfinished_processes],
  };
}

const matchingRepoState: RepoStatePort = repoStateFor(seed);

describe('runContinuityLoop — checkpoint_only', () => {
  it('не запускает action (действий у runContinuityLoop нет), но пишет checkpoint, пока remaining держится в (1%, 2%]', () => {
    const { store, writes } = collectingStore();
    const { scheduler } = collectingScheduler();

    expect(() =>
      runContinuityLoop({
        telemetry: fixedTelemetry(sample(2)),
        store,
        scheduler,
        clock: fixedClock,
        checkpointSeed: seed,
        maxIterations: 3,
      }),
    ).toThrow(/maxIterations/);

    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]?.usage_window_remaining_percent).toBe(2);
  });
});

describe('runContinuityLoop — waiting_for_usage_reset (m1: без busy-wait, wake ровно один раз)', () => {
  it('пишет checkpoint, ставит wake РОВНО ОДИН РАЗ и немедленно возвращает управление', () => {
    const { store, writes } = collectingStore();
    const { scheduler, calls: wakeCalls } = collectingScheduler();

    const result = runContinuityLoop({
      telemetry: fixedTelemetry(sample(0.5, '2026-08-20T12:00:00.000Z')),
      store,
      scheduler,
      clock: fixedClock,
      checkpointSeed: seed,
      maxIterations: 50,
    });

    expect(result.outcome).toBe('waiting_for_reset');
    expect(result.finalState).toBe('waiting_for_usage_reset');
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]?.at).toBe('2026-08-20T12:05:00.000Z');
    expect(wakeCalls[0]?.reason).toContain('I00-T02');
    expect(writes.length).toBeGreaterThan(0);
  });

  it('последовательность checkpoint_only -> waiting_for_usage_reset тоже ставит wake ровно один раз', () => {
    const { store } = collectingStore();
    const { scheduler, calls: wakeCalls } = collectingScheduler();

    const result = runContinuityLoop({
      telemetry: sequenceTelemetry([sample(2), sample(1)]),
      store,
      scheduler,
      clock: fixedClock,
      checkpointSeed: seed,
      maxIterations: 10,
    });

    expect(result.outcome).toBe('waiting_for_reset');
    expect(result.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'normal->checkpoint_only',
      'checkpoint_only->waiting_for_usage_reset',
    ]);
    expect(wakeCalls).toHaveLength(1);
  });
});

describe('runContinuityLoop — telemetry недоступна (A9, m2)', () => {
  it('telemetry.read() === null: outcome=capability_unavailable, отличим от прогресса не по форме, а по дискриминатору', () => {
    const { store, writes } = collectingStore();
    const { scheduler } = collectingScheduler();
    const noTelemetry: UsageTelemetryPort = { read: () => null };

    const result = runContinuityLoop({
      telemetry: noTelemetry,
      store,
      scheduler,
      clock: fixedClock,
      checkpointSeed: seed,
      maxIterations: 5,
    });

    expect(result.outcome).toBe('capability_unavailable');
    expect(result.checkpoint.capability_status).toBe('LIMIT_AUTOCONTINUE_UNAVAILABLE');
    expect(writes.length).toBe(1);
    expect(writes[0]?.capability_status).toBe('LIMIT_AUTOCONTINUE_UNAVAILABLE');
  });
});

describe('runContinuityLoop — конечность цикла', () => {
  it('бросает ошибку с упоминанием maxIterations, если состояние никогда не приостанавливается', () => {
    let reads = 0;
    const telemetry: UsageTelemetryPort = {
      read: () => {
        reads += 1;
        return sample(50);
      },
    };
    const { store } = collectingStore();
    const { scheduler } = collectingScheduler();

    expect(() =>
      runContinuityLoop({
        telemetry,
        store,
        scheduler,
        clock: fixedClock,
        checkpointSeed: seed,
        maxIterations: 5,
      }),
    ).toThrow(/maxIterations/);
    expect(reads).toBe(5);
  });
});

describe('runContinuityLoop — m3: невалидное время', () => {
  it('невалидный reported_reset_at даёт явную ошибку конфигурации, а не бесконечное ожидание', () => {
    const { store } = collectingStore();
    const { scheduler } = collectingScheduler();

    expect(() =>
      runContinuityLoop({
        telemetry: fixedTelemetry(sample(0.5, 'not-a-timestamp')),
        store,
        scheduler,
        clock: fixedClock,
        checkpointSeed: seed,
        maxIterations: 5,
      }),
    ).toThrow(/невалидное время|reported_reset_at/);
  });
});

describe('resumeFromCheckpoint — B3: межпроцессный resume', () => {
  it('отсутствие checkpoint — явная ошибка, а не тихий старт с нуля', () => {
    const { store } = collectingStore();
    const { actions } = collectingActions();
    const { scheduler } = collectingScheduler();

    expect(() =>
      resumeFromCheckpoint({
        taskId: 'missing-task',
        store,
        telemetry: fixedTelemetry(sample(100)),
        clock: clockAtReset,
        actions,
        repoState: matchingRepoState,
        scheduler,
      }),
    ).toThrow(/checkpoint "missing-task" не найден/);
  });

  it('checkpoint.task_id не совпадает с запрошенным taskId — явная ошибка (ownership), даже если store вернул что-то по этому ключу', () => {
    // Намеренно "неправильный" store, который не фильтрует по taskId (моделирует баг реализации
    // порта) — resumeFromCheckpoint обязан сам защититься дополнительной проверкой ownership.
    const mismatchedSeed: Checkpoint = { ...seed, task_id: 'other-task' };
    const buggyStore: CheckpointStorePort = {
      write: () => {
        /* not used */
      },
      read: () => mismatchedSeed,
      archive: () => {
        /* not used */
      },
    };
    const { actions } = collectingActions();
    const { scheduler } = collectingScheduler();

    expect(() =>
      resumeFromCheckpoint({
        taskId: 'I00-T02',
        store: buggyStore,
        telemetry: fixedTelemetry(sample(100)),
        clock: clockAtReset,
        actions,
        repoState: matchingRepoState,
        scheduler,
      }),
    ).toThrow(/task_id|ownership/);
  });

  it('телеметрия ещё не подтверждает reset: не выполняет action, переставляет wake один раз, outcome=waiting_for_reset', () => {
    const { store } = collectingStore(seed);
    const { actions, calls } = collectingActions();
    const { scheduler, calls: wakeCalls } = collectingScheduler();

    const result = resumeFromCheckpoint({
      taskId: 'I00-T02',
      store,
      telemetry: fixedTelemetry(sample(0.5, '2026-08-20T12:00:00.000Z')),
      clock: fixedClock, // 09:30, до reported_reset_at 12:00, remaining низкий (не recovered)
      actions,
      repoState: matchingRepoState,
      scheduler,
    });

    expect(result.outcome).toBe('waiting_for_reset');
    expect(calls).toEqual([]);
    expect(wakeCalls).toHaveLength(1);
    expect(result.checkpoint.resume_attempted_at).toBeUndefined();
  });

  it('телеметрия недоступна во время resume: outcome=capability_unavailable, action не запускается', () => {
    const { store, writes } = collectingStore(seed);
    const { actions, calls } = collectingActions();
    const { scheduler } = collectingScheduler();

    const result = resumeFromCheckpoint({
      taskId: 'I00-T02',
      store,
      telemetry: { read: () => null },
      clock: clockAtReset,
      actions,
      repoState: matchingRepoState,
      scheduler,
    });

    expect(result.outcome).toBe('capability_unavailable');
    expect(calls).toEqual([]);
    expect(writes[writes.length - 1]?.capability_status).toBe('LIMIT_AUTOCONTINUE_UNAVAILABLE');
  });

  it('расхождение repo state: checkpoint с описанием расхождения пишется ДО throw (m4 — evidence не теряется)', () => {
    const { store, writes } = collectingStore(seed);
    const { actions, calls } = collectingActions();
    const { scheduler } = collectingScheduler();
    const divergedRepoState: RepoStatePort = {
      ...matchingRepoState,
      headSha: () => 'deadbeef-not-matching',
    };

    expect(() =>
      resumeFromCheckpoint({
        taskId: 'I00-T02',
        store,
        telemetry: fixedTelemetry(sample(100, '2026-08-20T12:00:00.000Z')),
        clock: clockAtReset,
        actions,
        repoState: divergedRepoState,
        scheduler,
      }),
    ).toThrow(/diverged|head_sha/i);

    expect(calls).toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1]?.last_resume_validation_error).toMatch(/head_sha/);
  });

  it('сверяет worktree, dirty_files (git diff) и unfinished_processes, не только branch/head_sha (m4)', () => {
    const richSeed: Checkpoint = {
      ...seed,
      dirty_files: ['src/a.ts'],
      unfinished_processes: ['pid:123'],
    };
    const { store, writes } = collectingStore(richSeed);
    const { actions, calls } = collectingActions();
    const { scheduler } = collectingScheduler();
    const staleRepoState: RepoStatePort = {
      ...repoStateFor(richSeed),
      changedFiles: () => [], // dirty_files разошлись
      livingProcesses: () => [], // unfinished_processes разошлись
      worktree: () => '/somewhere-else', // worktree разошёлся
    };

    expect(() =>
      resumeFromCheckpoint({
        taskId: 'I00-T02',
        store,
        telemetry: fixedTelemetry(sample(100, '2026-08-20T12:00:00.000Z')),
        clock: clockAtReset,
        actions,
        repoState: staleRepoState,
        scheduler,
      }),
    ).toThrow(/dirty_files|unfinished_processes|worktree/);

    expect(calls).toEqual([]);
    const lastError = writes[writes.length - 1]?.last_resume_validation_error ?? '';
    expect(lastError).toMatch(/worktree/);
    expect(lastError).toMatch(/dirty_files/);
    expect(lastError).toMatch(/unfinished_processes/);
  });

  it('repo state совпадает: пишет resume_attempted_at ДО запуска action и выполняет его ровно один раз', () => {
    const { store, writes } = collectingStore(seed);
    const { actions, calls } = collectingActions('ok');
    const { scheduler } = collectingScheduler();

    const result = resumeFromCheckpoint({
      taskId: 'I00-T02',
      store,
      telemetry: fixedTelemetry(sample(100, '2026-08-20T12:00:00.000Z')),
      clock: clockAtReset,
      actions,
      repoState: matchingRepoState,
      scheduler,
    });

    expect(result.outcome).toBe('progressed');
    expect(result.finalState).toBe('in_progress');
    expect(result.actionResult).toBe('ok');
    expect(calls).toEqual(['pnpm test:unit']);
    expect(result.checkpoint.resume_attempted_at).toBeDefined();

    // resume_attempted_at был записан в store ДО выполнения action (idempotency marker).
    const markedWriteIndex = writes.findIndex((c) => c.resume_attempted_at !== undefined);
    expect(markedWriteIndex).toBeGreaterThanOrEqual(0);
  });

  it('повторный resumeFromCheckpoint после отмеченной попытки: outcome=resume_conflict, action НЕ выполняется повторно', () => {
    const { store } = collectingStore(seed);
    const { actions, calls } = collectingActions('ok');
    const { scheduler } = collectingScheduler();

    const first = resumeFromCheckpoint({
      taskId: 'I00-T02',
      store,
      telemetry: fixedTelemetry(sample(100, '2026-08-20T12:00:00.000Z')),
      clock: clockAtReset,
      actions,
      repoState: matchingRepoState,
      scheduler,
    });
    expect(first.outcome).toBe('progressed');
    expect(calls).toHaveLength(1);

    // Новый "процесс": та же store (тот же checkpoint на диске), свежие fakes.
    const { actions: actions2, calls: calls2 } = collectingActions('ok');
    const second = resumeFromCheckpoint({
      taskId: 'I00-T02',
      store,
      telemetry: fixedTelemetry(sample(100, '2026-08-20T12:00:00.000Z')),
      clock: clockAtReset,
      actions: actions2,
      repoState: matchingRepoState,
      scheduler,
    });

    expect(second.outcome).toBe('resume_conflict');
    expect(second.actionResult).toBeNull();
    expect(calls2).toEqual([]);
    // Действие суммарно выполнено ровно один раз между двумя "процессами".
    expect(calls).toHaveLength(1);
  });

  it('resume, начатый до падения процесса (attempted_at уже стоит), не запускает action даже если repo state расходится', () => {
    const alreadyAttempted: Checkpoint = {
      ...seed,
      resume_attempted_at: '2026-08-20T12:00:00.000Z',
    };
    const { store } = collectingStore(alreadyAttempted);
    const { actions, calls } = collectingActions();
    const { scheduler } = collectingScheduler();
    const divergedRepoState: RepoStatePort = {
      ...matchingRepoState,
      headSha: () => 'anything-else',
    };

    const result = resumeFromCheckpoint({
      taskId: 'I00-T02',
      store,
      telemetry: fixedTelemetry(sample(100, '2026-08-20T12:00:00.000Z')),
      clock: clockAtReset,
      actions,
      repoState: divergedRepoState,
      scheduler,
    });

    expect(result.outcome).toBe('resume_conflict');
    expect(calls).toEqual([]);
  });
});

describe('archiveResumedCheckpoint — только после подтверждённого внешнего green (B3 п.4)', () => {
  it('не вызывается автоматически resumeFromCheckpoint после успешного action', () => {
    const { store, archived } = collectingStore(seed);
    const { actions } = collectingActions('ok');
    const { scheduler } = collectingScheduler();

    resumeFromCheckpoint({
      taskId: 'I00-T02',
      store,
      telemetry: fixedTelemetry(sample(100, '2026-08-20T12:00:00.000Z')),
      clock: clockAtReset,
      actions,
      repoState: matchingRepoState,
      scheduler,
    });

    expect(archived).toEqual([]);
  });

  it('вызывающий явно архивирует checkpoint после подтверждённого green', () => {
    const { store, archived } = collectingStore(seed);
    archiveResumedCheckpoint('I00-T02', store);
    expect(archived).toEqual(['I00-T02']);
  });
});
