import { execFileSync } from 'node:child_process';

/**
 * Чтение control-файлов (`.claude/writeset.json`, `.claude/tasks/*.json`) из git-объекта
 * base-коммита, а не из рабочего дерева (N1/N2 review finding, второй раунд верификации).
 *
 * Рабочее дерево — это ровно то, что может редактировать task-сессия (напрямую через Bash,
 * в обход `no-tool`-слоёв защиты). Источник ограничений обязан быть недосягаем для
 * ограничиваемой сессии: git-объект уже закоммиченного base-коммита такой сессии недоступен на
 * запись без `git commit`, а `git commit` не создаёт новый контент — он лишь фиксирует то, что уже
 * есть в индексе/дереве, которое отдельные слои (`decide-write.ts`, Bash-эвристика в
 * `decide-bash.ts`) не дают наполнить вредоносным содержимым `.claude/**`.
 *
 * `base-коммит` здесь — это `HEAD` на момент запуска hook-а: тот же коммит, который уже служит
 * базой для `git diff --name-only HEAD` в `subagent-stop-writeset.ts`. Для `ownership:check`
 * base-коммит — явный обязательный CLI-аргумент (внешний, задаётся lead/CI, не файлом репозитория).
 *
 * Если base-коммит не резолвится (нет коммитов, битый SHA, не git-репозиторий) — fail-closed:
 * вызывающий код обязан трактовать `resolveCommit` с `kind: 'error'` как основание отказать,
 * а не как основание читать рабочее дерево.
 */

const runGit = (
  projectRoot: string,
  args: readonly string[],
):
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'error'; readonly reason: string } => {
  try {
    // stdio: 'pipe' явно — иначе stderr git-подпроцесса (например, ожидаемое
    // "fatal: path '…' does not exist in 'HEAD'" для отсутствующего пути) наследуется терминалом
    // хоста и утекает в stderr самого hook-а/CLI, хотя это ожидаемый и уже обработанный случай
    // (`isMissingPathError`), а не диагностика для пользователя.
    const stdout = execFileSync('git', [...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { kind: 'ok', stdout };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const message =
      typeof stderr === 'string' && stderr.trim().length > 0 ? stderr.trim() : String(error);
    return { kind: 'error', reason: message };
  }
};

/** Единственная точка «base-коммит известен / неизвестен» для всего модуля. */
export const resolveCommit = (
  projectRoot: string,
  ref: string,
): { readonly kind: 'ok' } | { readonly kind: 'error'; readonly reason: string } => {
  const result = runGit(projectRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (result.kind === 'error') {
    return {
      kind: 'error',
      reason: `base-коммит '${ref}' не резолвится в git-объект: ${result.reason}`,
    };
  }
  return { kind: 'ok' };
};

export type GitBlobResult =
  | { readonly kind: 'ok'; readonly content: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly reason: string };

/**
 * Git отличает «путь отсутствует в дереве ref» (`fatal: path '…' does not exist in '…'`) от прочих
 * ошибок (битый ref, повреждённый объект) характерной подстрокой сообщения. Это единственный
 * практичный способ различить эти случаи через CLI без парсинга plumbing-вывода; ограничение
 * задокументировано явно, а не спрятано.
 */
const isMissingPathError = (message: string): boolean => message.includes('does not exist in');

/** Содержимое файла из `<ref>:<path>`. Путь — POSIX, относительно корня репозитория. */
export const readGitBlob = (projectRoot: string, ref: string, path: string): GitBlobResult => {
  const result = runGit(projectRoot, ['show', `${ref}:${path}`]);
  if (result.kind === 'ok') return { kind: 'ok', content: result.stdout };
  if (isMissingPathError(result.reason)) return { kind: 'absent' };
  return { kind: 'error', reason: result.reason };
};

/**
 * Имена `*.json` непосредственно внутри директории `<ref>:<dir>` (без рекурсии в поддиректории —
 * ровно семантика `readdirSync`, которую эта функция заменяет для git-объектного источника).
 * Отсутствующая директория — пустой список, не ошибка (симметрично `readdirSync` + try/catch
 * в дисковой версии).
 */
export const listJsonFilesInGitDir = (
  projectRoot: string,
  ref: string,
  dir: string,
): readonly string[] => {
  const normalizedDir = dir.endsWith('/') ? dir : `${dir}/`;
  const result = runGit(projectRoot, ['ls-tree', '--name-only', ref, '--', normalizedDir]);
  if (result.kind === 'error') return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.json'))
    .sort();
};

export type GitPathKind = 'blob' | 'tree' | 'absent';

/** Тип пути в дереве `<ref>:<path>` — используется CLI, чтобы принять и файл, и каталог задач. */
export const gitPathKind = (projectRoot: string, ref: string, path: string): GitPathKind => {
  const result = runGit(projectRoot, ['cat-file', '-t', `${ref}:${path}`]);
  if (result.kind === 'error') return 'absent';
  const type = result.stdout.trim();
  return type === 'blob' || type === 'tree' ? type : 'absent';
};
