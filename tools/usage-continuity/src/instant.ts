/**
 * Валидируемое время на границе портов continuity harness (DEV-01, review finding m3).
 *
 * `ClockPort.now()` и `UsageWindowSample.reported_reset_at`/`observed_at` — инъектированные
 * ISO-8601 строки, а не wall clock, но они всё равно приходят снаружи (CLI, тесты, будущий
 * provider-адаптер) и могут быть невалидны. `Date.parse` на мусорной строке даёт `NaN`, и любое
 * сравнение с `NaN` молча возвращает `false` — то есть "ещё не наступило" вместо явной ошибки
 * конфигурации, а `new Date(NaN).toISOString()` бросает `RangeError` в неожиданный момент.
 *
 * `parseInstant` — единственная точка, где ISO-строка становится валидированным `Instant`;
 * дальше арифметика и сравнение работают только над `epochMs`, без повторного `Date.parse`.
 */

export interface Instant {
  readonly iso: string;
  readonly epochMs: number;
}

export interface InstantError {
  readonly error: string;
}

export function isInstantError(value: Instant | InstantError): value is InstantError {
  return 'error' in value;
}

/** Парсит ISO-8601 метку времени. Никогда не бросает исключение — только `{ error }`. */
export function parseInstant(value: string): Instant | InstantError {
  const epochMs = Date.parse(value);
  if (Number.isNaN(epochMs)) {
    return { error: `невалидная ISO-8601 метка времени: ${JSON.stringify(value)}` };
  }
  return { iso: value, epochMs };
}

/**
 * Парсит и сразу бросает `Error` с меткой источника при невалидном значении — граница порта,
 * где "битая метка времени" обязана быть явной ошибкой конфигурации, а не "ещё не наступило".
 */
export function requireInstant(value: string, sourceLabel: string): Instant {
  const parsed = parseInstant(value);
  if (isInstantError(parsed)) {
    throw new Error(`continuity: невалидное время из "${sourceLabel}" — ${parsed.error}`);
  }
  return parsed;
}

export function compareInstants(a: Instant, b: Instant): number {
  return a.epochMs - b.epochMs;
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  const epochMs = instant.epochMs + minutes * 60_000;
  return { iso: new Date(epochMs).toISOString(), epochMs };
}
