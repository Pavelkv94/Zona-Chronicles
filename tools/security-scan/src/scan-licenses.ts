import { spawnSync } from 'node:child_process';
import { applyExceptions, forcedFailuresFor, loadExceptions } from './exceptions.ts';
import { loadPolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';
import type { Finding, ScanOutcome } from './report.ts';
import { buildReport } from './report.ts';

/**
 * License scan (OPS-03): `pnpm licenses list --json` + `license_policy`.
 *
 * Fail-closed: недоступный `pnpm licenses` или неожиданный формат ответа
 * заваливает проверку. Неизвестная (не allowed и не denied) лицензия — это
 * `review_required`, что тоже даёт non-zero: молчаливого "проходит" не бывает.
 */

export type LicensedPackage = {
  readonly name: string;
  readonly version: string;
  readonly license: string;
};

export type LicensesParseResult =
  | { readonly kind: 'ok'; readonly packages: readonly LicensedPackage[] }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Чистая функция: разбирает `pnpm licenses list --json` (группировка по лицензии). */
export const parseLicensesJson = (raw: string): LicensesParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'invalid',
      reason: `pnpm licenses list --json вернул невалидный JSON: ${String(error)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      kind: 'invalid',
      reason: 'pnpm licenses list --json: ожидался объект, сгруппированный по лицензии',
    };
  }

  const packages: LicensedPackage[] = [];
  for (const [licenseKey, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      return {
        kind: 'invalid',
        reason: `pnpm licenses list --json: группа "${licenseKey}" не массив`,
      };
    }
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) {
        return {
          kind: 'invalid',
          reason: `pnpm licenses list --json: запись в группе "${licenseKey}" не объект`,
        };
      }
      const record = entry as Record<string, unknown>;
      const name = record['name'];
      const versions = record['versions'];
      if (typeof name !== 'string' || name.length === 0) {
        return {
          kind: 'invalid',
          reason: `pnpm licenses list --json: запись без поля name (лицензия "${licenseKey}")`,
        };
      }
      const version =
        Array.isArray(versions) && typeof versions[0] === 'string' ? versions[0] : 'unknown';
      const license = typeof record['license'] === 'string' ? record['license'] : licenseKey;
      packages.push({ name, version, license });
    }
  }
  return { kind: 'ok', packages };
};

/** Чистая функция: применяет `license_policy` к списку пакетов. */
export const applyLicensePolicy = (
  packages: readonly LicensedPackage[],
  policy: SecurityPolicy,
): Finding[] => {
  const { allowed, denied, unknown_license_behavior: unknownBehavior } = policy.license_policy;
  const findings: Finding[] = [];

  for (const pkg of packages) {
    if (allowed.includes(pkg.license)) continue;

    const packageId = `${pkg.name}@${pkg.version}`;
    if (denied.includes(pkg.license)) {
      findings.push({
        id: pkg.license,
        severity: 'high',
        package: packageId,
        message: `лицензия "${pkg.license}" запрещена license_policy.denied`,
      });
      continue;
    }

    if (unknownBehavior === 'review_required') {
      findings.push({
        id: pkg.license,
        severity: 'moderate',
        package: packageId,
        message: `лицензия "${pkg.license}" не в allowed и не в denied: review_required`,
      });
    }
  }
  return findings;
};

/** io: запускает `pnpm licenses list --json`. */
const runPnpmLicenses = (
  repoRoot: string,
):
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: string } => {
  const result = spawnSync('pnpm', ['licenses', 'list', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) {
    return {
      ok: false,
      reason: `не удалось запустить "pnpm licenses list --json": ${String(result.error)}`,
    };
  }
  if (result.stdout === undefined || result.stdout.length === 0) {
    return {
      ok: false,
      reason: `"pnpm licenses list --json" не вернул вывод (status=${String(result.status)}, stderr="${result.stderr}")`,
    };
  }
  return { ok: true, stdout: result.stdout };
};

/** io: полный license scan репозитория. */
export const runLicensesScan = (repoRoot: string, now: Date = new Date()): ScanOutcome => {
  const policyResult = loadPolicy(repoRoot);
  if (policyResult.kind === 'invalid')
    return { kind: 'config-error', message: policyResult.reason };

  const licensesRun = runPnpmLicenses(repoRoot);
  if (!licensesRun.ok) return { kind: 'config-error', message: licensesRun.reason };

  const parsed = parseLicensesJson(licensesRun.stdout);
  if (parsed.kind === 'invalid') return { kind: 'config-error', message: parsed.reason };

  const rawFindings = applyLicensePolicy(parsed.packages, policyResult.policy);

  const exceptionsResult = loadExceptions(repoRoot, now);
  const { active, suppressed } = applyExceptions(rawFindings, exceptionsResult.valid, 'licenses');
  const forcedFailures = forcedFailuresFor(exceptionsResult.errors, 'licenses').map(
    (error): Finding => ({ id: 'invalid-exception', severity: 'high', message: error.message }),
  );

  return {
    kind: 'ok',
    report: buildReport({
      check: 'licenses',
      active: [...active, ...forcedFailures],
      suppressed,
      policyVersion: policyResult.policy.policy_version,
      generatedAt: now,
    }),
  };
};
