import { describe, expect, it } from 'vitest';
import {
  FixedRuleset,
  PROTOTYPE_GOAL_WEIGHTS,
  PROTOTYPE_NEEDS,
  PROTOTYPE_REST_MINUTES,
  RULES_VERSION,
  rulesetFor,
  testRulesetVersions,
} from './ruleset.ts';

describe('FixedRuleset', () => {
  it('отдаёт ровно те версии и коэффициенты, с которыми был собран', () => {
    const versions = { schemaVersion: 1, rulesVersion: RULES_VERSION, contentVersion: '0.1.0' };
    const ruleset = new FixedRuleset(
      versions,
      PROTOTYPE_NEEDS,
      PROTOTYPE_REST_MINUTES,
      PROTOTYPE_GOAL_WEIGHTS,
    );
    expect(ruleset.versions).toStrictEqual(versions);
    expect(ruleset.needs).toStrictEqual(PROTOTYPE_NEEDS);
    expect(ruleset.restMinutes).toBe(PROTOTYPE_REST_MINUTES);
    expect(ruleset.goalWeights).toStrictEqual(PROTOTYPE_GOAL_WEIGHTS);
  });

  it('testRulesetVersions() отдаёт стабильные тестовые версии', () => {
    // Версия правил растёт вместе с коэффициентами: 0.2.0 — нужды (I04), 0.3.0 — длительность
    // отдыха (I05-A), 0.4.0 — веса выбора цели (I05-B), 0.5.0 — оценка неизвестной дороги (I06-C).
    // Rules bundle хешируется от СОДЕРЖИМОГО
    // ruleset, поэтому изменение коэффициентов при прежней версии дало бы два разных мира под
    // одним именем правил.
    expect(testRulesetVersions()).toStrictEqual({
      schemaVersion: 1,
      rulesVersion: '0.5.0',
      contentVersion: '0.1.0',
    });
  });
});

describe('rulesetFor отказывается собирать ruleset чужой версии', () => {
  it('называет обе версии и не подставляет свои коэффициенты молча', () => {
    expect(() =>
      rulesetFor({ schemaVersion: 1, rulesVersion: '0.1.0', contentVersion: '0.1.0' }),
    ).toThrow(/записан по правилам 0\.1\.0.*знает только 0\.5\.0/s);
  });

  it('для своей версии отдаёт коэффициенты прототипа', () => {
    const ruleset = rulesetFor(testRulesetVersions());
    expect(ruleset.needs).toStrictEqual(PROTOTYPE_NEEDS);
    expect(ruleset.restMinutes).toBe(PROTOTYPE_REST_MINUTES);
  });

  it('нецелая, неположительная или неправдоподобно долгая длительность отдыха — громкий отказ', () => {
    const build = (restMinutes: number): FixedRuleset =>
      new FixedRuleset(testRulesetVersions(), PROTOTYPE_NEEDS, restMinutes, PROTOTYPE_GOAL_WEIGHTS);
    expect(() => build(0)).toThrow(/restMinutes/);
    expect(() => build(90.5)).toThrow(/restMinutes/);
    // Верхняя граница появилась вместе с оценкой целей: цена времени пропорциональна
    // длительности, поэтому неограниченная длительность делает бессмысленным утверждение
    // «оценка лежит в объявленном диапазоне».
    expect(() => build(10_081)).toThrow(/restMinutes/);
  });

  it('коэффициенты выбора цели проверяются, а не принимаются на веру', () => {
    const build = (weights: typeof PROTOTYPE_GOAL_WEIGHTS): FixedRuleset =>
      new FixedRuleset(testRulesetVersions(), PROTOTYPE_NEEDS, PROTOTYPE_REST_MINUTES, weights);
    expect(() => build({ ...PROTOTYPE_GOAL_WEIGHTS, switchMarginPermille: 1001 })).toThrow(
      /goalWeights/,
    );
    // Срочность, убывающая с ухудшением уровня, дала бы агента, успокаивающегося по мере того,
    // как ему становится хуже, — и мир остался бы внутренне непротиворечивым.
    expect(() =>
      build({
        ...PROTOTYPE_GOAL_WEIGHTS,
        urgencyPermille: { normal: 0, warning: 900, critical: 400 },
      }),
    ).toThrow(/убывает/);
  });
});
