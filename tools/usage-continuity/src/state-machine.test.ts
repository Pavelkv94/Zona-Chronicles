import { describe, expect, it } from 'vitest';
import { nextState, THRESHOLDS } from './state-machine.ts';
import type { UsageWindowSample } from './types.ts';

const sample = (
  remaining_percent: number,
  reported_reset_at = '2026-08-20T12:00:00.000Z',
): UsageWindowSample => ({
  remaining_percent,
  reported_reset_at,
  source: 'test',
  observed_at: '2026-08-20T10:00:00.000Z',
});

describe('THRESHOLDS', () => {
  it('фиксирует пороги переходов из §9 08_TDD_AND_AGENT_WORKFLOW.md', () => {
    expect(THRESHOLDS.checkpoint_only_max_remaining_percent).toBe(2);
    expect(THRESHOLDS.waiting_max_remaining_percent).toBe(1);
  });
});

describe('nextState — классификация по остатку', () => {
  it('remaining > 2% -> normal', () => {
    expect(nextState('normal', sample(5), '2026-08-20T09:00:00.000Z')).toBe('normal');
    expect(nextState('in_progress', sample(2.01), '2026-08-20T09:00:00.000Z')).toBe('normal');
  });

  it('2% >= remaining > 1% -> checkpoint_only', () => {
    expect(nextState('normal', sample(2), '2026-08-20T09:00:00.000Z')).toBe('checkpoint_only');
    expect(nextState('normal', sample(1.5), '2026-08-20T09:00:00.000Z')).toBe('checkpoint_only');
  });

  it('remaining <= 1% -> waiting_for_usage_reset', () => {
    expect(nextState('normal', sample(1), '2026-08-20T09:00:00.000Z')).toBe(
      'waiting_for_usage_reset',
    );
    expect(nextState('checkpoint_only', sample(0), '2026-08-20T09:00:00.000Z')).toBe(
      'waiting_for_usage_reset',
    );
  });
});

describe('nextState — выход из ожидания и resume', () => {
  it('waiting_for_usage_reset остаётся, пока now < reported_reset_at и remaining низкий', () => {
    const s = sample(0.5, '2026-08-20T12:00:00.000Z');
    expect(nextState('waiting_for_usage_reset', s, '2026-08-20T11:59:00.000Z')).toBe(
      'waiting_for_usage_reset',
    );
  });

  it('waiting_for_usage_reset -> validating_resume когда now >= reported_reset_at', () => {
    const s = sample(0.5, '2026-08-20T12:00:00.000Z');
    expect(nextState('waiting_for_usage_reset', s, '2026-08-20T12:00:00.000Z')).toBe(
      'validating_resume',
    );
    expect(nextState('waiting_for_usage_reset', s, '2026-08-20T13:00:00.000Z')).toBe(
      'validating_resume',
    );
  });

  it('waiting_for_usage_reset -> validating_resume при новом sample с remaining > 2%, даже до reset времени', () => {
    const s = sample(3, '2026-08-20T12:00:00.000Z');
    expect(nextState('waiting_for_usage_reset', s, '2026-08-20T11:00:00.000Z')).toBe(
      'validating_resume',
    );
  });

  it('validating_resume -> in_progress безусловно', () => {
    expect(nextState('validating_resume', sample(5), '2026-08-20T09:00:00.000Z')).toBe(
      'in_progress',
    );
    expect(nextState('validating_resume', sample(0), '2026-08-20T09:00:00.000Z')).toBe(
      'in_progress',
    );
  });

  it('in_progress с низким остатком снова уходит в checkpoint_only/waiting', () => {
    expect(nextState('in_progress', sample(1.8), '2026-08-20T09:00:00.000Z')).toBe(
      'checkpoint_only',
    );
    expect(nextState('in_progress', sample(0.9), '2026-08-20T09:00:00.000Z')).toBe(
      'waiting_for_usage_reset',
    );
  });
});

describe('nextState — невалидное время (m3)', () => {
  it('бросает явную ошибку на невалидном reported_reset_at вместо молчаливого "ещё не наступило"', () => {
    const s = sample(0.5, 'not-a-valid-timestamp');
    expect(() => nextState('waiting_for_usage_reset', s, '2026-08-20T09:00:00.000Z')).toThrow(
      /невалидное время|reported_reset_at/,
    );
  });

  it('бросает явную ошибку на невалидном now', () => {
    const s = sample(0.5, '2026-08-20T12:00:00.000Z');
    expect(() => nextState('waiting_for_usage_reset', s, 'garbage')).toThrow(
      /невалидное время|ClockPort/,
    );
  });
});
