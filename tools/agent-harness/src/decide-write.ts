import { isAbsolute, relative } from 'node:path';
import { matchesAnyGlob, normalizePath } from './glob.ts';
import { HUMAN_ONLY_PATHS, PROTECTED_PATHS } from './protected-paths.ts';
import type { WriteSetLoadResult } from './writeset.ts';

export type WriteDecision = {
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
};

export type WriteRequest = {
  /** Путь из tool_input: абсолютный или относительный. */
  readonly targetPath: string;
  /** Корень проекта (cwd hook-а). */
  readonly projectRoot: string;
  readonly writeSet: WriteSetLoadResult;
};

const allow = (reason: string): WriteDecision => ({ decision: 'allow', reason });
const deny = (reason: string): WriteDecision => ({ decision: 'deny', reason });

/** Приводит путь к пути относительно корня проекта; `null` — путь вне репозитория. */
export const toRepoRelative = (targetPath: string, projectRoot: string): string | null => {
  const absolute = isAbsolute(targetPath) ? targetPath : `${projectRoot}/${targetPath}`;
  const relativePath = normalizePath(relative(normalizePath(projectRoot), normalizePath(absolute)));
  if (relativePath === '' || relativePath.startsWith('../')) return null;
  return relativePath;
};

/**
 * Чистое решение о допустимости записи.
 *
 * Порядок проверок фиксирован и важен:
 * 1. секреты запрещены всем;
 * 2. путь вне репозитория запрещён задаче subagent-а;
 * 3. lead-сессия (нет writeset.json) работает без ограничения по write set;
 * 4. невалидный writeset.json — fail-closed;
 * 5. protected path запрещён, если он не выдан задаче явно;
 * 6. запись обязана попадать в declared write paths.
 */
export const decideWrite = ({ targetPath, projectRoot, writeSet }: WriteRequest): WriteDecision => {
  const repoPath = toRepoRelative(targetPath, projectRoot);

  if (repoPath !== null && matchesAnyGlob(repoPath, HUMAN_ONLY_PATHS)) {
    return deny(`Запись в ${repoPath} запрещена: секреты и ключи редактирует только человек.`);
  }

  if (writeSet.kind === 'lead') {
    return allow('Lead-сессия: declared write set отсутствует.');
  }

  if (writeSet.kind === 'invalid') {
    return deny(`Fail-closed: ${writeSet.reason}`);
  }

  if (repoPath === null) {
    return deny(
      `Запись вне корня репозитория (${targetPath}) запрещена задаче ${writeSet.writeSet.task_id}.`,
    );
  }

  const { task_id: taskId, write_paths: writePaths } = writeSet.writeSet;
  const allowedProtected = writeSet.writeSet.allow_protected_paths ?? [];

  if (matchesAnyGlob(repoPath, PROTECTED_PATHS) && !matchesAnyGlob(repoPath, allowedProtected)) {
    return deny(
      `Protected path: ${repoPath}. Задача ${taskId} не владеет им; изменение вносит orchestrator/lead.`,
    );
  }

  if (!matchesAnyGlob(repoPath, writePaths)) {
    return deny(
      `Путь ${repoPath} вне declared write set задачи ${taskId}: [${writePaths.join(', ')}].`,
    );
  }

  return allow(`Путь ${repoPath} входит в declared write set задачи ${taskId}.`);
};

/** Извлекает целевой путь из tool_input поддерживаемых инструментов записи. */
export const extractTargetPath = (toolInput: unknown): string | null => {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  for (const key of ['file_path', 'notebook_path', 'path'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
};
