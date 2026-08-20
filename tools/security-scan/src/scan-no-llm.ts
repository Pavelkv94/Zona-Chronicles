import { readFileSync } from 'node:fs';
import { applyExceptions, forcedFailuresFor, loadExceptions } from './exceptions.ts';
import { matchesAnyGlob } from './glob.ts';
import { collectSourceFiles } from './source-files.ts';
import { listGitTrackedFiles, readTrackedFiles } from './git.ts';
import { loadPolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';
import type { Finding, ScanOutcome } from './report.ts';
import { buildReport } from './report.ts';

/**
 * No-LLM scan (NAR-02, ADR-006): до Gate E запрещены runtime LLM SDK, provider
 * keys, prompt/embedding-каталоги. Любая находка — non-zero, исключений в этом
 * check-е политика не предусматривает по умолчанию (только owner-подписанный
 * `security/exceptions.json`, если появится обоснованный кейс).
 */

export type ScannedFile = { readonly path: string; readonly content: string };

export type LlmScanInput = {
  readonly lockfileContent: string;
  readonly packageJsonFiles: readonly ScannedFile[];
  readonly sourceFiles: readonly ScannedFile[];
  readonly trackedPaths: readonly string[];
  readonly trackedFilesForEnv: readonly ScannedFile[];
};

const escapeRegex = (value: string): string => value.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');

/** `@scope/*` → префиксное сопоставление; иначе — точное имя пакета. */
const packageScope = (denied: string): { readonly prefix: string; readonly isWildcard: boolean } =>
  denied.endsWith('/*')
    ? { prefix: denied.slice(0, -1), isWildcard: true }
    : { prefix: denied, isWildcard: false };

const packageNameRegex = (denied: string): RegExp => {
  const { prefix } = packageScope(denied);
  return new RegExp(`(?:^|['"\`/\\s])${escapeRegex(prefix)}(?:[^'"\\s@]*)?@`, 'gm');
};

const importRegex = (denied: string): RegExp => {
  const { prefix } = packageScope(denied);
  return new RegExp(
    `(?:from\\s+|require\\(\\s*)['"\`]${escapeRegex(prefix)}(?:[^'"\`]*)?['"\`]`,
    'g',
  );
};

/** Чистая функция: находит признаки runtime LLM SDK/инфраструктуры, запрещённые до Gate E. */
export const findLlmFindings = (input: LlmScanInput, policy: SecurityPolicy): Finding[] => {
  const {
    denied_packages: deniedPackages,
    denied_path_fragments: deniedFragments,
    denied_env_var_pattern: envPattern,
    allowlisted_paths: allowlistedPaths,
  } = policy.llm_policy;
  const findings: Finding[] = [];

  for (const denied of deniedPackages) {
    if (packageNameRegex(denied).test(input.lockfileContent)) {
      findings.push({
        id: 'llm-package-lockfile',
        severity: 'critical',
        package: denied,
        message: `pnpm-lock.yaml содержит запрещённый до Gate E пакет "${denied}" (ADR-006)`,
      });
    }
  }

  for (const file of input.packageJsonFiles) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(file.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    const declared = [
      ...Object.keys((manifest['dependencies'] as Record<string, unknown> | undefined) ?? {}),
      ...Object.keys((manifest['devDependencies'] as Record<string, unknown> | undefined) ?? {}),
      ...Object.keys(
        (manifest['optionalDependencies'] as Record<string, unknown> | undefined) ?? {},
      ),
      ...Object.keys((manifest['peerDependencies'] as Record<string, unknown> | undefined) ?? {}),
    ];
    for (const denied of deniedPackages) {
      const { prefix, isWildcard } = packageScope(denied);
      const matches = declared.some((name) =>
        isWildcard ? name.startsWith(prefix) : name === prefix,
      );
      if (matches) {
        findings.push({
          id: 'llm-package-manifest',
          severity: 'critical',
          path: file.path,
          package: denied,
          message: `${file.path} объявляет запрещённый до Gate E пакет "${denied}" (ADR-006)`,
        });
      }
    }
  }

  for (const file of input.sourceFiles) {
    if (matchesAnyGlob(file.path, allowlistedPaths)) continue;
    for (const denied of deniedPackages) {
      if (importRegex(denied).test(file.content)) {
        findings.push({
          id: 'llm-import',
          severity: 'critical',
          path: file.path,
          package: denied,
          message: `${file.path} импортирует запрещённый до Gate E пакет "${denied}" (ADR-006)`,
        });
      }
    }
  }

  for (const trackedPath of input.trackedPaths) {
    const segments = trackedPath.split('/');
    for (const fragment of deniedFragments) {
      if (segments.some((segment) => `${segment}/` === fragment)) {
        findings.push({
          id: 'llm-directory',
          severity: 'critical',
          path: trackedPath,
          message: `путь под запрещённым до Gate E каталогом "${fragment}" (NAR-02)`,
        });
      }
    }
  }

  const envUsageRegex = /(?:process\.env(?:\.|\[['"])([A-Z0-9_]+)|^([A-Z0-9_]{3,})\s*=)/gm;
  const envDeniedRegex = new RegExp(envPattern);
  for (const file of input.trackedFilesForEnv) {
    if (matchesAnyGlob(file.path, allowlistedPaths)) continue;
    let match: RegExpExecArray | null;
    while ((match = envUsageRegex.exec(file.content)) !== null) {
      const varName = match[1] ?? match[2] ?? '';
      if (envDeniedRegex.test(varName)) {
        findings.push({
          id: 'llm-env-var',
          severity: 'critical',
          path: file.path,
          message: `переменная окружения "${varName}" похожа на provider API key (NAR-02, ADR-006)`,
        });
      }
    }
  }

  return findings;
};

/** io: собирает вход для `findLlmFindings` из репозитория. */
const collectInput = (repoRoot: string): LlmScanInput => {
  let lockfileContent: string;
  try {
    lockfileContent = readFileSync(`${repoRoot}/pnpm-lock.yaml`, 'utf8');
  } catch {
    lockfileContent = '';
  }

  const trackedPaths = listGitTrackedFiles(repoRoot);
  const packageJsonPaths = trackedPaths.filter((path) => path.endsWith('package.json'));
  const packageJsonFiles = readTrackedFiles(repoRoot, packageJsonPaths);
  const trackedFilesForEnv = readTrackedFiles(repoRoot, trackedPaths);
  const sourceFiles = collectSourceFiles(repoRoot);

  return { lockfileContent, packageJsonFiles, sourceFiles, trackedPaths, trackedFilesForEnv };
};

/** io: полный no-llm scan репозитория. */
export const runNoLlmScan = (repoRoot: string, now: Date = new Date()): ScanOutcome => {
  const policyResult = loadPolicy(repoRoot);
  if (policyResult.kind === 'invalid')
    return { kind: 'config-error', message: policyResult.reason };

  const input = collectInput(repoRoot);
  const rawFindings = findLlmFindings(input, policyResult.policy);

  const exceptionsResult = loadExceptions(repoRoot, now);
  const { active, suppressed } = applyExceptions(rawFindings, exceptionsResult.valid, 'no-llm');
  const forcedFailures = forcedFailuresFor(exceptionsResult.errors, 'no-llm').map(
    (error): Finding => ({ id: 'invalid-exception', severity: 'high', message: error.message }),
  );

  return {
    kind: 'ok',
    report: buildReport({
      check: 'no-llm',
      active: [...active, ...forcedFailures],
      suppressed,
      policyVersion: policyResult.policy.policy_version,
      generatedAt: now,
    }),
  };
};
