import { describe, expect, it } from 'vitest';
import {
  FixedRuleset,
  PROTOTYPE_NEEDS,
  PROTOTYPE_REST_MINUTES,
  RULES_VERSION,
  rulesetFor,
  testRulesetVersions,
} from './ruleset.ts';

describe('FixedRuleset', () => {
  it('отдаёт ровно те версии и коэффициенты, с которыми был собран', () => {
    const versions = { schemaVersion: 1, rulesVersion: RULES_VERSION, contentVersion: '0.1.0' };
    const ruleset = new FixedRuleset(versions, PROTOTYPE_NEEDS, PROTOTYPE_REST_MINUTES);
    expect(ruleset.versions).toStrictEqual(versions);
    expect(ruleset.needs).toStrictEqual(PROTOTYPE_NEEDS);
    expect(ruleset.restMinutes).toBe(PROTOTYPE_REST_MINUTES);
  });

  it('testRulesetVersions() отдаёт стабильные тестовые версии', () => {
    // Версия правил растёт вместе с коэффициентами: 0.2.0 — нужды (I04), 0.3.0 — длительность
    // отдыха (I05). Rules bundle хешируется от СОДЕРЖИМОГО ruleset, поэтому изменение
    // коэффициентов при прежней версии дало бы два разных мира под одним именем правил.
    expect(testRulesetVersions()).toStrictEqual({
      schemaVersion: 1,
      rulesVersion: '0.3.0',
      contentVersion: '0.1.0',
    });
  });
});

describe('rulesetFor отказывается собирать ruleset чужой версии', () => {
  it('называет обе версии и не подставляет свои коэффициенты молча', () => {
    expect(() =>
      rulesetFor({ schemaVersion: 1, rulesVersion: '0.1.0', contentVersion: '0.1.0' }),
    ).toThrow(/записан по правилам 0\.1\.0.*знает только 0\.3\.0/s);
  });

  it('для своей версии отдаёт коэффициенты прототипа', () => {
    const ruleset = rulesetFor(testRulesetVersions());
    expect(ruleset.needs).toStrictEqual(PROTOTYPE_NEEDS);
    expect(ruleset.restMinutes).toBe(PROTOTYPE_REST_MINUTES);
  });

  it('нецелая или неположительная длительность отдыха — громкий отказ, а не тихое округление', () => {
    expect(() => new FixedRuleset(testRulesetVersions(), PROTOTYPE_NEEDS, 0)).toThrow(
      /restMinutes/,
    );
    expect(() => new FixedRuleset(testRulesetVersions(), PROTOTYPE_NEEDS, 90.5)).toThrow(
      /restMinutes/,
    );
  });
});
