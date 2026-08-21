import { describe, expect, it } from 'vitest';
import { FixedRuleset, testRulesetVersions } from './ruleset.ts';

describe('FixedRuleset', () => {
  it('отдаёт ровно те версии, с которыми была собрана', () => {
    const versions = { schemaVersion: 1, rulesVersion: '0.1.0', contentVersion: '0.1.0' };
    const ruleset = new FixedRuleset(versions);
    expect(ruleset.versions).toStrictEqual(versions);
  });

  it('testRulesetVersions() отдаёт стабильные тестовые версии первого slice', () => {
    expect(testRulesetVersions()).toStrictEqual({
      schemaVersion: 1,
      rulesVersion: '0.1.0',
      contentVersion: '0.1.0',
    });
  });
});
