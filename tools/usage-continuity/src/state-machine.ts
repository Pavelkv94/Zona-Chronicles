/**
 * Continuity state machine пятихасового usage window (DEV-01).
 * Источник переходов: docs/08_TDD_AND_AGENT_WORKFLOW.md §9, ACCEPTANCE.md A7-A9.
 *
 * Чистая функция без побочных эффектов: telemetry, время и remaining_percent приходят
 * инъектированными аргументами, а не через wall clock/process.env.
 */
import { compareInstants, requireInstant } from './instant.ts';
import type { ContinuityState, UsageWindowSample } from './types.ts';

/** Именованные пороги переходов — не литералы внутри условий. */
export const THRESHOLDS = {
  /** remaining <= это значение и > waiting_max -> checkpoint_only. Также порог resume-триггера "remaining > 2%". */
  checkpoint_only_max_remaining_percent: 2,
  /** remaining <= это значение -> waiting_for_usage_reset. */
  waiting_max_remaining_percent: 1,
} as const;

/** Классификация состояния по остатку окна, без учёта истории переходов. */
function classifyByRemaining(remaining_percent: number): ContinuityState {
  if (remaining_percent > THRESHOLDS.checkpoint_only_max_remaining_percent) {
    return 'normal';
  }
  if (remaining_percent > THRESHOLDS.waiting_max_remaining_percent) {
    return 'checkpoint_only';
  }
  return 'waiting_for_usage_reset';
}

/**
 * Сравнение ISO-8601 меток времени. Обе стороны — инъектированные строки, не wall clock.
 * Невалидная метка — явная ошибка конфигурации (m3), а не молчаливое "ещё не наступило"
 * через `NaN`-сравнение.
 */
function isAtOrAfter(now: string, reportedResetAt: string): boolean {
  const nowInstant = requireInstant(now, 'ClockPort.now()');
  const resetInstant = requireInstant(reportedResetAt, 'reported_reset_at');
  return compareInstants(nowInstant, resetInstant) >= 0;
}

/**
 * Чистый переход состояния continuity runner.
 *
 * - remaining > 2% -> normal
 * - 2% >= remaining > 1% -> checkpoint_only
 * - remaining <= 1% -> waiting_for_usage_reset
 * - из waiting_for_usage_reset: now >= reported_reset_at ИЛИ новый remaining > 2% -> validating_resume
 * - из validating_resume -> in_progress (безусловно; сверку repo state делает runner отдельно)
 */
export function nextState(
  current: ContinuityState,
  sample: UsageWindowSample,
  now: string,
): ContinuityState {
  if (current === 'validating_resume') {
    return 'in_progress';
  }

  if (current === 'waiting_for_usage_reset') {
    const resetReached = isAtOrAfter(now, sample.reported_reset_at);
    const recovered = sample.remaining_percent > THRESHOLDS.checkpoint_only_max_remaining_percent;
    if (resetReached || recovered) {
      return 'validating_resume';
    }
    return 'waiting_for_usage_reset';
  }

  return classifyByRemaining(sample.remaining_percent);
}
