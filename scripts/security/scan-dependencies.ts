#!/usr/bin/env node
/**
 * Entry point: dependency scan (OPS-03). Логика — `tools/security-scan/src/scan-dependencies.ts`.
 * Скелет уровня I00 (ACCEPTANCE A10); release gate — I17.
 */
import { runDependenciesScan } from '../../tools/security-scan/src/scan-dependencies.ts';
import {
  exitCodeForOutcome,
  printOutcomeSummary,
  writeOutcomeReport,
} from '../../tools/security-scan/src/report.ts';

const outcome = runDependenciesScan(process.cwd());
writeOutcomeReport(outcome, 'dependencies', process.cwd());
printOutcomeSummary(outcome);
process.exit(exitCodeForOutcome(outcome));
