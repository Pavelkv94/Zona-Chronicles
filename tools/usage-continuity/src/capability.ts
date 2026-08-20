/**
 * Capability probe для continuity harness (DEV-01, ACCEPTANCE A9).
 * Функция не должна утверждать наличие автопродолжения, если хотя бы одна
 * зависимая capability недоступна в текущей среде.
 */
import { LIMIT_AUTOCONTINUE_UNAVAILABLE } from './types.ts';
import type { UsageTelemetryPort, WakeSchedulerPort } from './ports.ts';

export interface CapabilityProbeInput {
  /** Порт телеметрии. `.read() === null` означает, что данных пятичасового окна нет. */
  readonly telemetry: UsageTelemetryPort;
  /** Порт persisted wake. `null` означает, что среда не умеет ставить отложенное пробуждение. */
  readonly scheduler: WakeSchedulerPort | null;
  /** Поддерживает ли среда возобновление той же сессии/задачи после wake. */
  readonly resumeSupported: boolean;
}

export interface CapabilityProbeResult {
  readonly available: boolean;
  readonly missing: readonly string[];
}

/** Проверяет все capability, необходимые для автопродолжения, не обещая недостающего. */
export function probeCapabilities(input: CapabilityProbeInput): CapabilityProbeResult {
  const missing: string[] = [];
  if (input.telemetry.read() === null) {
    missing.push('telemetry');
  }
  if (input.scheduler === null) {
    missing.push('wake_scheduler');
  }
  if (!input.resumeSupported) {
    missing.push('session_resume');
  }
  return { available: missing.length === 0, missing };
}

/** Статус capability для записи в checkpoint.capability_status, когда missing непусто. */
export function capabilityStatusFor(result: CapabilityProbeResult): string | undefined {
  return result.available ? undefined : LIMIT_AUTOCONTINUE_UNAVAILABLE;
}
