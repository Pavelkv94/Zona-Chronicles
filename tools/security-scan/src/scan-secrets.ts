import { applyExceptions, forcedFailuresFor, loadExceptions } from './exceptions.ts';
import { matchesAnyGlob } from './glob.ts';
import { listGitTrackedFiles, readTrackedFiles } from './git.ts';
import { compilePattern, loadPolicy, meetsMinSeverity } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';
import type { Finding, ScanOutcome } from './report.ts';
import { buildReport } from './report.ts';

/**
 * Secret scan (OPS-03): паттерны из `secret_policy.patterns`, применённые к
 * содержимому файлов, отслеживаемых git. Чистая функция `findSecrets` не
 * трогает файловую систему/процесс — io изолирован в `runSecretsScan`.
 *
 * m7 (review finding): `secret_policy.min_blocking_severity` теперь реально
 * применяется — раньше любая активная находка валила gate независимо от severity.
 *
 * M-5 (review finding, раунд 3): `readTrackedFiles` теперь также возвращает
 * `unreadablePaths` — отслеживаемые git пути, которые не удалось прочитать.
 * Непустой `unreadablePaths` — `config-error`, а не `pass`: находки по
 * непрочитанному содержимому получить нельзя (та же форма, что B1 в
 * `scan-dependencies.ts`).
 */

export type ScannedFile = { readonly path: string; readonly content: string };

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/** Чистая функция: находит совпадения secret-паттернов в переданных файлах. */
export const findSecrets = (files: readonly ScannedFile[], policy: SecurityPolicy): Finding[] => {
  const {
    patterns,
    allowlisted_paths: allowlistedPaths,
    min_blocking_severity: minBlockingSeverity,
    non_secret_placeholders: placeholders,
  } = policy.secret_policy;
  const findings: Finding[] = [];

  for (const file of files) {
    if (matchesAnyGlob(file.path, allowlistedPaths)) continue;

    for (const pattern of patterns) {
      if (!meetsMinSeverity(pattern.severity, minBlockingSeverity)) continue;
      const regex = compilePattern(
        {
          ...pattern,
          flags: pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
        },
        placeholders,
      );
      let match: RegExpExecArray | null;
      while ((match = regex.exec(file.content)) !== null) {
        findings.push({
          id: pattern.id,
          severity: pattern.severity,
          path: file.path,
          message: `${pattern.description}: "${truncate(match[0], 40)}"`,
        });
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    }
  }
  return findings;
};

/** io: запускает secret scan над git-tracked файлами репозитория. */
export const runSecretsScan = (repoRoot: string, now: Date = new Date()): ScanOutcome => {
  const policyResult = loadPolicy(repoRoot);
  if (policyResult.kind === 'invalid') {
    return { kind: 'config-error', message: policyResult.reason };
  }

  const trackedPaths = listGitTrackedFiles(repoRoot);
  const collected = readTrackedFiles(repoRoot, trackedPaths);
  if (collected.unreadablePaths.length > 0) {
    return {
      kind: 'config-error',
      message:
        `secrets scan: не удалось прочитать ${collected.unreadablePaths.length} отслеживаемых ` +
        `файл(ов): ${collected.unreadablePaths.join(', ')} (M-5 review finding)`,
    };
  }
  const rawFindings = findSecrets(collected.files, policyResult.policy);

  const exceptionsResult = loadExceptions(repoRoot, now);
  const { active, suppressed } = applyExceptions(rawFindings, exceptionsResult.valid, 'secrets');
  const forcedFailures = forcedFailuresFor(exceptionsResult.errors, 'secrets').map(
    (error): Finding => ({ id: 'invalid-exception', severity: 'high', message: error.message }),
  );

  return {
    kind: 'ok',
    report: buildReport({
      check: 'secrets',
      active: [...active, ...forcedFailures],
      suppressed,
      policyVersion: policyResult.policy.policy_version,
      generatedAt: now,
    }),
  };
};
