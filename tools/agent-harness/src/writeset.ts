import { readFileSync } from 'node:fs';

/**
 * Declared write set текущей задачи (`08_TDD_AND_AGENT_WORKFLOW` §12).
 *
 * B2 review finding: наличие/отсутствие этого файла — НЕ доказательство роли сессии.
 * Файл удаляем самой task-сессией (`rm -f .claude/writeset.json`), поэтому `kind: 'lead'`
 * здесь означает буквально «файл отсутствует или пуст», а не «это lead». Единственный
 * неподделываемый признак роли — hook payload (`agent_id`/`agent_type`), см.
 * `classifySession` в `session-role.ts`. Вызывающий код обязан комбинировать оба сигнала:
 * task-сессия с `kind: 'lead'` здесь обязана получить deny (fail-closed), а не allow.
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
  if (!isStringArray(candidate['write_paths']) || candidate['write_paths'].length === 0) {
    return {
      kind: 'invalid',
      reason: 'writeset.json: write_paths обязателен и не может быть пустым',
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
