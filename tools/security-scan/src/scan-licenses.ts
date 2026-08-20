import { spawnSync } from 'node:child_process';
import { applyExceptions, forcedFailuresFor, loadExceptions } from './exceptions.ts';
import { meetsMinSeverity, loadPolicy } from './policy.ts';
import type { LicensePolicy, SecurityPolicy } from './policy.ts';
import type { Finding, ScanOutcome } from './report.ts';
import { buildReport } from './report.ts';

/**
 * License scan (OPS-03): `pnpm licenses list --json` + `license_policy`.
 *
 * M2/M3 (review findings): один allowlist на весь граф судил build-time-only
 * инструменты так же строго, как поставляемый код, и требовал платформозависимых
 * per-package исключений (`lightningcss-<platform>` — 11 вариантов в lockfile,
 * на CI-хосте установится другой, gate станет красным на первом прогоне). Теперь
 * граф явно делится по границе дистрибуции:
 *
 * - `pnpm licenses list --json --prod` — production-граф (то, что реально
 *   поставляется). Судится строгим `license_policy.production.allowed`.
 * - `pnpm licenses list --json` (без `--prod`) — полный граф. Разница
 *   full-минус-production — dev-only пакеты; они дополнительно допускают
 *   `license_policy.development.allowed` (file-level weak copyleft вроде
 *   MPL-2.0/EPL-2.0 — см. `security/policy.json` license_policy.development.rationale).
 * - `--prod` фактически проверен вручную (не только по документации): на этом
 *   репозитории `--prod` вернул 63 пакета из 370 и не включал `lightningcss`
 *   (транзитивный dev-инструмент из vite/vitest) — граф действительно уже поделён
 *   pnpm по production/dev, наш код лишь применяет к каждой части свой allowlist.
 * - `denied` общий и строгий для обоих графов — не ослабляется split-ом.
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
      // N5 (review finding): `pnpm licenses list --json` группирует по пакету, но
      // одна запись может нести НЕСКОЛЬКО установленных версий одновременно
      // (`versions: [...]`, например когда и production-, и dev-зависимость тянут
      // разные версии одного пакета). Раньше бралась только `versions[0]`, из-за
      // чего (а) production-версия могла получить версионный "ключ" полного
      // графа не той версии, что реально стоит в production, и по ключу
      // `name@version` попасть в dev-only ведро с мягким allowlist, и (б) любая
      // версия начиная со второй молча выпадала из проверки вообще (в этом
      // репозитории — не менее 30 версий сразу в нескольких пакетах: `ajv`,
      // `json-schema-traverse`, `process-warning`, `real-require`, `fast-uri` и
      // 27 других записей полного графа). Fail-closed: `versions` обязано быть
      // непустым массивом строк — молчаливого fallback на "unknown" больше нет,
      // и КАЖДАЯ версия становится отдельным `LicensedPackage`.
      if (
        !Array.isArray(versions) ||
        versions.length === 0 ||
        !versions.every((version) => typeof version === 'string' && version.length > 0)
      ) {
        return {
          kind: 'invalid',
          reason:
            `pnpm licenses list --json: запись "${name}" (лицензия "${licenseKey}") имеет ` +
            `некорректное поле versions — ожидался непустой массив строк`,
        };
      }
      const license = typeof record['license'] === 'string' ? record['license'] : licenseKey;
      for (const version of versions) {
        packages.push({ name, version, license });
      }
    }
  }
  return { kind: 'ok', packages };
};

const packageKey = (pkg: LicensedPackage): string => `${pkg.name}@${pkg.version}`;

export type LicenseGraphs = {
  readonly production: readonly LicensedPackage[];
  readonly full: readonly LicensedPackage[];
};

export type PartitionedGraphs = {
  readonly productionPackages: readonly LicensedPackage[];
  readonly devOnlyPackages: readonly LicensedPackage[];
};

/**
 * Чистая функция: dev-only = пакеты полного графа, отсутствующие в production-графе
 * (по `name@version`). Это единственное место, где вычисляется граница дистрибуции.
 */
export const partitionGraphs = (graphs: LicenseGraphs): PartitionedGraphs => {
  const productionKeys = new Set(graphs.production.map(packageKey));
  const devOnlyPackages = graphs.full.filter((pkg) => !productionKeys.has(packageKey(pkg)));
  return { productionPackages: graphs.production, devOnlyPackages };
};

/**
 * Чистая функция (M2/M3 требование #3): dev-only-allowlisted лицензии, которые
 * НЕ входят в production.allowed. Это "исполняемое утверждение", а не проза —
 * `classifyLicense` использует его, чтобы дать специфичное сообщение, если такая
 * лицензия обнаружится в production-графе (что означало бы, что build-time-only
 * зависимость перестала быть build-time-only).
 */
const devOnlyLeakSet = (policy: LicensePolicy): ReadonlySet<string> =>
  new Set(
    policy.development.allowed.filter((license) => !policy.production.allowed.includes(license)),
  );

export type LicenseClassification = 'ok' | 'denied' | 'dev-only-leak' | 'review-required';

/** Чистая функция: классифицирует одну лицензию одного графа. */
export const classifyLicense = (
  license: string,
  graph: 'production' | 'development',
  policy: LicensePolicy,
): LicenseClassification => {
  if (policy.denied.includes(license)) return 'denied';

  const leakSet = devOnlyLeakSet(policy);
  if (graph === 'production' && leakSet.has(license)) return 'dev-only-leak';

  const effectiveAllowed =
    graph === 'production'
      ? policy.production.allowed
      : [...policy.production.allowed, ...policy.development.allowed];
  if (effectiveAllowed.includes(license)) return 'ok';

  return policy.unknown_license_behavior === 'review_required' ? 'review-required' : 'ok';
};

const findingFor = (
  pkg: LicensedPackage,
  classification: Exclude<LicenseClassification, 'ok'>,
): Finding => {
  const packageId = packageKey(pkg);
  const severity =
    classification === 'denied'
      ? 'high'
      : classification === 'dev-only-leak'
        ? 'critical'
        : 'moderate';
  const message =
    classification === 'denied'
      ? `лицензия "${pkg.license}" запрещена license_policy.denied`
      : classification === 'dev-only-leak'
        ? `лицензия "${pkg.license}" разрешена только для development-графа (license_policy.development), но пакет "${packageId}" присутствует в production-графе — build-time-only допущение больше не выполняется`
        : `лицензия "${pkg.license}" не в production/development allowed и не в denied: review_required`;
  return { id: pkg.license, severity, package: packageId, message };
};

/** Чистая функция: применяет `license_policy` к обоим графам (min_blocking_severity — m7). */
export const applyLicensePolicy = (
  graphs: PartitionedGraphs,
  policy: SecurityPolicy,
): Finding[] => {
  const licensePolicy = policy.license_policy;
  const findings: Finding[] = [];

  for (const pkg of graphs.productionPackages) {
    const classification = classifyLicense(pkg.license, 'production', licensePolicy);
    if (classification === 'ok') continue;
    findings.push(findingFor(pkg, classification));
  }
  for (const pkg of graphs.devOnlyPackages) {
    const classification = classifyLicense(pkg.license, 'development', licensePolicy);
    if (classification === 'ok') continue;
    findings.push(findingFor(pkg, classification));
  }

  return findings.filter((finding) =>
    meetsMinSeverity(finding.severity, licensePolicy.min_blocking_severity),
  );
};

/** Максимальное время ожидания `pnpm licenses list --json` (io): не даёт CI зависнуть. */
const LICENSES_TIMEOUT_MS = 60_000;

type SpawnLicensesResult =
  { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string };

/**
 * io: запускает `pnpm licenses list --json [--prod]`.
 *
 * В отличие от `pnpm audit` у `pnpm licenses list` нет легитимного "найдены
 * нарушения" ненулевого статуса — это просто листинг. Любой ненулевой статус
 * (или `null` при таймауте/сигнале) — отказ инструмента (m8 review finding:
 * раньше статус полностью игнорировался).
 */
const spawnPnpmLicenses = (repoRoot: string, extraArgs: readonly string[]): SpawnLicensesResult => {
  const result = spawnSync('pnpm', ['licenses', 'list', '--json', ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: LICENSES_TIMEOUT_MS,
  });
  if (result.error) {
    return {
      ok: false,
      reason: `не удалось запустить "pnpm licenses list --json ${extraArgs.join(' ')}": ${String(result.error)}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `"pnpm licenses list --json ${extraArgs.join(' ')}" завершился статусом ${String(result.status)} (signal=${String(result.signal)}, stderr="${result.stderr}")`,
    };
  }
  if (result.stdout === undefined || result.stdout.length === 0) {
    return {
      ok: false,
      reason: `"pnpm licenses list --json ${extraArgs.join(' ')}" не вернул вывод (stderr="${result.stderr}")`,
    };
  }
  return { ok: true, stdout: result.stdout };
};

/** io: полный license scan репозитория — оба графа, классификация, исключения, отчёт. */
export const runLicensesScan = (repoRoot: string, now: Date = new Date()): ScanOutcome => {
  const policyResult = loadPolicy(repoRoot);
  if (policyResult.kind === 'invalid')
    return { kind: 'config-error', message: policyResult.reason };

  const fullRun = spawnPnpmLicenses(repoRoot, []);
  if (!fullRun.ok) return { kind: 'config-error', message: fullRun.reason };
  const fullParsed = parseLicensesJson(fullRun.stdout);
  if (fullParsed.kind === 'invalid') return { kind: 'config-error', message: fullParsed.reason };

  const prodRun = spawnPnpmLicenses(repoRoot, ['--prod']);
  if (!prodRun.ok) return { kind: 'config-error', message: prodRun.reason };
  const prodParsed = parseLicensesJson(prodRun.stdout);
  if (prodParsed.kind === 'invalid') return { kind: 'config-error', message: prodParsed.reason };

  const graphs = partitionGraphs({ production: prodParsed.packages, full: fullParsed.packages });
  const rawFindings = applyLicensePolicy(graphs, policyResult.policy);

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
      meta: {
        production_package_count: graphs.productionPackages.length,
        dev_only_package_count: graphs.devOnlyPackages.length,
      },
    }),
  };
};
