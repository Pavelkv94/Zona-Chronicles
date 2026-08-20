#!/usr/bin/env node
/**
 * Entry point: static scan (OPS-03). Логика — `tools/security-scan/src/scan-static.ts`.
 * ЧЕСТНЫЙ СКЕЛЕТ: текстовый regex-скан по ограниченному списку конструкций,
 * не полноценный SAST (см. §12 03_TECHNICAL_DESIGN.md). Release gate — I17.
 */
import { runStaticScan } from '../../tools/security-scan/src/scan-static.ts';
import {
  exitCodeForOutcome,
  printOutcomeSummary,
  writeReportFile,
} from '../../tools/security-scan/src/report.ts';

const outcome = runStaticScan(process.cwd());
if (outcome.kind === 'ok') writeReportFile(outcome.report, process.cwd());
printOutcomeSummary(outcome);
process.exit(exitCodeForOutcome(outcome));
