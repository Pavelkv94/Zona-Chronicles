import { readFileSync } from 'node:fs';

/**
 * Machine-readable security policy (`security/policy.json`, OPS-03/NAR-02).
 *
 * Загрузка отделена от парсинга/валидации: `parsePolicy` — чистая функция для
 * тестов, `loadPolicy` — тонкая io-обёртка над файловой системой.
 */

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

/**
 * Единая шкала severity для secret/static/license проверок (dependency_policy
 * держит собственную `severity_order`, потому что npm audit добавляет `info`
 * и отдельно управляет поведением при неизвестной severity).
 */
export const SEVERITY_SCALE: readonly Severity[] = ['low', 'moderate', 'high', 'critical'];

/**
 * Чистая функция: единообразное применение `min_blocking_severity` (m7).
 * Неизвестная finding-severity или неизвестный порог не пропускаются молча —
 * fail-closed (`true`, блокирует), а не fail-open.
 */
export const meetsMinSeverity = (severity: string, minBlockingSeverity: string): boolean => {
  const scale = SEVERITY_SCALE as readonly string[];
  const index = scale.indexOf(severity.toLowerCase());
  const minIndex = scale.indexOf(minBlockingSeverity.toLowerCase());
  if (index === -1 || minIndex === -1) return true;
  return index >= minIndex;
};

export type NamedPattern = {
  readonly id: string;
  readonly description: string;
  readonly severity: Severity;
  readonly regex: string;
  readonly flags: string;
};

export type DependencyPolicy = {
  readonly owner: string;
  readonly requirement: string;
  readonly severity_order: readonly string[];
  readonly min_blocking_severity: string;
  readonly unknown_severity_behavior: 'block' | 'allow';
};

/**
 * Production/development split (M2/M3): один allowlist на весь граф судил
 * build-time-only инструмент так же строго, как поставляемый код, и требовал
 * платформозависимых per-package исключений (`lightningcss-<platform>`).
 * `production.allowed` — строгий allowlist для production-графа
 * (`pnpm licenses list --json --prod`). `development.allowed` — ДОПОЛНИТЕЛЬНЫЕ
 * лицензии, разрешённые только вне production-графа (file-level weak copyleft
 * вроде MPL-2.0/EPL-2.0); эффективный allowlist для dev-only пакетов —
 * объединение `production.allowed` и `development.allowed`. `denied` общий и
 * строгий для обоих графов.
 */
export type LicensePolicy = {
  readonly owner: string;
  readonly requirement: string;
  readonly denied: readonly string[];
  readonly production: { readonly allowed: readonly string[] };
  readonly development: { readonly allowed: readonly string[]; readonly rationale: string };
  readonly unknown_license_behavior: 'review_required' | 'allow';
  readonly min_blocking_severity: Severity;
};

export type SecretPolicy = {
  readonly owner: string;
  readonly requirement: string;
  readonly patterns: readonly NamedPattern[];
  readonly allowlisted_paths: readonly string[];
  readonly min_blocking_severity: Severity;
};

export type StaticPolicy = {
  readonly owner: string;
  readonly requirement: string;
  readonly forbidden_constructs: readonly NamedPattern[];
  readonly allowlisted_paths: readonly string[];
  readonly min_blocking_severity: Severity;
};

export type LlmPolicy = {
  readonly owner: string;
  readonly requirement: string;
  readonly denied_packages: readonly string[];
  readonly denied_path_fragments: readonly string[];
  readonly denied_env_var_pattern: string;
  readonly allowlisted_paths: readonly string[];
};

export type SecurityPolicy = {
  readonly policy_version: string;
  readonly dependency_policy: DependencyPolicy;
  readonly license_policy: LicensePolicy;
  readonly secret_policy: SecretPolicy;
  readonly static_policy: StaticPolicy;
  readonly llm_policy: LlmPolicy;
};

export type PolicyParseResult =
  | { readonly kind: 'ok'; readonly policy: SecurityPolicy }
  | { readonly kind: 'invalid'; readonly reason: string };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const invalid = (reason: string): PolicyParseResult => ({ kind: 'invalid', reason });

const isNamedPattern = (value: unknown): value is NamedPattern => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate['id']) &&
    isNonEmptyString(candidate['description']) &&
    isNonEmptyString(candidate['regex']) &&
    typeof candidate['flags'] === 'string' &&
    isNonEmptyString(candidate['severity']) &&
    ['low', 'moderate', 'high', 'critical'].includes(candidate['severity'])
  );
};

const isNamedPatternArray = (value: unknown): value is readonly NamedPattern[] =>
  Array.isArray(value) && value.every((item) => isNamedPattern(item));

const isSeverity = (value: unknown): value is Severity =>
  typeof value === 'string' && (SEVERITY_SCALE as readonly string[]).includes(value);

/** Разбирает и структурно валидирует `security/policy.json`. Чистая функция. */
export const parsePolicy = (raw: string): PolicyParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return invalid(`policy.json не является валидным JSON: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return invalid('policy.json должен быть объектом');
  }
  const root = parsed as Record<string, unknown>;

  if (!isNonEmptyString(root['policy_version'])) {
    return invalid('policy.json: обязательное строковое поле policy_version');
  }

  const dependencyPolicy = root['dependency_policy'];
  if (typeof dependencyPolicy !== 'object' || dependencyPolicy === null) {
    return invalid('policy.json: обязательный раздел dependency_policy');
  }
  const dep = dependencyPolicy as Record<string, unknown>;
  if (
    !isNonEmptyString(dep['owner']) ||
    !isNonEmptyString(dep['requirement']) ||
    !isNonEmptyString(dep['min_blocking_severity']) ||
    (dep['unknown_severity_behavior'] !== 'block' && dep['unknown_severity_behavior'] !== 'allow')
  ) {
    return invalid(
      'policy.json: dependency_policy требует owner/requirement/min_blocking_severity/unknown_severity_behavior',
    );
  }

  const licensePolicy = root['license_policy'];
  if (typeof licensePolicy !== 'object' || licensePolicy === null) {
    return invalid('policy.json: обязательный раздел license_policy');
  }
  const lic = licensePolicy as Record<string, unknown>;
  const licProduction = lic['production'];
  const licDevelopment = lic['development'];
  const licProductionOk =
    typeof licProduction === 'object' &&
    licProduction !== null &&
    isStringArray((licProduction as Record<string, unknown>)['allowed']);
  const licDevelopmentOk =
    typeof licDevelopment === 'object' &&
    licDevelopment !== null &&
    isStringArray((licDevelopment as Record<string, unknown>)['allowed']) &&
    isNonEmptyString((licDevelopment as Record<string, unknown>)['rationale']);
  if (
    !isNonEmptyString(lic['owner']) ||
    !isNonEmptyString(lic['requirement']) ||
    !isStringArray(lic['denied']) ||
    !licProductionOk ||
    !licDevelopmentOk ||
    (lic['unknown_license_behavior'] !== 'review_required' &&
      lic['unknown_license_behavior'] !== 'allow') ||
    !isSeverity(lic['min_blocking_severity'])
  ) {
    return invalid(
      'policy.json: license_policy требует owner/requirement/denied/production.allowed/development.allowed+rationale/unknown_license_behavior/min_blocking_severity',
    );
  }

  const secretPolicy = root['secret_policy'];
  if (typeof secretPolicy !== 'object' || secretPolicy === null) {
    return invalid('policy.json: обязательный раздел secret_policy');
  }
  const secret = secretPolicy as Record<string, unknown>;
  if (
    !isNonEmptyString(secret['owner']) ||
    !isNonEmptyString(secret['requirement']) ||
    !isNamedPatternArray(secret['patterns']) ||
    !isStringArray(secret['allowlisted_paths']) ||
    !isSeverity(secret['min_blocking_severity'])
  ) {
    return invalid(
      'policy.json: secret_policy требует owner/requirement/patterns/allowlisted_paths/min_blocking_severity',
    );
  }

  const staticPolicy = root['static_policy'];
  if (typeof staticPolicy !== 'object' || staticPolicy === null) {
    return invalid('policy.json: обязательный раздел static_policy');
  }
  const staticP = staticPolicy as Record<string, unknown>;
  if (
    !isNonEmptyString(staticP['owner']) ||
    !isNonEmptyString(staticP['requirement']) ||
    !isNamedPatternArray(staticP['forbidden_constructs']) ||
    !isStringArray(staticP['allowlisted_paths']) ||
    !isSeverity(staticP['min_blocking_severity'])
  ) {
    return invalid(
      'policy.json: static_policy требует owner/requirement/forbidden_constructs/allowlisted_paths/min_blocking_severity',
    );
  }

  const llmPolicy = root['llm_policy'];
  if (typeof llmPolicy !== 'object' || llmPolicy === null) {
    return invalid('policy.json: обязательный раздел llm_policy');
  }
  const llm = llmPolicy as Record<string, unknown>;
  if (
    !isNonEmptyString(llm['owner']) ||
    !isNonEmptyString(llm['requirement']) ||
    !isStringArray(llm['denied_packages']) ||
    !isStringArray(llm['denied_path_fragments']) ||
    !isNonEmptyString(llm['denied_env_var_pattern']) ||
    !isStringArray(llm['allowlisted_paths'])
  ) {
    return invalid(
      'policy.json: llm_policy требует owner/requirement/denied_packages/denied_path_fragments/denied_env_var_pattern/allowlisted_paths',
    );
  }

  return {
    kind: 'ok',
    policy: {
      policy_version: root['policy_version'],
      dependency_policy: dep as unknown as DependencyPolicy,
      license_policy: lic as unknown as LicensePolicy,
      secret_policy: secret as unknown as SecretPolicy,
      static_policy: staticP as unknown as StaticPolicy,
      llm_policy: llm as unknown as LlmPolicy,
    },
  };
};

/** io: читает и парсит `security/policy.json` относительно корня репозитория. */
export const loadPolicy = (repoRoot: string): PolicyParseResult => {
  let raw: string;
  try {
    raw = readFileSync(`${repoRoot}/security/policy.json`, 'utf8');
  } catch (error) {
    return invalid(`не удалось прочитать security/policy.json: ${String(error)}`);
  }
  return parsePolicy(raw);
};

/** Компилирует именованный паттерн в RegExp. */
export const compilePattern = (pattern: NamedPattern): RegExp =>
  new RegExp(pattern.regex, pattern.flags);
