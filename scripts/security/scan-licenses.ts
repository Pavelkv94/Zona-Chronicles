#!/usr/bin/env node
/**
 * Entry point: license scan (OPS-03). Логика — `tools/security-scan/src/scan-licenses.ts`.
 * Скелет уровня I00 (ACCEPTANCE A10); release gate — I17.
 */
import { runLicensesScan } from '../../tools/security-scan/src/scan-licenses.ts';
import {
  exitCodeForOutcome,
  printOutcomeSummary,
  writeReportFile,
} from '../../tools/security-scan/src/report.ts';

const outcome = runLicensesScan(process.cwd());
if (outcome.kind === 'ok') writeReportFile(outcome.report, process.cwd());
printOutcomeSummary(outcome);
process.exit(exitCodeForOutcome(outcome));
