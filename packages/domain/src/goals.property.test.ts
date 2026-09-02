/**
 * Свойства выбора цели (I05-B, PLAN §7).
 *
 * Четыре утверждения, каждое из которых должно быть верно для ЛЮБЫХ коэффициентов, проходящих
 * свою проверку, и ЛЮБОЙ ситуации, — а не для той, которую я придумал:
 *
 * - **bounded finite scores** — оценка конечна и лежит в объявленном диапазоне. Конечность
 *   проверяется ОТДЕЛЬНО: `NaN` проходит оба сравнения границ как ложь, поэтому проверка «в
 *   диапазоне» его не ловит. Урок I04, повторять его дороже, чем помнить;
 * - **выбранная цель исполнима** — иначе агент выбирает недостижимое, остаётся свободным и
 *   получает новое решение, то есть мир крутится, не породив ни одного факта (§4.3 плана);
 * - **разбор полон** — в нём все цели ровно по разу и в объявленном порядке;
 * - **победитель максимален, ничья решается рангом** — правило отбора верно целиком, а не на
 *   тех входах, где оно очевидно.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { GOAL_KINDS, NEED_LEVELS, goalRank, type NeedLevel } from '@zona/contracts';
import {
  GOAL_SCORE_BOUNDS,
  MAX_GOAL_DURATION_MINUTES,
  chooseGoal,
  requireValidGoalWeights,
  type GoalSituation,
  type GoalWeights,
} from './goals.ts';

const permille = fc.integer({ min: 0, max: 1000 });
const level = fc.constantFrom(...NEED_LEVELS);

/**
 * Произвольные КОРРЕКТНЫЕ коэффициенты.
 *
 * Срочность сортируется, а не отбрасывается: `requireValidGoalWeights` требует неубывания по
 * уровням, и отбрасывание нарушивших троек сузило бы выборку тем сильнее, чем строже правило,
 * — то есть проверяло бы функцию ровно там, где генератор оказался покладист.
 */
const weightsArb: fc.Arbitrary<GoalWeights> = fc
  .tuple(permille, permille, permille, permille, permille)
  .map(([a, b, c, timeCost, margin]) => {
    const sorted = [a, b, c].sort((x, y) => x - y);
    const urgencyPermille = Object.fromEntries(
      NEED_LEVELS.map((name, index) => [name, sorted[index] as number]),
    ) as Readonly<Record<NeedLevel, number>>;
    return requireValidGoalWeights(
      { urgencyPermille, timeCostPermillePerHour: timeCost, switchMarginPermille: margin },
      'property',
    );
  });

const situationArb: fc.Arbitrary<GoalSituation> = fc.record({
  currentGoal: fc.constantFrom(...GOAL_KINDS),
  needLevels: fc.record({ hunger: level, fatigue: level }),
  hasFood: fc.boolean(),
  isIdle: fc.boolean(),
  restMinutes: fc.integer({ min: 1, max: MAX_GOAL_DURATION_MINUTES }),
});

describe('bounded finite scores', () => {
  it('оценка конечна и лежит в объявленном диапазоне при любых коэффициентах и любой ситуации', () => {
    fc.assert(
      fc.property(situationArb, weightsArb, (situation, weights) => {
        for (const line of chooseGoal(situation, weights).trace.candidates) {
          expect(Number.isFinite(line.score)).toBe(true);
          expect(Number.isInteger(line.score)).toBe(true);
          expect(line.score).toBeGreaterThanOrEqual(GOAL_SCORE_BOUNDS.min);
          expect(line.score).toBeLessThanOrEqual(GOAL_SCORE_BOUNDS.max);
        }
      }),
    );
  });
});

describe('выбранная цель исполнима всегда', () => {
  it('и её строка в разборе помечена исполнимой', () => {
    fc.assert(
      fc.property(situationArb, weightsArb, (situation, weights) => {
        const decision = chooseGoal(situation, weights);
        const chosen = decision.trace.candidates.find((line) => line.goal === decision.goal);
        expect(chosen?.feasible).toBe(true);
      }),
    );
  });
});

describe('разбор решения полон', () => {
  it('содержит каждую цель ровно один раз и в объявленном порядке', () => {
    fc.assert(
      fc.property(situationArb, weightsArb, (situation, weights) => {
        const goals = chooseGoal(situation, weights).trace.candidates.map((line) => line.goal);
        expect(goals).toEqual([...GOAL_KINDS]);
      }),
    );
  });
});

describe('правило отбора: максимум, ничья — по рангу', () => {
  it('ни один исполнимый кандидат не лучше выбранного, а равный — не объявлен раньше', () => {
    fc.assert(
      fc.property(situationArb, weightsArb, (situation, weights) => {
        const decision = chooseGoal(situation, weights);
        const chosen = decision.trace.candidates.find((line) => line.goal === decision.goal);
        for (const line of decision.trace.candidates) {
          if (!line.feasible || line.goal === decision.goal) continue;
          expect(line.score).toBeLessThanOrEqual(chosen?.score ?? 0);
          if (line.score === chosen?.score) {
            expect(goalRank(line.goal)).toBeGreaterThan(goalRank(decision.goal));
          }
        }
      }),
    );
  });
});
