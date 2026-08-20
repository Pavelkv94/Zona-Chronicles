/** @zona/usage-continuity — harness пятичасового usage window (DEV-01). Публичный экспорт пакета. */

export { THRESHOLDS, nextState } from './state-machine.ts';
export { parseCheckpoint, renderCheckpoint } from './checkpoint.ts';
export type { CheckpointParseError } from './checkpoint.ts';
export { FileCheckpointStore } from './file-checkpoint-store.ts';
export type { FileCheckpointStoreOptions } from './file-checkpoint-store.ts';
export { probeCapabilities, capabilityStatusFor } from './capability.ts';
export type { CapabilityProbeInput, CapabilityProbeResult } from './capability.ts';
export { runContinuityLoop, resumeFromCheckpoint, archiveResumedCheckpoint } from './runner.ts';
export type {
  RunContinuityLoopInput,
  RunContinuityLoopResult,
  ResumeFromCheckpointInput,
  ResumeFromCheckpointResult,
  StateTransition,
} from './runner.ts';
export type {
  ActionRunnerPort,
  CheckpointStorePort,
  ClockPort,
  RepoStatePort,
  UsageTelemetryPort,
  WakeSchedulerPort,
} from './ports.ts';
export type { Checkpoint, ContinuityOutcome, ContinuityState, UsageWindowSample } from './types.ts';
export { LIMIT_AUTOCONTINUE_UNAVAILABLE } from './types.ts';
export {
  parseInstant,
  requireInstant,
  isInstantError,
  compareInstants,
  addMinutes,
  STRICT_ISO_8601_INSTANT_PATTERN,
} from './instant.ts';
export type { Instant, InstantError } from './instant.ts';

export const PACKAGE_NAME = '@zona/usage-continuity' as const;
