import { describe, expect, it } from 'vitest';
import {
  FixedRuleset,
  PROTOTYPE_NEEDS,
  RULES_VERSION,
  rulesetFor,
  testRulesetVersions,
} from './ruleset.ts';

describe('FixedRuleset', () => {
  it('отдаёт ровно те версии и коэффициенты, с которыми был собран', () => {
    const versions = { schemaVersion: 1, rulesVersion: RULES_VERSION, contentVersion: '0.1.0' };
    const ruleset = new FixedRuleset(versions, PROTOTYPE_NEEDS);
    expect(ruleset.versions).toStrictEqual(versions);
    expect(ruleset.needs).toStrictEqual(PROTOTYPE_NEEDS);
  });

  it('testRulesetVersions() отдаёт стабильные тестовые версии', () => {
    // Версия правил поднята до 0.2.0 вместе с появлением коэффициентов нужд (I04): rules bundle
    // хешируется от содержимого ruleset, поэтому изменение коэффициентов при прежней версии
    // дало бы два разных мира под одним именем правил.
    expect(testRulesetVersions()).toStrictEqual({
      schemaVersion: 1,
      rulesVersion: '0.2.0',
      contentVersion: '0.1.0',
    });
  });
});

describe('rulesetFor отказывается собирать ruleset чужой версии', () => {
  it('называет обе версии и не подставляет свои коэффициенты молча', () => {
    expect(() =>
      rulesetFor({ schemaVersion: 1, rulesVersion: '0.1.0', contentVersion: '0.1.0' }),
    ).toThrow(/записан по правилам 0\.1\.0.*знает только 0\.2\.0/s);
  });

  it('для своей версии отдаёт коэффициенты прототипа', () => {
    expect(rulesetFor(testRulesetVersions()).needs).toStrictEqual(PROTOTYPE_NEEDS);
  });
});
