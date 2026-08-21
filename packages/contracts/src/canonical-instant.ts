/**
 * Канонический момент времени: единственная форма, в которой время попадает в canonical
 * event, snapshot и checksum (SIM-01, A3, A5).
 *
 * `parseInstant` из `instant.ts` — общий контракт границы портов: он принимает любое
 * смещение и до девяти знаков дробной части, сохраняя ИСХОДНЫЙ текст в `iso`. Для continuity
 * harness этого достаточно. Для мира — нет, по двум независимым причинам:
 *
 * 1. `2026-08-20T20:00:00+02:00` и `2026-08-20T18:00:00Z` — ОДИН момент, но разный текст,
 *    поэтому канонический JSON и checksum состояния зависели бы от того, в каком смещении
 *    его записал источник. Каноническая форма всегда UTC.
 * 2. `...:00.1234Z` и `...:00.1236Z` дают ОДИН `epochMs`, но разный текст: `parseInstant`
 *    молча усекает разряды точнее миллисекунды. Молчаливое усечение — это и есть «неявное
 *    округление», запрещённое A5. Каноническая форма отвергает такие значения на границе.
 *
 * Каноническая форма фиксирована: `YYYY-MM-DDTHH:mm:ss.sssZ`, ровно три знака дробной части,
 * всегда `Z`. Допустимая точность задаётся не «магической тройкой», а единицей
 * `MILLISECOND_UNIT`, у которой она документирована вместе с диапазоном.
 */
import { type Instant, type InstantError, isInstantError, parseInstant } from './instant.ts';
import { MILLISECOND_UNIT } from './numeric.ts';

/** Форма канонического момента. Календарную корректность шаблон не проверяет. */
export const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Сколько знаков дробной части допускает единица времени: 1000 minor units на секунду. */
const FRACTION_DIGITS = Math.round(Math.log10(MILLISECOND_UNIT.minorUnitsPerMajor));

const MS_PER_DAY = 86_400_000;

/** Дробная часть исходной метки: то, что стоит между `.` и смещением. */
const FRACTION_PATTERN = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/;

/**
 * Разбирает момент и приводит его к канонической форме. Возвращает `{ error }`, если метка
 * невалидна, не имеет явного смещения или точнее миллисекунды.
 */
export function parseCanonicalInstant(value: string): Instant | InstantError {
  const fraction = FRACTION_PATTERN.exec(value);
  if (fraction !== null && fraction[1]!.length > FRACTION_DIGITS) {
    return {
      error:
        `метка времени точнее миллисекунды (${fraction[1]!.length} знаков дробной части при ` +
        `допустимых ${FRACTION_DIGITS}): ${JSON.stringify(value)}; ` +
        'усечение изменило бы текст, но не момент, и checksum перестал бы быть функцией состояния',
    };
  }

  const parsed = parseInstant(value);
  if (isInstantError(parsed)) {
    return parsed;
  }
  return { iso: formatCanonicalInstant(parsed.epochMs), epochMs: parsed.epochMs };
}

/** Момент уже в канонической форме и календарно корректен. */
export function isCanonicalInstant(value: string): boolean {
  if (!CANONICAL_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const parsed = parseCanonicalInstant(value);
  return !isInstantError(parsed) && parsed.iso === value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Гражданская дата из числа дней от эпохи Unix — обратная к `daysFromCivil` из `instant.ts`
 * (алгоритм civil_from_days Говарда Хиннанта), целочисленной арифметикой.
 *
 * Не `new Date(epochMs).toISOString()` по той же причине, по которой `instant.ts` не
 * использует `Date.UTC`: контракт момента времени не должен требовать оговорки об исключении
 * из запрета SIM-01 на `Date.*`, тем более контракт, на котором стоит world time.
 */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  const year = era * 400 + yearOfEra + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/**
 * Форматирует момент в каноническую строку. Бросает `Error` на нецелом, нефинитном или
 * выходящем из диапазона единицы времени значении: такой момент — ошибка вызывающего, а не
 * данные, которые можно как-то отобразить.
 */
export function formatCanonicalInstant(epochMs: number): string {
  if (!Number.isInteger(epochMs)) {
    return failFormat(epochMs, 'момент обязан быть целым числом миллисекунд');
  }
  if (epochMs < MILLISECOND_UNIT.min || epochMs > MILLISECOND_UNIT.max) {
    return failFormat(
      epochMs,
      `момент вне диапазона единицы ${MILLISECOND_UNIT.id} ` +
        `[${MILLISECOND_UNIT.min}, ${MILLISECOND_UNIT.max}] — год не помещается в четыре знака`,
    );
  }

  // `Math.floor` вместо целочисленного деления: для отрицательных моментов остаток обязан
  // остаться неотрицательным, иначе время до эпохи форматируется на день вперёд.
  const days = Math.floor(epochMs / MS_PER_DAY);
  const msOfDay = epochMs - days * MS_PER_DAY;
  const { year, month, day } = civilFromDays(days);

  const hour = Math.floor(msOfDay / 3_600_000);
  const minute = Math.floor((msOfDay % 3_600_000) / 60_000);
  const second = Math.floor((msOfDay % 60_000) / 1_000);
  const millisecond = msOfDay % 1_000;

  return (
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millisecond, FRACTION_DIGITS)}Z`
  );
}

function failFormat(epochMs: number, reason: string): never {
  throw new Error(`невозможно отформатировать момент ${String(epochMs)}: ${reason}`);
}
