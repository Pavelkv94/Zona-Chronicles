import { readFileSync } from 'node:fs';
import { readGitBlob, resolveCommit } from './git-source.ts';

/**
 * Declared write set текущей задачи (`08_TDD_AND_AGENT_WORKFLOW` §12).
 *
 * B2 review finding: наличие/отсутствие этого файла — НЕ доказательство роли сессии.
 * Файл удаляем самой task-сессией (`rm -f .claude/writeset.json`), поэтому `kind: 'lead'`
 * здесь означает буквально «файл отсутствует или пуст», а не «это lead». Единственный
 * неподделываемый признак роли — hook payload (`agent_id`/`agent_type`), см.
 * `classifySession` в `session-role.ts`. Вызывающий код обязан комбинировать оба сигнала:
 * task-сессия с `kind: 'lead'` здесь обязана получить deny (fail-closed), а не allow.
 *
 * M-7 (review, третий раунд): `owner_role: "reviewer"` — единственная роль, допускающая пустой
 * `write_paths`. До фикса `write_paths` не мог быть пустым ни для кого, из-за чего read-only
 * reviewer-сессии приходилось кодировать «ноль прав» путём вне корня репозитория — тот путь
 * никогда не совпадает ни с одним `write_paths`, но выглядит как «задача владеет чем-то», хотя
 * реально не владеет ничем; ADR-008 (правка от 2026-08-21) прямо запрещает такое кодирование.
 * Явно пустой `write_paths` при `owner_role: "reviewer"` означает буквально то же самое —
 * `decideWrite`/`findDiffViolations`/`checkOwnership` уже трактуют пустой список как «ничего не
 * разрешено» (`matchesAnyGlob(path, [])` всегда `false`) без дополнительных изменений в них.
 */
export type WriteSet = {
  readonly task_id: string;
  readonly owner_role: string;
  readonly write_paths: readonly string[];
  readonly allow_protected_paths?: readonly string[];
};

export type WriteSetLoadResult =
  | { readonly kind: 'lead' }
  | { readonly kind: 'task'; readonly writeSet: WriteSet }
  | { readonly kind: 'invalid'; readonly reason: string };

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Разбирает и валидирует содержимое `.claude/writeset.json`. */
export const parseWriteSet = (raw: string): WriteSetLoadResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'invalid', reason: `writeset.json не является валидным JSON: ${String(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'invalid', reason: 'writeset.json должен быть объектом' };
  }
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate['task_id'] !== 'string' || candidate['task_id'].length === 0) {
    return { kind: 'invalid', reason: 'writeset.json: обязательное поле task_id' };
  }
  if (typeof candidate['owner_role'] !== 'string' || candidate['owner_role'].length === 0) {
    return { kind: 'invalid', reason: 'writeset.json: обязательное поле owner_role' };
  }
  // M-7 (review, третий раунд): reviewer — единственная роль, для которой нулевые права записи
  // выражаются явно пустым write_paths, а не кодированием несовпадающим путём (ADR-008, правка от
  // 2026-08-21). Любая другая роль обязана иметь хотя бы один write path, как и раньше.
  const isReviewer = candidate['owner_role'] === 'reviewer';
  if (
    !isStringArray(candidate['write_paths']) ||
    (!isReviewer && candidate['write_paths'].length === 0)
  ) {
    return {
      kind: 'invalid',
      reason: isReviewer
        ? 'writeset.json: write_paths обязателен и должен быть списком строк (может быть пустым для owner_role: reviewer)'
        : 'writeset.json: write_paths обязателен и не может быть пустым',
    };
  }
  const allowProtected = candidate['allow_protected_paths'];
  if (allowProtected !== undefined && !isStringArray(allowProtected)) {
    return {
      kind: 'invalid',
      reason: 'writeset.json: allow_protected_paths должен быть списком строк',
    };
  }

  const writeSet: WriteSet = {
    task_id: candidate['task_id'],
    owner_role: candidate['owner_role'],
    write_paths: candidate['write_paths'],
    ...(allowProtected === undefined ? {} : { allow_protected_paths: allowProtected }),
  };
  return { kind: 'task', writeSet };
};

/**
 * Читает write set с диска. Отсутствие файла даёт `kind: 'lead'` — это факт о файле,
 * не о сессии (см. предупреждение у `WriteSetLoadResult`).
 */
export const loadWriteSet = (path: string): WriteSetLoadResult => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'lead' };
    return { kind: 'invalid', reason: `writeset.json недоступен: ${String(error)}` };
  }
  return parseWriteSet(raw);
};

/**
 * Читает write set из git-объекта `<ref>:<path>`, а не с диска (N1/N2, второй раунд верификации).
 *
 * Рабочее дерево — write path, доступный самой ограничиваемой task-сессии (через Bash в обход
 * PreToolUse-слоёв). Git-объект уже закоммиченного `ref` ей недоступен на запись без `git commit`,
 * а слои `decide-write.ts` и Bash-эвристика в `decide-bash.ts` не дают наполнить `.claude/**`
 * вредоносным содержимым до коммита. Это — авторитетный источник для `subagent-stop-writeset.ts`;
 * `loadWriteSet` (дисковый) остаётся для PreToolUse-хуков, где решение нужно до первого коммита
 * задачи и где протокол «lead коммитит control-файлы до старта задачи» — часть orchestration-flow.
 *
 * Если `ref` не резолвится в коммит — fail-closed (`kind: 'invalid'`), а не попытка прочитать
 * рабочее дерево.
 */
export const loadWriteSetFromGit = (
  projectRoot: string,
  ref: string,
  path = '.claude/writeset.json',
): WriteSetLoadResult => {
  const commit = resolveCommit(projectRoot, ref);
  if (commit.kind === 'error') return { kind: 'invalid', reason: commit.reason };

  const blob = readGitBlob(projectRoot, ref, path);
  if (blob.kind === 'absent') return { kind: 'lead' };
  if (blob.kind === 'error') {
    return {
      kind: 'invalid',
      reason: `writeset.json недоступен из git-объекта ${ref}: ${blob.reason}`,
    };
  }
  return parseWriteSet(blob.content);
};
