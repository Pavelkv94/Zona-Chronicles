/**
 * `Ruleset` port (ADR-003, `07_MVP_MECHANICS_SPEC` §7, A6).
 *
 * Коэффициенты приходят в домен только отсюда — захардкоженные числа внутри `decide`/`evolve`
 * запрещены. Первый slice (§11) сам по себе не считает вероятности или экономику, поэтому пока
 * `Ruleset` отдаёт только версии, которыми `decide` обязан подписывать каждое произведённое
 * событие (`schema_version`, `rules_version`, `content_version` — §4, `world-event.ts`).
 * Дальнейшие коэффициенты (энергия, время в пути как формула, а не поле контента, и т.д.)
 * добавляются в `RulesetVersions`/`Ruleset` вместе с итерацией, которая их вводит — не заранее.
 */

export interface RulesetVersions {
  /** Совпадает с `ENVELOPE_SCHEMA_VERSION` контракта на момент выпуска этого ruleset. */
  readonly schemaVersion: number;
  /** Semantic version вида MAJOR.MINOR.PATCH (`SemanticVersionSchema`). */
  readonly rulesVersion: string;
  readonly contentVersion: string;
}

export interface Ruleset {
  readonly versions: RulesetVersions;
}

export class FixedRuleset implements Ruleset {
  readonly versions: RulesetVersions;

  constructor(versions: RulesetVersions) {
    this.versions = versions;
  }
}

/** Версии для тестов и dev-фикстур I01: первая версия правил и контента. */
export function testRulesetVersions(): RulesetVersions {
  return { schemaVersion: 1, rulesVersion: '0.1.0', contentVersion: '0.1.0' };
}
