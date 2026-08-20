import { applyExceptions, forcedFailuresFor, loadExceptions } from './exceptions.ts';
import { matchesAnyGlob } from './glob.ts';
import { compilePattern, loadPolicy, meetsMinSeverity } from './policy.ts';
import { collectSourceFiles } from './source-files.ts';
import type { SecurityPolicy } from './policy.ts';
import type { Finding, ScanOutcome } from './report.ts';
import { buildReport } from './report.ts';

/**
 * Static scan (OPS-03) — ЧЕСТНЫЙ СКЕЛЕТ, а не полноценный SAST.
 *
 * Это текстовый regex-скан по `static_policy.forbidden_constructs` над
 * `apps/**`, `packages/**`, `tools/**`. Он не строит AST, не понимает область
 * видимости и не отслеживает поток данных — не заменяет полноценный SAST
 * (см. §12 `03_TECHNICAL_DESIGN.md`), который приходит в I17.
 *
 * m7 (review finding): `static_policy.min_blocking_severity` теперь реально
 * применяется — раньше `low` (например `hardcoded-network-url`) блокировал gate
 * так же жёстко, как `critical`.
 */

export type ScannedFile = { readonly path: string; readonly content: string };

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/** Чистая функция: находит совпадения `static_policy.forbidden_constructs`. */
export const findStaticFindings = (
  files: readonly ScannedFile[],
  policy: SecurityPolicy,
): Finding[] => {
  const {
    forbidden_constructs: constructs,
    allowlisted_paths: allowlistedPaths,
    min_blocking_severity: minBlockingSeverity,
  } = policy.static_policy;
  const findings: Finding[] = [];

  for (const file of files) {
    if (matchesAnyGlob(file.path, allowlistedPaths)) continue;

    for (const construct of constructs) {
      if (!meetsMinSeverity(construct.severity, minBlockingSeverity)) continue;
      const regex = compilePattern({
        ...construct,
        flags: construct.flags.includes('g') ? construct.flags : `${construct.flags}g`,
      });
      let match: RegExpExecArray | null;
      while ((match = regex.exec(file.content)) !== null) {
        findings.push({
          id: construct.id,
          severity: construct.severity,
          path: file.path,
          message: `${construct.description}: "${truncate(match[0], 60)}"`,
        });
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    }
  }
  return findings;
};

/** io: полный static scan репозитория. */
export const runStaticScan = (repoRoot: string, now: Date = new Date()): ScanOutcome => {
  const policyResult = loadPolicy(repoRoot);
  if (policyResult.kind === 'invalid')
    return { kind: 'config-error', message: policyResult.reason };

  const files = collectSourceFiles(repoRoot);
  const rawFindings = findStaticFindings(files, policyResult.policy);

  const exceptionsResult = loadExceptions(repoRoot, now);
  const { active, suppressed } = applyExceptions(rawFindings, exceptionsResult.valid, 'static');
  const forcedFailures = forcedFailuresFor(exceptionsResult.errors, 'static').map(
    (error): Finding => ({ id: 'invalid-exception', severity: 'high', message: error.message }),
  );

  return {
    kind: 'ok',
    report: buildReport({
      check: 'static',
      active: [...active, ...forcedFailures],
      suppressed,
      policyVersion: policyResult.policy.policy_version,
      generatedAt: now,
    }),
  };
};
