import { readFileSync } from 'node:fs';

/**
 * Валидатор `security/exceptions.json` (ADR-008, A10 в ACCEPTANCE I00).
 *
 * Любое исключение без обязательного поля, с blanket scope (`*` или только
 * wildcard-символы, а также любой `*` внутри пути — область обязана быть точной)
 * или с истёкшим `expiry` невалидно. `now` инъектируется вызывающей стороной:
 * чистая функция не читает системные часы напрямую.
 *
 * minor2 (review finding): для `check === 'dependencies'` scope обязан быть
 * идентификатором конкретного ЭКЗЕМПЛЯРА — numeric advisory id (`"1096485"`, как
 * в `pnpm audit --json`) или `package@version` (`"minimatch@3.0.4"`). Голое имя
 * пакета (`"minimatch"`, без версии) подавляло бы ВСЕ его advisories, включая
 * будущие, — то же blanket-подавление, что и M1, только по другой оси (версия,
 * а не check/category). Предложение по ADR-008 в REVIEW.md требует `package@version`.
 */

export const CHECK_NAMES = ['secrets', 'dependencies', 'licenses', 'static', 'no-llm'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type SecurityException = {
  readonly id: string;
  readonly check: CheckName;
  readonly scope: string;
  readonly reason: string;
  readonly compensating_control: string;
  readonly owner: string;
  readonly created_at: string;
  readonly expiry: string;
};

export type ExceptionError = {
  readonly message: string;
  /** Проверка, которую блокирует эта ошибка. `null` — check не определён, блокирует все проверки. */
  readonly check: CheckName | null;
};

export type ParseExceptionsResult = {
  readonly valid: readonly SecurityException[];
  readonly errors: readonly ExceptionError[];
};

const REQUIRED_STRING_FIELDS = [
  'id',
  'check',
  'scope',
  'reason',
  'compensating_control',
  'owner',
  'created_at',
  'expiry',
] as const;

const isCheckName = (value: unknown): value is CheckName =>
  typeof value === 'string' && (CHECK_NAMES as readonly string[]).includes(value);

/** Blanket scope: точный `*` или строка, состоящая только из wildcard-символов, или содержащая `*`. */
const isBlanketScope = (scope: string): boolean => scope.includes('*') || scope.includes('?');

/**
 * minor2: для `check === 'dependencies'` — является ли scope идентификатором
 * экземпляра (numeric advisory id или `package@version`), а не голым именем пакета.
 */
const isDependencyInstanceScope = (scope: string): boolean => {
  if (/^[0-9]+$/.test(scope)) return true; // npm-audit advisory id, всегда числовой
  const at = scope.lastIndexOf('@');
  if (at <= 0) return false; // нет имени перед версией (и не допускает scope, начинающийся с "@")
  const namePart = scope.slice(0, at);
  const versionPart = scope.slice(at + 1);
  return namePart.length > 0 && /^\d/.test(versionPart);
};

const parseDate = (value: string): Date | null => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

type RawRecord = Record<string, unknown>;

const validateEntry = (
  raw: unknown,
  index: number,
  now: Date,
):
  | { readonly ok: true; readonly value: SecurityException }
  | { readonly ok: false; readonly errors: ExceptionError[] } => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ message: `exceptions[${index}]: элемент должен быть объектом`, check: null }],
    };
  }
  const candidate = raw as RawRecord;
  const errors: ExceptionError[] = [];
  const checkField = candidate['check'];
  const check = isCheckName(checkField) ? checkField : null;

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.length === 0) {
      errors.push({
        message: `exceptions[${index}]: обязательное поле "${field}" отсутствует или пусто`,
        check,
      });
    }
  }
  if (checkField !== undefined && check === null) {
    errors.push({
      message: `exceptions[${index}]: поле "check" должно быть одним из ${CHECK_NAMES.join(', ')}`,
      check: null,
    });
  }

  const scope = candidate['scope'];
  if (typeof scope === 'string' && scope.length > 0 && isBlanketScope(scope)) {
    errors.push({
      message: `exceptions[${index}]: scope "${scope}" — blanket/wildcard scope запрещён, требуется точный путь/пакет/advisory`,
      check,
    });
  }
  if (
    check === 'dependencies' &&
    typeof scope === 'string' &&
    scope.length > 0 &&
    !isBlanketScope(scope) &&
    !isDependencyInstanceScope(scope)
  ) {
    errors.push({
      message:
        `exceptions[${index}]: scope "${scope}" для check="dependencies" обязан быть ` +
        `идентификатором экземпляра — advisory id (например "1096485") или package@version ` +
        `(например "minimatch@3.0.4"); голое имя пакета подавило бы все его advisories, включая будущие (minor2)`,
      check,
    });
  }

  const expiry = candidate['expiry'];
  if (typeof expiry === 'string' && expiry.length > 0) {
    const expiryDate = parseDate(expiry);
    if (expiryDate === null) {
      errors.push({ message: `exceptions[${index}]: expiry "${expiry}" не является датой`, check });
    } else if (expiryDate.getTime() < now.getTime()) {
      errors.push({
        message: `exceptions[${index}]: expiry "${expiry}" истёк (now=${now.toISOString()})`,
        check,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      id: candidate['id'] as string,
      check: check as CheckName,
      scope: scope as string,
      reason: candidate['reason'] as string,
      compensating_control: candidate['compensating_control'] as string,
      owner: candidate['owner'] as string,
      created_at: candidate['created_at'] as string,
      expiry: expiry as string,
    },
  };
};

/** Разбирает и валидирует содержимое `security/exceptions.json`. Чистая функция. */
export const parseExceptions = (raw: string, now: Date): ParseExceptionsResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      valid: [],
      errors: [
        { message: `exceptions.json не является валидным JSON: ${String(error)}`, check: null },
      ],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      valid: [],
      errors: [{ message: 'exceptions.json должен быть массивом', check: null }],
    };
  }

  const errors: ExceptionError[] = [];
  const candidates: SecurityException[] = [];

  parsed.forEach((entry, index) => {
    const result = validateEntry(entry, index, now);
    if (result.ok) {
      candidates.push(result.value);
    } else {
      errors.push(...result.errors);
    }
  });

  const idCounts = new Map<string, number>();
  for (const candidate of candidates) {
    idCounts.set(candidate.id, (idCounts.get(candidate.id) ?? 0) + 1);
  }
  const valid: SecurityException[] = [];
  for (const candidate of candidates) {
    const count = idCounts.get(candidate.id) ?? 0;
    if (count > 1) {
      errors.push({
        message: `exceptions.json: duplicate id "${candidate.id}"`,
        check: candidate.check,
      });
    } else {
      valid.push(candidate);
    }
  }

  return { valid, errors };
};

/** io: читает и валидирует `security/exceptions.json`. */
export const loadExceptions = (repoRoot: string, now: Date): ParseExceptionsResult => {
  let raw: string;
  try {
    raw = readFileSync(`${repoRoot}/security/exceptions.json`, 'utf8');
  } catch (error) {
    return {
      valid: [],
      errors: [
        { message: `не удалось прочитать security/exceptions.json: ${String(error)}`, check: null },
      ],
    };
  }
  return parseExceptions(raw, now);
};

export type ExceptionableFinding = {
  readonly id: string;
  readonly severity: string;
  readonly path?: string;
  readonly package?: string;
  readonly message: string;
};

export type ApplyExceptionsResult<T> = {
  readonly active: readonly T[];
  readonly suppressed: readonly T[];
};

/**
 * Применяет валидные исключения к находкам одной проверки.
 *
 * Совпадение требует точного равенства `scope` с `finding.path` либо `finding.package`
 * (никаких glob/wildcard) — это же гарантирует `parseExceptions`, отклоняя blanket scope.
 *
 * `finding.id` матчится ТОЛЬКО для `check === 'dependencies'`: там это id конкретного
 * advisory-экземпляра (npm audit), поэтому точечное исключение по id безопасно. Для
 * остальных проверок `id` — имя ПРАВИЛА/КАТЕГОРИИ, общее для всех находок этого вида
 * в репозитории (у `licenses` — строка лицензии; у `no-llm` — `llm-import` и т.п.; у
 * `static` — `eval-call` и т.п.; у `secrets` — `aws-access-key-id` и т.п.). Матчинг по
 * `id` там подавил бы весь класс находок одним исключением — ровно blanket allowlist,
 * запрещённый ADR-008/A10 (M1 review finding). Исключение обязано именовать конкретный
 * `path`/`package`.
 */
export const applyExceptions = <T extends ExceptionableFinding>(
  findings: readonly T[],
  validExceptions: readonly SecurityException[],
  check: CheckName,
): ApplyExceptionsResult<T> => {
  const scopesForCheck = new Set(
    validExceptions
      .filter((exception) => exception.check === check)
      .map((exception) => exception.scope),
  );

  const active: T[] = [];
  const suppressed: T[] = [];
  for (const finding of findings) {
    const matchesPathOrPackage =
      (finding.path !== undefined && scopesForCheck.has(finding.path)) ||
      (finding.package !== undefined && scopesForCheck.has(finding.package));
    const matchesInstanceId = check === 'dependencies' && scopesForCheck.has(finding.id);
    if (matchesPathOrPackage || matchesInstanceId) {
      suppressed.push(finding);
    } else {
      active.push(finding);
    }
  }
  return { active, suppressed };
};

/** Находит ошибки, которые должны провалить конкретную проверку (или все, если check не определён). */
export const forcedFailuresFor = (
  errors: readonly ExceptionError[],
  check: CheckName,
): readonly ExceptionError[] =>
  errors.filter((error) => error.check === check || error.check === null);
