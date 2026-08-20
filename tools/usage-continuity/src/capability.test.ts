import { describe, expect, it } from 'vitest';
import { probeCapabilities } from './capability.ts';
import type { UsageTelemetryPort, WakeSchedulerPort } from './ports.ts';

const workingTelemetry: UsageTelemetryPort = {
  read: () => ({
    remaining_percent: 50,
    reported_reset_at: '2026-08-20T12:00:00.000Z',
    source: 'test',
    observed_at: '2026-08-20T10:00:00.000Z',
  }),
};

const missingTelemetry: UsageTelemetryPort = { read: () => null };

const workingScheduler: WakeSchedulerPort = {
  scheduleWake: () => {
    /* no-op fixture */
  },
};

describe('probeCapabilities', () => {
  it('available=true, когда telemetry, scheduler и resume поддержаны', () => {
    const result = probeCapabilities({
      telemetry: workingTelemetry,
      scheduler: workingScheduler,
      resumeSupported: true,
    });
    expect(result).toEqual({ available: true, missing: [] });
  });

  it('available=false и перечисляет telemetry в missing, когда telemetry.read() === null', () => {
    const result = probeCapabilities({
      telemetry: missingTelemetry,
      scheduler: workingScheduler,
      resumeSupported: true,
    });
    expect(result.available).toBe(false);
    expect(result.missing).toContain('telemetry');
  });

  it('available=false и перечисляет wake_scheduler, когда scheduler === null', () => {
    const result = probeCapabilities({
      telemetry: workingTelemetry,
      scheduler: null,
      resumeSupported: true,
    });
    expect(result.available).toBe(false);
    expect(result.missing).toContain('wake_scheduler');
  });

  it('available=false и перечисляет session_resume, когда resumeSupported=false', () => {
    const result = probeCapabilities({
      telemetry: workingTelemetry,
      scheduler: workingScheduler,
      resumeSupported: false,
    });
    expect(result.available).toBe(false);
    expect(result.missing).toContain('session_resume');
  });

  it('перечисляет все отсутствующие capability одновременно, без дублей', () => {
    const result = probeCapabilities({
      telemetry: missingTelemetry,
      scheduler: null,
      resumeSupported: false,
    });
    expect(result.available).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining(['telemetry', 'wake_scheduler', 'session_resume']),
    );
    expect(result.missing).toHaveLength(3);
  });
});
