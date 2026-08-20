#!/usr/bin/env node
/**
 * Entry point: no-LLM scan до Gate E (NAR-02, ADR-006).
 * Логика — `tools/security-scan/src/scan-no-llm.ts`. Скелет уровня I00 (ACCEPTANCE A11).
 */
import { runNoLlmScan } from '../../tools/security-scan/src/scan-no-llm.ts';
import {
  exitCodeForOutcome,
  printOutcomeSummary,
  writeOutcomeReport,
} from '../../tools/security-scan/src/report.ts';

const outcome = runNoLlmScan(process.cwd());
writeOutcomeReport(outcome, 'no-llm', process.cwd());
printOutcomeSummary(outcome);
process.exit(exitCodeForOutcome(outcome));
