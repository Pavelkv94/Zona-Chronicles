#!/usr/bin/env node
/**
 * Entry point: license scan (OPS-03). Логика — `tools/security-scan/src/scan-licenses.ts`.
 * Скелет уровня I00 (ACCEPTANCE A10); release gate — I17.
 */
import { runLicensesScan } from '../../tools/security-scan/src/scan-licenses.ts';
import {
  exitCodeForOutcome,
  printOutcomeSummary,
  writeOutcomeReport,
} from '../../tools/security-scan/src/report.ts';

const outcome = runLicensesScan(process.cwd());
writeOutcomeReport(outcome, 'licenses', process.cwd());
printOutcomeSummary(outcome);
process.exit(exitCodeForOutcome(outcome));
