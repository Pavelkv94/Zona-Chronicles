/**
 * D1/D2 — темп мира: сколько мирового времени проходит за секунду реального.
 *
 * Проверяется ЧИСТАЯ функция горизонта, а не worker целиком: горизонт — единственное место, где
 * реальное время вообще касается мира, и если оно верно, всё остальное — уже проверенный
 * `runWorldTick`.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORLD_TEMPO,
  DEMO_WORLD_TEMPO,
  PUBLIC_WORLD_TEMPO,
  WORLD_TEMPO_VERSION,
  worldHorizon,
  type WorldTempo,
} from './world-tempo.ts';

const START = '2028-04-26T06:00:00.000Z';

describe('D1: горизонт растёт от РЕАЛЬНОГО прошедшего времени и коэффициента скорости', () => {
  it('нулевое прошедшее время не двигает горизонт дальше стартового момента', () => {
    expect(
      worldHorizon({ startWorldTime: START, elapsedRealMs: 0, tempo: DEFAULT_WORLD_TEMPO }),
    ).toBe(START);
  });

  it('за секунду реального времени горизонт уходит на коэффициент минут мира', () => {
    const tempo: WorldTempo = { worldMinutesPerRealSecond: 1 };
    expect(worldHorizon({ startWorldTime: START, elapsedRealMs: 1000, tempo })).toBe(
      '2028-04-26T06:01:00.000Z',
    );
    expect(worldHorizon({ startWorldTime: START, elapsedRealMs: 40_000, tempo })).toBe(
      '2028-04-26T06:40:00.000Z',
    );
  });

  it('коэффициент масштабирует линейно: вдвое быстрее — вдвое дальше за то же реальное время', () => {
    const slow = worldHorizon({
      startWorldTime: START,
      elapsedRealMs: 10_000,
      tempo: { worldMinutesPerRealSecond: 1 },
    });
    const fast = worldHorizon({
      startWorldTime: START,
      elapsedRealMs: 10_000,
      tempo: { worldMinutesPerRealSecond: 2 },
    });
    expect(slow).toBe('2028-04-26T06:10:00.000Z');
    expect(fast).toBe('2028-04-26T06:20:00.000Z');
  });

  /**
   * Горизонт обязан быть МОНОТОННЫМ: мировое время не может идти назад (C12), и горизонт,
   * дёрнувшийся назад, привёл бы к отказу «мировое время не может идти назад» на ровном месте.
   */
  it('горизонт не убывает при неубывающем реальном времени', () => {
    let previous = START;
    for (const elapsed of [0, 1, 999, 1000, 1001, 59_999, 60_000]) {
      const next = worldHorizon({
        startWorldTime: START,
        elapsedRealMs: elapsed,
        tempo: DEFAULT_WORLD_TEMPO,
      });
      expect(next >= previous).toBe(true);
      previous = next;
    }
  });

  /**
   * Дробная минута усекается ВНИЗ, а не округляется. Округление вверх выдало бы горизонт,
   * которого реальное время ещё не оплатило, — то есть мир на мгновение обгонял бы темп.
   */
  /**
   * Первая редакция этого теста ожидала, что 59 999 мс дадут нулевой горизонт — я спутал «минута
   * мира за СЕКУНДУ» с «минута за минуту». Ошибка ровно того класса, ради которого в контрактах
   * запрещено безразмерное число (A5), и она стоила красного теста на верном коде. Оставляю
   * запись: единица измерения читается неправильно даже тем, кто её только что объявил.
   */
  it('неполная минута мира не засчитывается', () => {
    const tempo: WorldTempo = { worldMinutesPerRealSecond: 1 };
    // 0.999 минуты мира — ещё не минута.
    expect(worldHorizon({ startWorldTime: START, elapsedRealMs: 999, tempo })).toBe(START);
    expect(worldHorizon({ startWorldTime: START, elapsedRealMs: 1000, tempo })).toBe(
      '2028-04-26T06:01:00.000Z',
    );
    // 59.999 минуты мира — пятьдесят девять, а не шестьдесят.
    expect(worldHorizon({ startWorldTime: START, elapsedRealMs: 59_999, tempo })).toBe(
      '2028-04-26T06:59:00.000Z',
    );
    expect(worldHorizon({ startWorldTime: START, elapsedRealMs: 60_000, tempo })).toBe(
      '2028-04-26T07:00:00.000Z',
    );
  });

  it('отрицательное прошедшее время — отказ, а не молчаливый откат горизонта', () => {
    expect(() =>
      worldHorizon({ startWorldTime: START, elapsedRealMs: -1, tempo: DEFAULT_WORLD_TEMPO }),
    ).toThrow(/прошедшее реальное время/);
  });
});

describe('D2: темп версионирован и отделён от детерминизма', () => {
  it('у темпа есть версия, и она semantic version', () => {
    expect(WORLD_TEMPO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * M5 независимого аудита I03: расхождение кода с нормативом обязано быть ВИДИМЫМ.
   *
   * Тест не требует равенства — он требует, чтобы обе величины существовали, отличались
   * известным образом и не разъехались дальше молча. Если однажды норматив изменят или
   * умолчание приведут к нему, упадёт именно этот тест, а не demo у зрителя.
   */
  it('нормативная публичная скорость названа и отличается от dev-умолчания известным образом', () => {
    // 07_MVP_MECHANICS_SPEC: «1 реальная минута = 4 игровые минуты».
    expect(PUBLIC_WORLD_TEMPO.worldMinutesPerRealSecond * 60).toBeCloseTo(4, 10);
    /**
     * Утверждение УСИЛЕНО 2026-08-29, а не ослаблено: здесь стояло «умолчание быстрее ровно в 15
     * раз», то есть тест фиксировал РАЗМЕР расхождения кода со спецификацией. Расхождения больше
     * нет — умолчание равно нормативу, — и тест теперь охраняет совпадение, а не величину
     * разрыва. Изменение поведения записано в `PLAN.md` §10.3.
     */
    expect(DEFAULT_WORLD_TEMPO.worldMinutesPerRealSecond).toBe(
      PUBLIC_WORLD_TEMPO.worldMinutesPerRealSecond,
    );
    // Быстрый темп никуда не делся, но он ЗАЯВЛЯЕТСЯ, а не подразумевается.
    expect(
      DEMO_WORLD_TEMPO.worldMinutesPerRealSecond / PUBLIC_WORLD_TEMPO.worldMinutesPerRealSecond,
    ).toBeCloseTo(15, 10);
  });

  it('коэффициент по умолчанию положителен и назван', () => {
    expect(DEFAULT_WORLD_TEMPO.worldMinutesPerRealSecond).toBeGreaterThan(0);
  });

  it('нулевой или отрицательный коэффициент — отказ: остановившийся мир это не темп, а поломка', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        worldHorizon({
          startWorldTime: START,
          elapsedRealMs: 1000,
          tempo: { worldMinutesPerRealSecond: bad },
        }),
      ).toThrow(/коэффициент скорости мира/);
    }
  });
});
