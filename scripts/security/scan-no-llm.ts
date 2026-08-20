#!/usr/bin/env node
/**
 * Entry point: no-LLM scan до Gate E (NAR-02, ADR-006).
 * Логика — `tools/security-scan/src/scan-no-llm.ts`. Скелет уровня I00 (ACCEPTANCE A11).
 */
import { runNoLlmScan } from '../../tools/security-scan/src/scan-no-llm.ts';
import {
  exitCodeForOutcome,
  printOutcomeSummary,
  writeReportFile,
} from '../../tools/security-scan/src/report.ts';

const outcome = runNoLlmScan(process.cwd());
if (outcome.kind === 'ok') writeReportFile(outcome.report, process.cwd());
printOutcomeSummary(outcome);
process.exit(exitCodeForOutcome(outcome));
