import { mkdirSync, writeFileSync } from 'node:fs';
import type { CheckName } from './exceptions.ts';

/**
 * Общий machine-readable формат результата security-проверки (I00-T05).
 *
 * Каждая точка входа (`scripts/security/scan-*.ts`) пишет ровно один такой отчёт
 * в `reports/security/<check>.json` (каталог уже в `.gitignore`) и печатает краткую
 * сводку в stdout. Код возврата: 0 — pass, 1 — fail, 2 — ошибка конфигурации/инструмента.
 */

export type Finding = {
  readonly id: string;
  readonly severity: string;
  readonly path?: string;
  readonly package?: string;
  readonly message: string;
};

export type ReportStatus = 'pass' | 'fail';

export type Report = {
  readonly check: CheckName;
  readonly status: ReportStatus;
  readonly findings: readonly Finding[];
  readonly suppressed: readonly Finding[];
  readonly policy_version: string;
  readonly generated_at: string;
  /** Проверка-специфичные диагностические метаданные (например B1: registry endpoint/audit report format/liveness probe для `dependencies`). Необязательно — не все проверки его заполняют. */
  readonly meta?: Readonly<Record<string, unknown>>;
};

export type BuildReportInput = {
  readonly check: CheckName;
  readonly active: readonly Finding[];
  readonly suppressed: readonly Finding[];
  readonly policyVersion: string;
  readonly generatedAt: Date;
  readonly meta?: Readonly<Record<string, unknown>>;
};

/** Чистая функция: собирает Report из активных/подавленных находок. */
export const buildReport = (input: BuildReportInput): Report => ({
  check: input.check,
  status: input.active.length === 0 ? 'pass' : 'fail',
  findings: input.active,
  suppressed: input.suppressed,
  policy_version: input.policyVersion,
  generated_at: input.generatedAt.toISOString(),
  ...(input.meta !== undefined ? { meta: input.meta } : {}),
});

export type ScanOutcome =
  | { readonly kind: 'ok'; readonly report: Report }
  | { readonly kind: 'config-error'; readonly message: string };

/** Чистая функция: код возврата по итогу проверки (0 pass / 1 fail / 2 config error). */
export const exitCodeForOutcome = (outcome: ScanOutcome): 0 | 1 | 2 => {
  if (outcome.kind === 'config-error') return 2;
  return outcome.report.status === 'pass' ? 0 : 1;
};

/** io: пишет отчёт в `reports/security/<check>.json`. */
export const writeReportFile = (report: Report, repoRoot: string): void => {
  const dir = `${repoRoot}/reports/security`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${report.check}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
};

/** io: печатает краткую сводку в stdout/stderr и, при config-error, пишет причину. */
export const printOutcomeSummary = (outcome: ScanOutcome): void => {
  if (outcome.kind === 'config-error') {
    process.stderr.write(`security check configuration error: ${outcome.message}\n`);
    return;
  }
  const { report } = outcome;
  const line = `security:${report.check}: ${report.status} (findings=${report.findings.length}, suppressed=${report.suppressed.length}, policy_version=${report.policy_version})`;
  if (report.status === 'pass') {
    process.stdout.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
  for (const finding of report.findings) {
    const location = finding.path ?? finding.package ?? finding.id;
    process.stdout.write(`  - [${finding.severity}] ${location}: ${finding.message}\n`);
  }
};
