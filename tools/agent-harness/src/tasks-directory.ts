import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskDeclaration } from './task-ownership.ts';

/**
 * Fallback-источник write set для `subagent-stop-writeset` (B2 review finding, требование A4).
 *
 * Когда lead запускает несколько implementer-задач параллельно в одном worktree,
 * `.claude/writeset.json` не заводится (он описывает ровно одну активную задачу — см.
 * `writeset.ts`). В этом режиме карта владения задаётся файлами `.claude/tasks/*.json` в формате
 * `TasksFile` (см. `.claude/tasks/I00.json`, тот же формат, что читает `cli/verify-task-ownership.ts`).
 *
 * Этот модуль сознательно не пытается понять, какая именно задача из карты — «наша»: он отдаёт
 * объединённый список задач + lead_paths, а `checkOwnership` проверяет, что каждый изменённый файл
 * принадлежит ровно одной задаче. Этого достаточно, чтобы обнаружить запись вне любой объявленной
 * задачи, не требуя от hook-а знать task_id текущей сессии.
 */
export type TasksDirectoryResult =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'loaded';
      readonly tasks: readonly TaskDeclaration[];
      readonly leadPaths: readonly string[];
    }
  | { readonly kind: 'invalid'; readonly reason: string };

type TasksFile = {
  readonly iteration_id?: unknown;
  readonly lead_paths?: unknown;
  readonly tasks?: unknown;
};

const isTaskDeclaration = (value: unknown): value is TaskDeclaration =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)['task_id'] === 'string' &&
  typeof (value as Record<string, unknown>)['owner_role'] === 'string' &&
  Array.isArray((value as Record<string, unknown>)['write_paths']);

/** Читает и объединяет все `.claude/tasks/*.json`. Отсутствие каталога/файлов — `'absent'`. */
export const loadTaskDeclarations = (tasksDir: string): TasksDirectoryResult => {
  let entries: string[];
  try {
    entries = readdirSync(tasksDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return { kind: 'absent' };
  }
  if (entries.length === 0) return { kind: 'absent' };

  const tasks: TaskDeclaration[] = [];
  const leadPaths: string[] = [];

  for (const entry of entries) {
    const filePath = join(tasksDir, entry);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      return { kind: 'invalid', reason: `${entry} недоступен: ${String(error)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { kind: 'invalid', reason: `${entry} не является валидным JSON: ${String(error)}` };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { kind: 'invalid', reason: `${entry}: должен быть объектом` };
    }

    const file = parsed as TasksFile;
    if (!Array.isArray(file.tasks) || !file.tasks.every(isTaskDeclaration)) {
      return {
        kind: 'invalid',
        reason: `${entry}: обязательное поле tasks — массив TaskDeclaration (task_id, owner_role, write_paths)`,
      };
    }
    tasks.push(...file.tasks);

    if (file.lead_paths !== undefined) {
      if (!Array.isArray(file.lead_paths) || !file.lead_paths.every((p) => typeof p === 'string')) {
        return { kind: 'invalid', reason: `${entry}: lead_paths должен быть списком строк` };
      }
      leadPaths.push(...(file.lead_paths as readonly string[]));
    }
  }

  return { kind: 'loaded', tasks, leadPaths };
};
