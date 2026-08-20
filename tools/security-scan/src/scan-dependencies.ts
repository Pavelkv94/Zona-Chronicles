import { spawnSync } from 'node:child_process';
import { applyExceptions, forcedFailuresFor, loadExceptions } from './exceptions.ts';
import { loadPolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';
import type { Finding, ScanOutcome } from './report.ts';
import { buildReport } from './report.ts';

/**
 * Dependency scan (OPS-03): `pnpm audit --json` + `dependency_policy`.
 *
 * Fail-closed: недоступный `pnpm audit` или неожиданный формат ответа
 * заваливает проверку (`config-error`), а не пропускает её молча.
 */

export type Advisory = {
  readonly id: string;
  readonly package: string;
  readonly severity: string;
  readonly title: string;
  readonly url: string;
};

export type AuditParseResult =
  | { readonly kind: 'ok'; readonly advisories: readonly Advisory[] }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Чистая функция: разбирает `pnpm audit --json` (npm audit v1 report format). */
export const parseAuditJson = (raw: string): AuditParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'invalid',
      reason: `pnpm audit --json вернул невалидный JSON: ${String(error)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'invalid', reason: 'pnpm audit --json: ожидался объект верхнего уровня' };
  }
  const root = parsed as Record<string, unknown>;
  const advisoriesField = root['advisories'];
  if (
    typeof advisoriesField !== 'object' ||
    advisoriesField === null ||
    Array.isArray(advisoriesField)
  ) {
    return {
      kind: 'invalid',
      reason: 'pnpm audit --json: отсутствует или имеет неожиданный формат поле "advisories"',
    };
  }

  const advisories: Advisory[] = [];
  for (const [key, value] of Object.entries(advisoriesField as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      return { kind: 'invalid', reason: `pnpm audit --json: advisories["${key}"] не объект` };
    }
    const entry = value as Record<string, unknown>;
    const severity = entry['severity'];
    if (typeof severity !== 'string' || severity.length === 0) {
      return {
        kind: 'invalid',
        reason: `pnpm audit --json: advisories["${key}"] без поля severity`,
      };
    }
    const rawId = entry['id'];
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : key;
    advisories.push({
      id,
      package: typeof entry['module_name'] === 'string' ? entry['module_name'] : 'unknown',
      severity,
      title: typeof entry['title'] === 'string' ? entry['title'] : '',
      url: typeof entry['url'] === 'string' ? entry['url'] : '',
    });
  }
  return { kind: 'ok', advisories };
};

/** Чистая функция: применяет `dependency_policy` к списку advisories. */
export const applyDependencyPolicy = (
  advisories: readonly Advisory[],
  policy: SecurityPolicy,
): Finding[] => {
  const {
    severity_order: severityOrder,
    min_blocking_severity: minBlocking,
    unknown_severity_behavior: unknownBehavior,
  } = policy.dependency_policy;
  const minIndex = severityOrder.indexOf(minBlocking);

  const findings: Finding[] = [];
  for (const advisory of advisories) {
    const index = severityOrder.indexOf(advisory.severity.toLowerCase());
    const isUnknownSeverity = index === -1;
    const blocks = isUnknownSeverity
      ? unknownBehavior === 'block'
      : minIndex !== -1 && index >= minIndex;
    if (!blocks) continue;

    findings.push({
      id: advisory.id,
      severity: advisory.severity,
      package: advisory.package,
      message: isUnknownSeverity
        ? `неизвестная severity "${advisory.severity}" (unknown_severity_behavior=block): ${advisory.title}`
        : `${advisory.title} (${advisory.url})`,
    });
  }
  return findings;
};

/** io: запускает `pnpm audit --json` и возвращает stdout независимо от кода возврата процесса. */
const runPnpmAudit = (
  repoRoot: string,
):
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: string } => {
  const result = spawnSync('pnpm', ['audit', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) {
    return {
      ok: false,
      reason: `не удалось запустить "pnpm audit --json": ${String(result.error)}`,
    };
  }
  if (result.stdout === undefined || result.stdout.length === 0) {
    return {
      ok: false,
      reason: `"pnpm audit --json" не вернул вывод (status=${String(result.status)}, stderr="${result.stderr}")`,
    };
  }
  return { ok: true, stdout: result.stdout };
};

/** io: полный dependency scan репозитория. */
export const runDependenciesScan = (repoRoot: string, now: Date = new Date()): ScanOutcome => {
  const policyResult = loadPolicy(repoRoot);
  if (policyResult.kind === 'invalid')
    return { kind: 'config-error', message: policyResult.reason };

  const auditRun = runPnpmAudit(repoRoot);
  if (!auditRun.ok) return { kind: 'config-error', message: auditRun.reason };

  const parsed = parseAuditJson(auditRun.stdout);
  if (parsed.kind === 'invalid') return { kind: 'config-error', message: parsed.reason };

  const rawFindings = applyDependencyPolicy(parsed.advisories, policyResult.policy);

  const exceptionsResult = loadExceptions(repoRoot, now);
  const { active, suppressed } = applyExceptions(
    rawFindings,
    exceptionsResult.valid,
    'dependencies',
  );
  const forcedFailures = forcedFailuresFor(exceptionsResult.errors, 'dependencies').map(
    (error): Finding => ({ id: 'invalid-exception', severity: 'high', message: error.message }),
  );

  return {
    kind: 'ok',
    report: buildReport({
      check: 'dependencies',
      active: [...active, ...forcedFailures],
      suppressed,
      policyVersion: policyResult.policy.policy_version,
      generatedAt: now,
    }),
  };
};
