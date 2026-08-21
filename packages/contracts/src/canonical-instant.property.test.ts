import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isInstantError } from './instant.ts';
import {
  CANONICAL_INSTANT_PATTERN,
  formatCanonicalInstant,
  isCanonicalInstant,
  parseCanonicalInstant,
} from './canonical-instant.ts';
import { MILLISECOND_UNIT } from './numeric.ts';

/**
 * Инварианты канонического момента (SIM-01).
 *
 * Проверка дифференциальная, а не самосогласованная: `formatCanonicalInstant` считает дату по
 * `civilFromDays`, а `parseCanonicalInstant` — по независимому `daysFromCivil` из `instant.ts`.
 * Систематическая ошибка в одной из двух реализаций разводит их результаты; ошибка внутри
 * одной, «согласованная сама с собой», такой проверкой действительно ловится.
 *
 * Генератор намеренно покрывает границы, а не только «обычные» даты (урок I00-F5): годы до
 * эпохи, год 0000, год 9999, високосные сутки и последнюю миллисекунду суток.
 */
const anyEpochMs = fc.integer({ min: MILLISECOND_UNIT.min, max: MILLISECOND_UNIT.max });

/** Границы, которые равномерный генератор практически не достигает. */
const boundaryEpochMs = fc.constantFrom(
  MILLISECOND_UNIT.min,
  MILLISECOND_UNIT.max,
  0,
  -1,
  1,
  -62_135_596_800_000, // 0001-01-01T00:00:00.000Z
  1_709_164_800_000, // 2024-02-29 — високосные сутки
  1_709_251_199_999, // 2024-02-29T23:59:59.999Z — последняя миллисекунда високосных суток
  4_102_444_800_000, // 2100-01-01 — невисокосный столетний год
  -2_208_988_800_000, // 1900-01-01 — невисокосный столетний год до эпохи
);

const epochMs = fc.oneof(anyEpochMs, boundaryEpochMs);

describe('канонический момент: инварианты', () => {
  it('round-trip: epochMs -> строка -> epochMs сохраняет момент', () => {
    fc.assert(
      fc.property(epochMs, (ms) => {
        const parsed = parseCanonicalInstant(formatCanonicalInstant(ms));
        expect(isInstantError(parsed)).toBe(false);
        if (isInstantError(parsed)) return;
        expect(parsed.epochMs).toBe(ms);
      }),
      { numRuns: 1000 },
    );
  });

  it('вывод всегда соответствует канонической форме', () => {
    fc.assert(
      fc.property(epochMs, (ms) => {
        const formatted = formatCanonicalInstant(ms);
        expect(CANONICAL_INSTANT_PATTERN.test(formatted)).toBe(true);
        expect(isCanonicalInstant(formatted)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('монотонность: больший момент даёт лексикографически большую строку', () => {
    // Каноническая форма фиксированной ширины, поэтому лексикографический порядок строк
    // обязан совпадать с хронологическим. На этом стоит любая сортировка по world_time.
    fc.assert(
      fc.property(epochMs, epochMs, (a, b) => {
        const textA = formatCanonicalInstant(a);
        const textB = formatCanonicalInstant(b);
        expect(Math.sign(textA < textB ? -1 : textA > textB ? 1 : 0)).toBe(Math.sign(a - b));
      }),
      { numRuns: 1000 },
    );
  });

  it('нормализация смещения не сдвигает момент', () => {
    fc.assert(
      fc.property(
        epochMs,
        fc.integer({ min: -23, max: 23 }),
        fc.constantFrom(0, 15, 30, 45),
        (ms, offsetHours, offsetMinutes) => {
          const offsetMs =
            (offsetHours * 60 + Math.sign(offsetHours || 1) * offsetMinutes) * 60_000;
          const shifted = ms + offsetMs;
          if (shifted < MILLISECOND_UNIT.min || shifted > MILLISECOND_UNIT.max) return;

          const sign = offsetHours < 0 || (offsetHours === 0 && offsetMs < 0) ? '-' : '+';
          const pad = (value: number): string => String(Math.abs(value)).padStart(2, '0');
          const local = formatCanonicalInstant(shifted).replace(
            'Z',
            `${sign}${pad(offsetHours)}:${pad(offsetMinutes)}`,
          );

          const parsed = parseCanonicalInstant(local);
          // Не `if (isInstantError) return`: молчаливый пропуск превратил бы это свойство в
          // всегда-зелёное, если бы конструируемая строка оказалась невалидной (урок I00-F5).
          expect(isInstantError(parsed)).toBe(false);
          if (isInstantError(parsed)) return;
          expect(parsed.epochMs).toBe(ms);
          expect(parsed.iso).toBe(formatCanonicalInstant(ms));
        },
      ),
      { numRuns: 1000 },
    );
  });
});
