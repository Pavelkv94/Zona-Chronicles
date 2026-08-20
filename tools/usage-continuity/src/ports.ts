/**
 * Инъектируемые порты harness пятичасового usage window (DEV-01).
 * Никакой продуктовый код здесь не читает wall clock, сеть или provider UI напрямую —
 * только через эти порты, инъектированные вызывающей стороной (CLI/тесты).
 */
import type { Checkpoint, UsageWindowSample } from './types.ts';

/** Источник telemetry пятичасового usage window. `null` — телеметрия недоступна. */
export interface UsageTelemetryPort {
  read(): UsageWindowSample | null;
}

/** Постановка persisted wake на внешнем orchestrator/runner. */
export interface WakeSchedulerPort {
  scheduleWake(at: string, reason: string): void;
}

/** Хранилище checkpoint-файлов задачи. */
export interface CheckpointStorePort {
  write(checkpoint: Checkpoint): void;
  read(taskId: string): Checkpoint | null;
  archive(taskId: string): void;
}

/** Единственный источник текущего времени для continuity runner. */
export interface ClockPort {
  now(): string;
}

/** Исполнитель `next_exact_action` после подтверждённого resume. */
export interface ActionRunnerPort {
  run(actionId: string): 'ok' | 'failed';
}

/**
 * Фактическое состояние репозитория для сверки перед resume (§9: "branch/worktree, base/HEAD,
 * git diff, живые процессы и ownership"). `changedFiles()` — эквивалент `git diff --name-only`,
 * сверяется с `checkpoint.dirty_files`. `livingProcesses()` — эквивалент "живые процессы",
 * сверяется с `checkpoint.unfinished_processes`.
 */
export interface RepoStatePort {
  branch(): string;
  headSha(): string;
  changedFiles(): string[];
  worktree(): string;
  livingProcesses(): string[];
}
