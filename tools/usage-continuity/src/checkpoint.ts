/**
 * Сериализация/десериализация checkpoint пятичасового usage window (DEV-01).
 * Формат: YAML frontmatter, где значения — валидный JSON (JSON — подмножество YAML flow
 * syntax), поэтому файл одновременно человекочитаем и точно парсится без YAML-зависимости.
 */
import type { Checkpoint } from './types.ts';

const FRONTMATTER_DELIMITER = '---';

/** Обязательные строковые поля, в порядке рендера. */
const REQUIRED_STRING_FIELDS = [
  'task_id',
  'iteration_id',
  'objective',
  'plan_status',
  'branch',
  'worktree',
  'base_sha',
  'head_sha',
  'last_red',
  'last_green',
  'next_exact_action',
  'reported_reset_at',
  'checkpointed_at',
] as const;

/** Обязательные поля-массивы строк, в порядке рендера. */
const REQUIRED_ARRAY_FIELDS = [
  'changed_files',
  'dirty_files',
  'own_commits',
  'unfinished_processes',
  'decisions',
  'risks',
] as const;

/** Порядок ключей в frontmatter — фиксирован для стабильного diff между checkpoint-версиями. */
const FIELD_ORDER: readonly string[] = [
  'task_id',
  'iteration_id',
  'objective',
  'plan_status',
  'branch',
  'worktree',
  'base_sha',
  'head_sha',
  'changed_files',
  'dirty_files',
  'own_commits',
  'last_red',
  'last_green',
  'unfinished_processes',
  'decisions',
  'risks',
  'next_exact_action',
  'usage_window_remaining_percent',
  'reported_reset_at',
  'checkpointed_at',
];

/** Рендер checkpoint в markdown-файл с YAML-frontmatter. JSON-кодирование даёт точный round trip. */
export function renderCheckpoint(checkpoint: Checkpoint): string {
  const lines: string[] = [FRONTMATTER_DELIMITER];
  const record: Record<string, unknown> = { ...checkpoint };
  for (const key of FIELD_ORDER) {
    lines.push(`${key}: ${JSON.stringify(record[key])}`);
  }
  if (checkpoint.capability_status !== undefined) {
    lines.push(`capability_status: ${JSON.stringify(checkpoint.capability_status)}`);
  }
  lines.push(FRONTMATTER_DELIMITER, '');
  return lines.join('\n');
}

/** Результат неудачного парсинга — точная причина, чтобы runner не продолжал молча. */
export interface CheckpointParseError {
  readonly error: string;
}

function parseFrontmatterLines(text: string): string[] | CheckpointParseError {
  const lines = text.split('\n');
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    return { error: 'checkpoint не начинается с YAML frontmatter delimiter "---"' };
  }
  const closingIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (closingIndex === -1) {
    return { error: 'checkpoint не содержит закрывающий frontmatter delimiter "---"' };
  }
  return lines.slice(1, closingIndex).filter((line) => line.length > 0);
}

function parseFieldLine(line: string): { key: string; value: unknown } | CheckpointParseError {
  const separatorIndex = line.indexOf(': ');
  if (separatorIndex === -1) {
    return { error: `строка frontmatter без разделителя "key: value": ${line}` };
  }
  const key = line.slice(0, separatorIndex);
  const rawValue = line.slice(separatorIndex + 2);
  try {
    return { key, value: JSON.parse(rawValue) as unknown };
  } catch {
    return { error: `значение поля "${key}" не является валидным JSON: ${rawValue}` };
  }
}

function isCheckpointParseError(value: unknown): value is CheckpointParseError {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function requireString(fields: Map<string, unknown>, key: string): string | CheckpointParseError {
  const value = fields.get(key);
  if (typeof value !== 'string') {
    return { error: `обязательное поле "${key}" отсутствует или не строка` };
  }
  return value;
}

function requireStringArray(
  fields: Map<string, unknown>,
  key: string,
): string[] | CheckpointParseError {
  const value = fields.get(key);
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { error: `обязательное поле "${key}" отсутствует или не массив строк` };
  }
  return value;
}

function requireNumber(fields: Map<string, unknown>, key: string): number | CheckpointParseError {
  const value = fields.get(key);
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { error: `обязательное поле "${key}" отсутствует или не число` };
  }
  return value;
}

/** Парсинг checkpoint из markdown-файла. Никогда не бросает исключение — только { error }. */
export function parseCheckpoint(text: string): Checkpoint | CheckpointParseError {
  const frontmatterLines = parseFrontmatterLines(text);
  if (isCheckpointParseError(frontmatterLines)) {
    return frontmatterLines;
  }

  const fields = new Map<string, unknown>();
  for (const line of frontmatterLines) {
    const parsed = parseFieldLine(line);
    if (isCheckpointParseError(parsed)) {
      return parsed;
    }
    fields.set(parsed.key, parsed.value);
  }

  const stringValues = new Map<string, string>();
  for (const key of REQUIRED_STRING_FIELDS) {
    const value = requireString(fields, key);
    if (isCheckpointParseError(value)) {
      return value;
    }
    stringValues.set(key, value);
  }

  const arrayValues = new Map<string, string[]>();
  for (const key of REQUIRED_ARRAY_FIELDS) {
    const value = requireStringArray(fields, key);
    if (isCheckpointParseError(value)) {
      return value;
    }
    arrayValues.set(key, value);
  }

  const remainingPercent = requireNumber(fields, 'usage_window_remaining_percent');
  if (isCheckpointParseError(remainingPercent)) {
    return remainingPercent;
  }

  const getString = (key: string): string => {
    const value = stringValues.get(key);
    if (value === undefined) {
      throw new Error(`internal: string field "${key}" validated but missing from map`);
    }
    return value;
  };
  const getArray = (key: string): string[] => {
    const value = arrayValues.get(key);
    if (value === undefined) {
      throw new Error(`internal: array field "${key}" validated but missing from map`);
    }
    return value;
  };

  const checkpoint: Checkpoint = {
    task_id: getString('task_id'),
    iteration_id: getString('iteration_id'),
    objective: getString('objective'),
    plan_status: getString('plan_status'),
    branch: getString('branch'),
    worktree: getString('worktree'),
    base_sha: getString('base_sha'),
    head_sha: getString('head_sha'),
    changed_files: getArray('changed_files'),
    dirty_files: getArray('dirty_files'),
    own_commits: getArray('own_commits'),
    last_red: getString('last_red'),
    last_green: getString('last_green'),
    unfinished_processes: getArray('unfinished_processes'),
    decisions: getArray('decisions'),
    risks: getArray('risks'),
    next_exact_action: getString('next_exact_action'),
    usage_window_remaining_percent: remainingPercent,
    reported_reset_at: getString('reported_reset_at'),
    checkpointed_at: getString('checkpointed_at'),
  };

  const capabilityStatus = fields.get('capability_status');
  if (capabilityStatus === undefined) {
    return checkpoint;
  }
  if (typeof capabilityStatus !== 'string') {
    return { error: 'поле "capability_status" присутствует, но не строка' };
  }
  return { ...checkpoint, capability_status: capabilityStatus };
}
