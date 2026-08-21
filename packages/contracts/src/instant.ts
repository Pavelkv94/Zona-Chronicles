import { MILLISECOND_UNIT } from './numeric.ts';

/**
 * Валидируемое время на границе портов continuity harness (DEV-01, review finding m3/N7).
 *
 * `ClockPort.now()` и `UsageWindowSample.reported_reset_at`/`observed_at` — инъектированные
 * ISO-8601 строки, а не wall clock, но они всё равно приходят снаружи (CLI, тесты, будущий
 * provider-адаптер) и могут быть невалидны или неоднозначны.
 *
 * Голый `Date.parse` не годится по двум независимым причинам:
 * 1. Мусорная строка даёт `NaN`, и любое сравнение с `NaN` молча возвращает `false` — то есть
 *    "ещё не наступило" вместо явной ошибки конфигурации (m3).
 * 2. `Date.parse` принимает форматы, которые не являются ISO-8601 date-time, и для части из
 *    них (`"March 1, 2026"`, `"2026"`, `"12/31/2026"`, `"2026-01-01 05:00"` без смещения)
 *    результат зависит от локали/часового пояса ХОСТА, на котором выполняется парсинг (N7).
 *    Такое значение, записанное в `reported_reset_at`/`checkpointed_at` checkpoint-а, даёт
 *    разный `epochMs` в зависимости от того, где именно был создан или прочитан checkpoint —
 *    ровно та неопределённость, которую checkpoint обязан исключать.
 *
 * КОНТРАКТ `Instant` (обязателен и для будущего I01 world time): валидная строка — это
 * ISO-8601 `date-time` с обязательным ЯВНЫМ смещением (`Z` либо `±HH:MM`). Никакие формы без
 * явного смещения не принимаются — не потому что они "не ISO-8601" вообще (date-only и
 * local-time формы существуют в стандарте), а потому что именно они интерпретируются
 * относительно локали/часового пояса среды выполнения, а не абсолютного момента времени.
 * Календарная корректность (`2026-02-30` и подобные) проверяется явно, а не полагается на
 * то, что переполнение молча "перетечёт" в соседний месяц.
 *
 * `parseInstant` — единственная точка, где строка становится валидированным `Instant`;
 * дальше арифметика и сравнение работают только над `epochMs`, без повторного `Date.parse`.
 */

/**
 * Сколько знаков дробной части допускает единица времени. Не «магическая тройка»: величина
 * приходит из `MILLISECOND_UNIT`, где точность документирована вместе с диапазоном (A5).
 */
const MAX_FRACTION_DIGITS = Math.round(Math.log10(MILLISECOND_UNIT.minorUnitsPerMajor));

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

/**
 * Строгий ISO-8601 `date-time` с ОБЯЗАТЕЛЬНЫМ явным смещением: `Z` либо `±HH:MM`.
 * Экспортируется, чтобы будущие потребители контракта (I01 world time) могли переиспользовать
 * ровно это определение, а не заново отгадывать формат.
 */
export const STRICT_ISO_8601_INSTANT_PATTERN = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})` +
    `(?:\\.(\\d{1,${MAX_FRACTION_DIGITS}}))?(Z|[+-]\\d{2}:\\d{2})$`,
);

/**
 * То же самое, но с дробной частью любой длины. Нужен ровно для одного: отличить «мусор» от
 * «валидной метки, записанной точнее миллисекунды», и дать по второму случаю внятную причину
 * вместо общего «невалидная ISO-8601 метка».
 */
const OVERPRECISE_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  // Non-null assertion: month всегда 1..12 — проверено вызывающим до вызова daysInMonth.
  return DAYS_IN_MONTH[month - 1]!;
}

const MS_PER_DAY = 86_400_000;

/**
 * Число дней от эпохи Unix до гражданской даты, целочисленной арифметикой (алгоритм
 * days_from_civil Говарда Хиннанта). Корректен для всего пролептического григорианского
 * календаря.
 *
 * Почему не `Date.UTC`, хотя он тоже детерминирован и не зависит от локали:
 *
 * 1. `Date.UTC` отображает годы 0–99 в 1900+year, поэтому `"0099-01-01T00:00:00Z"` проходил
 *    строгий regex и давал момент 1999 года (minor 1 третьего раунда верификации). Здесь
 *    год используется как есть;
 * 2. `packages/contracts` живёт под запретом SIM-01 на `Date.*` (ADR-003). Исключение ради
 *    одного вызова ослабило бы правило, которое во всём остальном абсолютно. Контракт
 *    момента времени не должен требовать оговорки — тем более контракт, на котором в I01
 *    будет стоять world time.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Парсит ISO-8601 метку времени. Никогда не бросает исключение — только `{ error }`. */
export function parseInstant(value: string): Instant | InstantError {
  const match = STRICT_ISO_8601_INSTANT_PATTERN.exec(value);
  if (match === null) {
    const overprecise = OVERPRECISE_INSTANT_PATTERN.exec(value);
    if (overprecise !== null) {
      return {
        error:
          `метка времени точнее миллисекунды (знаков дробной части: ${overprecise[1]!.length} ` +
          `при допустимых ${MAX_FRACTION_DIGITS}): ${JSON.stringify(value)}; ` +
          'усечение изменило бы текст, но не момент, и один факт получил бы два checksum',
      };
    }
    return {
      error:
        `невалидная ISO-8601 метка времени (ожидается YYYY-MM-DDTHH:mm:ss[.sss](Z|±HH:MM)): ` +
        `${JSON.stringify(value)}`,
    };
  }

  // Группы 1-6 и 8 обязательны в самом regex (без "?"), поэтому раз `match` не null, они
  // гарантированно строки — non-null assertion отражает это, а не обходит проверку.
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, fractionStr, offsetStr] =
    match;
  const year = Number(yearStr!);
  const month = Number(monthStr!);
  const day = Number(dayStr!);
  const hour = Number(hourStr!);
  const minute = Number(minuteStr!);
  const second = Number(secondStr!);

  if (month < 1 || month > 12) {
    return { error: `невалидный месяц в ISO-8601 метке: ${JSON.stringify(value)}` };
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return {
      error: `невалидный день месяца в ISO-8601 метке (несуществующая дата): ${JSON.stringify(value)}`,
    };
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return { error: `невалидное время суток в ISO-8601 метке: ${JSON.stringify(value)}` };
  }

  // Дробная часть уже ограничена шаблоном тремя знаками, поэтому дополнение нулями справа —
  // это перевод в миллисекунды без какого-либо округления: ".1" -> 100, ".12" -> 120.
  const milliseconds =
    fractionStr === undefined ? 0 : Number(fractionStr.padEnd(MAX_FRACTION_DIGITS, '0'));

  // Смещение обязательно (проверено regex-ом): "Z" -> 0, иначе "+HH:MM"/"-HH:MM".
  const offset = offsetStr!;
  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const sign = offset[0] === '-' ? -1 : 1;
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMins = Number(offset.slice(4, 6));
    if (offsetHours > 23 || offsetMins > 59) {
      return { error: `невалидное смещение в ISO-8601 метке: ${JSON.stringify(value)}` };
    }
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }

  const epochMs =
    daysFromCivil(year, month, day) * MS_PER_DAY +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1_000 +
    milliseconds -
    offsetMinutes * 60_000;

  return { iso: value, epochMs };
}

/**
 * Парсит и сразу бросает `Error` с меткой источника при невалидном значении — граница порта,
 * где "битая метка времени" обязана быть явной ошибкой конфигурации, а не "ещё не наступило".
 */
export function requireInstant(value: string, sourceLabel: string): Instant {
  const parsed = parseInstant(value);
  if (isInstantError(parsed)) {
    throw new Error(`невалидное время из "${sourceLabel}" — ${parsed.error}`);
  }
  return parsed;
}

export function compareInstants(a: Instant, b: Instant): number {
  return a.epochMs - b.epochMs;
}

/**
 * Арифметика над моментом (`addMinutes`, `requireAddMinutes`) живёт в `canonical-instant.ts`.
 *
 * Не «так исторически сложилось»: её результат обязан быть КАНОНИЧЕСКОЙ строкой, а значит
 * форматироваться `formatCanonicalInstant`. Импорт из `instant.ts` в обратную сторону создал бы
 * цикл модулей, запрещённый правилом `no-circular` (ADR-002).
 */
