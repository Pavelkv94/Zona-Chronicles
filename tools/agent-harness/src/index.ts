/**
 * @zona/agent-harness — исполняемые ограничения агентной работы (DEV-02, ADR-008).
 *
 * Пакет является dev-инструментом и не входит в продукт: `packages/**` не может от него зависеть.
 */
export { matchesGlob, matchesAnyGlob, normalizePath } from './glob.ts';
export { PROTECTED_PATHS, HUMAN_ONLY_PATHS } from './protected-paths.ts';
export { decideWrite, extractTargetPath, toRepoRelative } from './decide-write.ts';
export type { WriteDecision, WriteRequest } from './decide-write.ts';
export { decideBashCommand } from './decide-bash.ts';
export type { BashDecision } from './decide-bash.ts';
export { findDiffViolations, formatViolations } from './diff-violations.ts';
export type { DiffViolation } from './diff-violations.ts';
export { loadWriteSet, parseWriteSet } from './writeset.ts';
export type { WriteSet, WriteSetLoadResult } from './writeset.ts';
