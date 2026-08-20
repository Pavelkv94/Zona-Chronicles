import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AUDIT_LIVENESS_FIXTURE_LOCKFILE,
  AUDIT_LIVENESS_FIXTURE_PACKAGE_JSON,
} from './audit-liveness-probe.ts';
import { applyExceptions, forcedFailuresFor, loadExceptions } from './exceptions.ts';
import { loadPolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';
import type { Finding, ScanOutcome } from './report.ts';
import { buildReport } from './report.ts';

/**
 * Dependency scan (OPS-03): `pnpm audit --json` + `dependency_policy`.
 *
 * Fail-closed, включая B1 (review finding): `pnpm audit --json` возвращает
 * `{"advisories": {}, "metadata": {...}}` — валидный, хорошо сформированный JSON —
 * КАК для честно чистого репозитория, ТАК и когда registry недоступен/вернул
 * пустую заглушку. По форме ответа эти два случая неотличимы. Поэтому пустой
 * набор advisories не принимается на веру: сначала подтверждается живость audit
 * endpoint пробой через `runLivenessProbe` (см. `audit-liveness-probe.ts`
 * за подробным описанием механизма и его границ). Пустые advisories без
 * подтверждённой живости — `config-error` (exit 2), а не `pass`.
 */

export type Advisory = {
  readonly id: string;
  readonly package: string;
  readonly severity: string;
  readonly title: string;
  readonly url: string;
  /**
   * minor2: установленные версии, к которым относится этот advisory
   * (`findings[].version` из npm-audit-v1, deduped). Пусто, если формат ответа
   * их не содержит — тогда экземпляр однозначно определяется только advisory id.
   */
  readonly installedVersions?: readonly string[];
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
    const rawFindings = entry['findings'];
    const installedVersions: string[] = [];
    if (Array.isArray(rawFindings)) {
      for (const item of rawFindings) {
        if (typeof item !== 'object' || item === null) continue;
        const version = (item as Record<string, unknown>)['version'];
        if (
          typeof version === 'string' &&
          version.length > 0 &&
          !installedVersions.includes(version)
        ) {
          installedVersions.push(version);
        }
      }
    }
    advisories.push({
      id,
      package: typeof entry['module_name'] === 'string' ? entry['module_name'] : 'unknown',
      severity,
      title: typeof entry['title'] === 'string' ? entry['title'] : '',
      url: typeof entry['url'] === 'string' ? entry['url'] : '',
      installedVersions,
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

    // minor2: если ровно одна установленная версия известна, находка адресует
    // её однозначно (`package@version`) — это позволяет exceptions.json
    // ссылаться на конкретный экземпляр, а не на пакет целиком (см. exceptions.ts).
    // Ноль или несколько версий — версия неоднозначна, находка остаётся с
    // голым именем пакета; такой advisory всё ещё можно погасить по advisory id.
    const installedVersions = advisory.installedVersions ?? [];
    const packageIdentifier =
      installedVersions.length === 1
        ? `${advisory.package}@${installedVersions[0]}`
        : advisory.package;

    findings.push({
      id: advisory.id,
      severity: advisory.severity,
      package: packageIdentifier,
      message: isUnknownSeverity
        ? `неизвестная severity "${advisory.severity}" (unknown_severity_behavior=block): ${advisory.title}`
        : `${advisory.title} (${advisory.url})`,
    });
  }
  return findings;
};

/** Максимальное время ожидания одного `pnpm audit --json` (io): не даёт CI зависнуть на blackhole-registry. */
const AUDIT_TIMEOUT_MS = 120_000;

/**
 * `npm_config_registry` — стандартное npm-совместимое env-переопределение registry.
 * Форвардим его явным `--registry` флагом вместо того, чтобы полагаться на то,
 * унаследует ли конкретная версия pnpm/corepack переменную окружения сама:
 * поведение по этому вопросу оказалось версии-специфичным при ручной проверке
 * (см. отчёт по B1), а явный флаг детерминированно управляет registry везде.
 */
const registryOverrideArgs = (): readonly string[] => {
  const override = process.env['npm_config_registry'];
  return override !== undefined && override.length > 0 ? ['--registry', override] : [];
};

export type SpawnAuditResult =
  { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string };

/**
 * io: запускает `pnpm audit --json` в заданной директории и возвращает stdout.
 *
 * npm-audit-совместимый контракт статус-кода: `0` — чисто, `1` — advisories
 * найдены (ОЖИДАЕМЫЙ, не ошибочный исход — форма ответа парсится ниже как
 * обычно). Любой другой статус (включая `null` при таймауте/сигнале) —
 * подтверждённый отказ подпроцесса (m7/m8 review finding: раньше статус
 * игнорировался полностью).
 */
const spawnPnpmAudit = (cwd: string): SpawnAuditResult => {
  const result = spawnSync('pnpm', ['audit', '--json', ...registryOverrideArgs()], {
    cwd,
    encoding: 'utf8',
    timeout: AUDIT_TIMEOUT_MS,
  });
  if (result.error) {
    return {
      ok: false,
      reason: `не удалось запустить "pnpm audit --json": ${String(result.error)}`,
    };
  }
  if (result.status !== 0 && result.status !== 1) {
    return {
      ok: false,
      reason: `"pnpm audit --json" завершился неожиданным статусом ${String(result.status)} (ожидался 0=чисто или 1=advisories найдены; signal=${String(result.signal)}, stderr="${result.stderr}")`,
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

/** io: запускает `pnpm audit --json` для реального репозитория. */
const runPnpmAudit = (repoRoot: string): SpawnAuditResult => spawnPnpmAudit(repoRoot);

export type LivenessProbeOutcome =
  | { readonly kind: 'live'; readonly fixtureAdvisoryCount: number }
  | { readonly kind: 'unconfirmed'; readonly reason: string };

/**
 * Чистая функция (B1): решает, подтверждает ли ответ фикстурной пробы живость
 * audit endpoint. Известно заведомо уязвимый пакет (`minimatch@3.0.4`) обязан
 * вернуть >0 advisories; ноль — endpoint не подтверждён (см. границы в
 * `audit-liveness-probe.ts`).
 */
export const evaluateLivenessProbe = (parsed: AuditParseResult): LivenessProbeOutcome => {
  if (parsed.kind === 'invalid') {
    return {
      kind: 'unconfirmed',
      reason: `liveness-фикстура вернула невалидный ответ: ${parsed.reason}`,
    };
  }
  if (parsed.advisories.length === 0) {
    return {
      kind: 'unconfirmed',
      reason:
        'liveness-фикстура (minimatch@3.0.4, заведомо содержит известные historical advisories) ' +
        'вернула 0 advisories — audit endpoint не подтверждён рабочим',
    };
  }
  return { kind: 'live', fixtureAdvisoryCount: parsed.advisories.length };
};

/**
 * io: пишет фикстуру во временный каталог ВНЕ дерева репозитория и прогоняет через
 * неё `pnpm audit --json`. Каталог обязан быть вне репозитория: если разместить
 * фикстуру внутри дерева с `pnpm-workspace.yaml`, pnpm поднимется до корневого
 * workspace и проаудирует весь монорепозиторий вместо изолированной фикстуры
 * (проверено вручную — см. отчёт по B1). `os.tmpdir()` не имеет родительского
 * `pnpm-workspace.yaml`, поэтому pnpm трактует фикстуру как отдельный проект.
 */
const runLivenessProbe = (): AuditParseResult => {
  const dir = mkdtempSync(join(tmpdir(), 'zona-audit-liveness-'));
  try {
    writeFileSync(join(dir, 'package.json'), AUDIT_LIVENESS_FIXTURE_PACKAGE_JSON, 'utf8');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), AUDIT_LIVENESS_FIXTURE_LOCKFILE, 'utf8');
    const audit = spawnPnpmAudit(dir);
    if (!audit.ok) return { kind: 'invalid', reason: `liveness-проба: ${audit.reason}` };
    return parseAuditJson(audit.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** io: `pnpm config get registry` — только для diagnostics в отчёте, никогда не валит скан. */
const resolveRegistryEndpoint = (repoRoot: string): string => {
  const override = process.env['npm_config_registry'];
  if (override !== undefined && override.length > 0) return override;
  const result = spawnSync('pnpm', ['config', 'get', 'registry'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error || result.status !== 0 || result.stdout === undefined) {
    return 'unknown (pnpm config get registry failed)';
  }
  return result.stdout.trim();
};

/**
 * N4 (review finding): io-зависимости `runDependenciesScan`, вынесенные за интерфейс,
 * чтобы проводку "пустые advisories → обязательная проба → config-error" можно было
 * протестировать напрямую (тест на саму функцию, а не только на чистую
 * `evaluateLivenessProbe`) без сети/подпроцессов. Продакшн вызывает с
 * `DEFAULT_DEPENDENCIES_SCAN_IO` (реальные `pnpm audit`/liveness-проба); тесты
 * подставляют детерминированные фейки.
 */
export type DependenciesScanIo = {
  readonly runAudit: (repoRoot: string) => SpawnAuditResult;
  readonly runLivenessProbe: () => AuditParseResult;
  readonly resolveRegistryEndpoint: (repoRoot: string) => string;
};

export const DEFAULT_DEPENDENCIES_SCAN_IO: DependenciesScanIo = {
  runAudit: runPnpmAudit,
  runLivenessProbe,
  resolveRegistryEndpoint,
};

/** io: полный dependency scan репозитория. */
export const runDependenciesScan = (
  repoRoot: string,
  now: Date = new Date(),
  io: DependenciesScanIo = DEFAULT_DEPENDENCIES_SCAN_IO,
): ScanOutcome => {
  const policyResult = loadPolicy(repoRoot);
  if (policyResult.kind === 'invalid')
    return { kind: 'config-error', message: policyResult.reason };

  const auditRun = io.runAudit(repoRoot);
  if (!auditRun.ok) return { kind: 'config-error', message: auditRun.reason };

  const parsed = parseAuditJson(auditRun.stdout);
  if (parsed.kind === 'invalid') return { kind: 'config-error', message: parsed.reason };

  const registryEndpoint = io.resolveRegistryEndpoint(repoRoot);

  let liveness: Record<string, unknown>;
  if (parsed.advisories.length > 0) {
    // Реальные advisories уже доказывают, что endpoint отвечает реальными данными:
    // проба избыточна (см. B1 требование "перед тем как доверять ПУСТОМУ набору").
    liveness = {
      probe: 'skipped',
      reason: 'real advisories present, endpoint already proven live',
    };
  } else {
    const probeResult = evaluateLivenessProbe(io.runLivenessProbe());
    if (probeResult.kind === 'unconfirmed') {
      return {
        kind: 'config-error',
        message:
          `dependency scan: пустой набор advisories не подтверждён живостью audit endpoint ` +
          `(registry=${registryEndpoint}): ${probeResult.reason}`,
      };
    }
    liveness = { probe: 'live', fixture_advisory_count: probeResult.fixtureAdvisoryCount };
  }

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
      meta: {
        registry_endpoint: registryEndpoint,
        audit_report_format: 'npm-audit-v1 (top-level "advisories"/"metadata" keys)',
        liveness,
      },
    }),
  };
};
