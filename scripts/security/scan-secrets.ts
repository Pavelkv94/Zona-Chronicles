#!/usr/bin/env node
/**
 * Entry point: secret scan (OPS-03). Логика — `tools/security-scan/src/scan-secrets.ts`.
 * Скелет уровня I00 (ACCEPTANCE A10); release gate — I17.
 */
import { runSecretsScan } from '../../tools/security-scan/src/scan-secrets.ts';
import {
  exitCodeForOutcome,
  printOutcomeSummary,
  writeReportFile,
} from '../../tools/security-scan/src/report.ts';

const outcome = runSecretsScan(process.cwd());
if (outcome.kind === 'ok') writeReportFile(outcome.report, process.cwd());
printOutcomeSummary(outcome);
process.exit(exitCodeForOutcome(outcome));
