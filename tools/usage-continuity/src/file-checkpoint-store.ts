/**
 * Файловая реализация CheckpointStorePort (DEV-01).
 * Записывает checkpoint атомарно (temp file + rename) в `<root>/.claude/checkpoints/<task-id>.md`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseCheckpoint, renderCheckpoint } from './checkpoint.ts';
import type { CheckpointStorePort } from './ports.ts';
import type { Checkpoint } from './types.ts';

export interface FileCheckpointStoreOptions {
  /** Корень репозитория (или тестовой песочницы). Checkpoints лежат в `<root>/.claude/checkpoints`. */
  readonly root: string;
  /** Каталог, куда `archive` переносит завершённые checkpoint. По умолчанию `<root>/.claude/checkpoints/archive`. */
  readonly archiveDir?: string;
}

function taskCheckpointPath(root: string, taskId: string): string {
  return join(root, '.claude', 'checkpoints', `${taskId}.md`);
}

/** Атомарная запись: временный файл в той же директории, затем rename (POSIX rename атомарен). */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, path);
}

export class FileCheckpointStore implements CheckpointStorePort {
  private readonly root: string;
  private readonly archiveDir: string;

  constructor(options: FileCheckpointStoreOptions) {
    this.root = options.root;
    this.archiveDir = options.archiveDir ?? join(options.root, '.claude', 'checkpoints', 'archive');
  }

  write(checkpoint: Checkpoint): void {
    const path = taskCheckpointPath(this.root, checkpoint.task_id);
    writeFileAtomic(path, renderCheckpoint(checkpoint));
  }

  read(taskId: string): Checkpoint | null {
    const path = taskCheckpointPath(this.root, taskId);
    if (!existsSync(path)) {
      return null;
    }
    const parsed = parseCheckpoint(readFileSync(path, 'utf8'));
    if ('error' in parsed) {
      throw new Error(`checkpoint "${taskId}" повреждён (${path}): ${parsed.error}`);
    }
    return parsed;
  }

  archive(taskId: string): void {
    const sourcePath = taskCheckpointPath(this.root, taskId);
    if (!existsSync(sourcePath)) {
      throw new Error(`archive: checkpoint "${taskId}" не найден (${sourcePath})`);
    }
    mkdirSync(this.archiveDir, { recursive: true });
    const targetPath = join(this.archiveDir, `${taskId}.md`);
    renameSync(sourcePath, targetPath);
  }
}
