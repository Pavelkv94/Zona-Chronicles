#!/usr/bin/env node
/**
 * Entry point: secret scan (OPS-03). Логика — `tools/security-scan/src/scan-secrets.ts`.
 * Скелет уровня I00 (ACCEPTANCE A10); release gate — I17.
 */
import { runSecretsScan } from '../../tools/security-scan/src/scan-secrets.ts';
import {
  exitCodeForOutcome,
  printOutcomeSummary,
  writeOutcomeReport,
} from '../../tools/security-scan/src/report.ts';

const outcome = runSecretsScan(process.cwd());
writeOutcomeReport(outcome, 'secrets', process.cwd());
printOutcomeSummary(outcome);
process.exit(exitCodeForOutcome(outcome));
