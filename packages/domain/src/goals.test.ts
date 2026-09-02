/**
 * Оценка и отбор целей (I05-B, `07_MVP_MECHANICS_SPEC` §6).
 *
 * Проверяется ПОВЕДЕНИЕ выбора, а не арифметика: «голодный при наличии еды ест», «спокойный не
 * начинает ничего», «занятому недоступно ни то, ни другое». Числа проверяются там, где от них
 * зависит именно решение, — на границе, где две цели сравниваются друг с другом.
 */
import { describe, expect, it } from 'vitest';
import { GOAL_KINDS, type NeedLevel } from '@zona/contracts';
import {
  chooseGoal,
  requireValidGoalWeights,
  type GoalSituation,
  type GoalWeights,
} from './goals.ts';
import { PROTOTYPE_GOAL_WEIGHTS, PROTOTYPE_REST_MINUTES } from './ports/ruleset.ts';

const situation = (overrides: Partial<GoalSituation> = {}): GoalSituation => ({
  currentGoal: 'idle',
  needLevels: { hunger: 'normal', fatigue: 'normal' },
  hasFood: true,
  isIdle: true,
  restMinutes: PROTOTYPE_REST_MINUTES,
  ...overrides,
});

const needs = (
  hunger: NeedLevel,
  fatigue: NeedLevel,
): Readonly<Record<'hunger' | 'fatigue', NeedLevel>> => ({
  hunger,
  fatigue,
});

describe('chooseGoal — что агент выбирает', () => {
  it('спокойное тело не даёт повода ничего начинать', () => {
    // Не «еда не нужна», а именно «ни одна цель не окупает своей цены»: при уровне `normal`
    // срочность нулевая, а порог смены цели положителен.
    expect(chooseGoal(situation(), PROTOTYPE_GOAL_WEIGHTS).goal).toBe('idle');
  });

  it('проголодавшийся с едой выбирает поесть', () => {
    const decision = chooseGoal(
      situation({ needLevels: needs('warning', 'normal') }),
      PROTOTYPE_GOAL_WEIGHTS,
    );
    expect(decision.goal).toBe('eat');
  });

  it('проголодавшийся БЕЗ еды не выбирает поесть: это цель без исполнимого шага', () => {
    const decision = chooseGoal(
      situation({ needLevels: needs('critical', 'normal'), hasFood: false }),
      PROTOTYPE_GOAL_WEIGHTS,
    );
    expect(decision.goal).toBe('idle');
    // Именно неисполнимость, а не низкая оценка: у голодающего срочность максимальна.
    const eat = decision.trace.candidates.find((line) => line.goal === 'eat');
    expect(eat?.feasible).toBe(false);
    expect(eat?.score).toBeGreaterThan(0);
  });

  it('уставший выбирает отдых', () => {
    expect(
      chooseGoal(situation({ needLevels: needs('normal', 'warning') }), PROTOTYPE_GOAL_WEIGHTS)
        .goal,
    ).toBe('rest');
  });

  it('голодный и уставший сразу ест: еда мгновенна, отдых стоит восьми часов мира', () => {
    // Порядок «сначала поел, потом лёг» — СЛЕДСТВИЕ цены времени, а не записанное правило.
    const decision = chooseGoal(
      situation({ needLevels: needs('warning', 'warning') }),
      PROTOTYPE_GOAL_WEIGHTS,
    );
    expect(decision.goal).toBe('eat');
    const eat = decision.trace.candidates.find((line) => line.goal === 'eat');
    const rest = decision.trace.candidates.find((line) => line.goal === 'rest');
    expect(eat?.time_cost).toBe(0);
    expect(rest?.time_cost).toBe(200);
    expect((eat?.score ?? 0) > (rest?.score ?? 0)).toBe(true);
  });

  it('занятому агенту недоступны ни еда, ни отдых', () => {
    const decision = chooseGoal(
      situation({ needLevels: needs('critical', 'critical'), isIdle: false }),
      PROTOTYPE_GOAL_WEIGHTS,
    );
    expect(decision.goal).toBe('idle');
    expect(
      decision.trace.candidates.filter((line) => line.feasible).map((line) => line.goal),
    ).toEqual(['idle']);
  });
});

describe('разбор решения объясняет и отвергнутое', () => {
  it('содержит ВСЕ цели в объявленном порядке, включая неисполнимые', () => {
    const decision = chooseGoal(situation({ hasFood: false }), PROTOTYPE_GOAL_WEIGHTS);
    expect(decision.trace.candidates.map((line) => line.goal)).toEqual([...GOAL_KINDS]);
  });

  it('слагаемые сходятся с итогом: объяснение не может разойтись с числом', () => {
    const decision = chooseGoal(
      situation({ needLevels: needs('critical', 'warning') }),
      PROTOTYPE_GOAL_WEIGHTS,
    );
    for (const line of decision.trace.candidates) {
      expect(line.score).toBe(line.urgency - line.time_cost - line.switching_cost);
    }
  });

  it('цена смены достаётся всем, кроме текущей цели', () => {
    const decision = chooseGoal(
      situation({ currentGoal: 'rest', needLevels: needs('warning', 'warning') }),
      PROTOTYPE_GOAL_WEIGHTS,
    );
    const byGoal = Object.fromEntries(decision.trace.candidates.map((line) => [line.goal, line]));
    expect(byGoal['rest']?.switching_cost).toBe(0);
    expect(byGoal['eat']?.switching_cost).toBe(PROTOTYPE_GOAL_WEIGHTS.switchMarginPermille);
    expect(byGoal['idle']?.switching_cost).toBe(PROTOTYPE_GOAL_WEIGHTS.switchMarginPermille);
  });
});

describe('порог смены цели (hysteresis §6) решает исход, а не украшает разбор', () => {
  /**
   * Проверяется ПОВЕДЕНИЕ, а не строка разбора: слагаемое, которое нигде не меняет выбора, —
   * это второе имя другого числа, и его наличие ничего не доказывает.
   *
   * Коэффициенты подобраны на самой границе: отдых длиной 12 часов стоит 300, срочность
   * `warning` — 400. Без порога отдых выигрывает у безделья (+100), с порогом ровно ему
   * равен — и ничья решается в пользу безделья, объявленного раньше.
   *
   * Прототипные коэффициенты в эту полосу не попадают: там порог ни одного решения не меняет.
   * Это названо в PLAN §12 и не выдаётся за работающий механизм.
   */
  const borderline = (switchMarginPermille: number): GoalWeights =>
    requireValidGoalWeights(
      {
        urgencyPermille: { normal: 0, warning: 400, critical: 900 },
        timeCostPermillePerHour: 25,
        switchMarginPermille,
      },
      'borderline',
    );

  const tired = situation({ needLevels: needs('normal', 'warning'), restMinutes: 720 });

  it('с порогом агент остаётся празден', () => {
    expect(chooseGoal(tired, borderline(100)).goal).toBe('idle');
  });

  it('без порога тот же агент выбирает отдых', () => {
    expect(chooseGoal(tired, borderline(0)).goal).toBe('rest');
  });
});

describe('детерминированный tie-break', () => {
  /**
   * Коэффициенты подобраны так, чтобы `eat` и `rest` получили РОВНО одинаковую оценку.
   *
   * Ничья — единственное место, где виден порядок: при любой разнице оценок победитель
   * определяется числом. Проба «поменять `>` на `>=`» роняет именно этот тест, и только его.
   */
  const tieWeights: GoalWeights = requireValidGoalWeights(
    {
      urgencyPermille: { normal: 0, warning: 400, critical: 900 },
      timeCostPermillePerHour: 0,
      switchMarginPermille: 100,
    },
    'tie',
  );

  it('при равных оценках выигрывает цель, объявленная раньше', () => {
    const decision = chooseGoal(
      situation({ needLevels: needs('critical', 'critical'), restMinutes: 60 }),
      tieWeights,
    );
    const byGoal = Object.fromEntries(decision.trace.candidates.map((line) => [line.goal, line]));
    expect(byGoal['eat']?.score).toBe(byGoal['rest']?.score);
    expect(decision.goal).toBe('eat');
  });

  it('порядок объявления — тот самый, на который опирается ничья', () => {
    // Утверждение о ПОРЯДКЕ, а не о составе: переставленный словарь целей сменил бы победителя
    // ничьи, и без этого пина такая перестановка прошла бы незамеченной.
    expect(GOAL_KINDS.indexOf('idle')).toBeLessThan(GOAL_KINDS.indexOf('eat'));
    expect(GOAL_KINDS.indexOf('eat')).toBeLessThan(GOAL_KINDS.indexOf('rest'));
  });
});

describe('цена мирового времени', () => {
  it('округляется ВВЕРХ: заниженная цена делает долгое действие привлекательнее объявленного', () => {
    const weights = requireValidGoalWeights(
      {
        urgencyPermille: { normal: 0, warning: 400, critical: 900 },
        // 7 минут при 25 тысячных за час — это 2.9166… тысячной. Ни вниз, ни «к ближайшему»
        // здесь не даёт 3: направление округления проверяется числом, у которого оно видно.
        timeCostPermillePerHour: 25,
        switchMarginPermille: 100,
      },
      'rounding',
    );
    const decision = chooseGoal(
      situation({ needLevels: needs('normal', 'critical'), restMinutes: 7 }),
      weights,
    );
    expect(decision.trace.candidates.find((line) => line.goal === 'rest')?.time_cost).toBe(3);
  });
});
