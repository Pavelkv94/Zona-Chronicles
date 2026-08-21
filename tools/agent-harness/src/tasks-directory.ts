import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listJsonFilesInGitDir, readGitBlob, resolveCommit } from './git-source.ts';
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

type ParsedTasksFile =
  | {
      readonly kind: 'ok';
      readonly tasks: readonly TaskDeclaration[];
      readonly leadPaths: readonly string[];
    }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Разбирает содержимое одного `.claude/tasks/*.json` независимо от источника (диск/git). */
const parseTasksFileContent = (raw: string, label: string): ParsedTasksFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'invalid', reason: `${label} не является валидным JSON: ${String(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'invalid', reason: `${label}: должен быть объектом` };
  }

  const file = parsed as TasksFile;
  if (!Array.isArray(file.tasks) || !file.tasks.every(isTaskDeclaration)) {
    return {
      kind: 'invalid',
      reason: `${label}: обязательное поле tasks — массив TaskDeclaration (task_id, owner_role, write_paths)`,
    };
  }

  const leadPaths: string[] = [];
  if (file.lead_paths !== undefined) {
    if (!Array.isArray(file.lead_paths) || !file.lead_paths.every((p) => typeof p === 'string')) {
      return { kind: 'invalid', reason: `${label}: lead_paths должен быть списком строк` };
    }
    leadPaths.push(...(file.lead_paths as readonly string[]));
  }

  // Finding раунда I00-F5 (живой прогон): `iteration_id` файла проставляется в каждую его задачу,
  // чтобы `checkOwnership` мог отличить «две задачи ОДНОЙ итерации делят путь» (реальный конфликт)
  // от «путь снова правится в СЛЕДУЮЩЕЙ итерации» (норма) при объединении нескольких карт
  // (`loadTaskDeclarations(FromGit)` ниже). Поле самого JSON-объекта задачи не читается — источник
  // истины один, на уровне файла, а не дублируется в каждой задаче вручную.
  const iterationId = typeof file.iteration_id === 'string' ? file.iteration_id : undefined;
  const tasks = file.tasks.map((task) => ({
    ...task,
    ...(iterationId === undefined ? {} : { iteration_id: iterationId }),
  }));

  return { kind: 'ok', tasks, leadPaths };
};

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

    const result = parseTasksFileContent(raw, entry);
    if (result.kind === 'invalid') return result;
    tasks.push(...result.tasks);
    leadPaths.push(...result.leadPaths);
  }

  return { kind: 'loaded', tasks, leadPaths };
};

/**
 * Читает и объединяет все `<ref>:<tasksDir>/*.json` из git-объекта, а не из рабочего дерева
 * (N1/N2, второй раунд верификации). См. развёрнутое обоснование у `loadWriteSetFromGit` в
 * `writeset.ts`: рабочее дерево — путь, который может исправить сама ограничиваемая task-сессия,
 * поэтому авторитетная проверка (`subagent-stop-writeset.ts`) не должна на него полагаться.
 *
 * Если `ref` не резолвится в коммит — fail-closed (`kind: 'invalid'`), а не чтение рабочего дерева.
 */
export const loadTaskDeclarationsFromGit = (
  projectRoot: string,
  ref: string,
  tasksDir = '.claude/tasks',
): TasksDirectoryResult => {
  const commit = resolveCommit(projectRoot, ref);
  if (commit.kind === 'error') return { kind: 'invalid', reason: commit.reason };

  const entries = listJsonFilesInGitDir(projectRoot, ref, tasksDir);
  if (entries.length === 0) return { kind: 'absent' };

  const tasks: TaskDeclaration[] = [];
  const leadPaths: string[] = [];

  for (const path of entries) {
    const blob = readGitBlob(projectRoot, ref, path);
    if (blob.kind !== 'ok') {
      const reason =
        blob.kind === 'error'
          ? blob.reason
          : `путь пропал между перечислением каталога и чтением файла в git-объекте ${ref}`;
      return { kind: 'invalid', reason: `${path} недоступен из git-объекта ${ref}: ${reason}` };
    }

    const result = parseTasksFileContent(blob.content, path);
    if (result.kind === 'invalid') return result;
    tasks.push(...result.tasks);
    leadPaths.push(...result.leadPaths);
  }

  return { kind: 'loaded', tasks, leadPaths };
};
