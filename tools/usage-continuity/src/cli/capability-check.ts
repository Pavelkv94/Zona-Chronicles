#!/usr/bin/env node
/**
 * Проверяет доступность capability автопродолжения пятичасового usage window (DEV-01, A9).
 *
 * I00 не подключает реальный provider-адаптер telemetry, persisted wake scheduler или
 * session resume — это осознанный scope будущей итерации, а не баг. Поэтому ожидаемый
 * результат в текущем окружении: available=false, missing содержит все три capability,
 * exit code 1. Функция не должна утверждать наличие автопродолжения при их отсутствии.
 *
 * Использование: node tools/usage-continuity/src/cli/capability-check.ts
 * Код возврата: 0 — все capability доступны; 1 — LIMIT_AUTOCONTINUE_UNAVAILABLE.
 */
import { capabilityStatusFor, probeCapabilities } from '../capability.ts';
import type { UsageTelemetryPort } from '../ports.ts';

// В I00 реальный provider-адаптер телеметрии отсутствует: read() всегда возвращает null.
const noTelemetryAdapter: UsageTelemetryPort = { read: () => null };

const result = probeCapabilities({
  telemetry: noTelemetryAdapter,
  // Persisted wake scheduler ещё не подключён к внешнему orchestrator/runner (I00 scope).
  scheduler: null,
  // Session resume внешнего orchestrator-а не реализован в этой среде.
  resumeSupported: false,
});

const status = capabilityStatusFor(result);
console.log(JSON.stringify({ available: result.available, missing: result.missing, status }));

process.exit(result.available ? 0 : 1);
