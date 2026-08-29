/**
 * `Ruleset` port (ADR-003, `07_MVP_MECHANICS_SPEC` §7, A6).
 *
 * Коэффициенты приходят в домен только отсюда — захардкоженные числа внутри `decide`/`evolve`
 * запрещены. До I04 `Ruleset` отдавал только версии, которыми `decide` подписывает каждое
 * произведённое событие; I04 добавил первые НАСТОЯЩИЕ коэффициенты — скорость роста нужд и
 * пороги §5.
 *
 * ## Почему смена коэффициентов обязана менять `rulesVersion`
 *
 * Rules bundle снимка хешируется от СОДЕРЖИМОГО ruleset, а не от одной его версии
 * (`rulesBundleContent`, M3/A9). Изменить коэффициент, не сменив версию, значит получить два
 * разных мира под одним именем правил — и обнаружить это только расхождением checksum в
 * третьем месте. Поэтому версия правил поднята до `0.2.0` вместе с появлением коэффициентов, а
 * `rulesetFor` отказывается собирать ruleset для чужой версии ГРОМКО: мир, записанный по другим
 * правилам, нельзя продолжать по этим, и молчаливая подстановка была бы подделкой истории.
 */
import type { NeedKind } from '@zona/contracts';
import { requireValidNeedConfig, type NeedConfig } from '../needs.ts';

export interface RulesetVersions {
  /** Совпадает с `ENVELOPE_SCHEMA_VERSION` контракта на момент выпуска этого ruleset. */
  readonly schemaVersion: number;
  /** Semantic version вида MAJOR.MINOR.PATCH (`SemanticVersionSchema`). */
  readonly rulesVersion: string;
  readonly contentVersion: string;
}

export interface Ruleset {
  readonly versions: RulesetVersions;
  /** Коэффициенты нужд §5: скорость роста и пороги. Ключ — вид нужды. */
  readonly needs: Readonly<Record<NeedKind, NeedConfig>>;
  /**
   * Сколько мировых минут занимает полный отдых (I05).
   *
   * Живёт рядом с нуждами, но НЕ внутри `NeedConfig`: это цена ДЕЙСТВИЯ, а не свойство нужды.
   * Разница станет видна, когда появится второй способ снять усталость — например, короткий
   * привал: у него будет своя цена при тех же порогах усталости.
   */
  readonly restMinutes: number;
}

/**
 * Текущая версия правил. Единственный литерал версии в домене: `PROTOTYPE_RULESET_VERSIONS` в
 * `@zona/content` обязан ему соответствовать, и это проверяется тестом в `apps/cli`, а не
 * надеждой — content не имеет права импортировать domain, поэтому общего литерала быть не может,
 * а расхождение двух литералов уже стоило проекту неработающего worker-а (m13 аудита I03).
 */
export const RULES_VERSION = '0.3.0';

/**
 * Коэффициенты нужд прототипа.
 *
 * Голод: сутки мирового времени от сытости до предела, то есть `warning` через 10 ч 48 мин и
 * `critical` через 18 часов. Усталость: 16 часов, то есть `warning` через 7 ч 12 мин.
 * Числа — стартовая конфигурация (§«числовые коэффициенты являются стартовыми конфигурациями»),
 * и менять их можно только вместе с `RULES_VERSION`.
 */
/**
 * Восемь мировых часов на полный отдых.
 *
 * Число выбрано так, чтобы отдых был ЗАМЕТНО дороже еды и выбор между ними имел содержание:
 * еда мгновенна, отдых занимает треть суток. При усталости, растущей за 16 часов, это значит,
 * что отдыхать приходится примерно половину времени бодрствования.
 */
export const PROTOTYPE_REST_MINUTES = 480;

export const PROTOTYPE_NEEDS: Readonly<Record<NeedKind, NeedConfig>> = {
  hunger: requireValidNeedConfig(
    { minutesToFull: 1440, warningAtPermille: 450, criticalAtPermille: 750 },
    'hunger',
  ),
  fatigue: requireValidNeedConfig(
    { minutesToFull: 960, warningAtPermille: 450, criticalAtPermille: 750 },
    'fatigue',
  ),
};

export class FixedRuleset implements Ruleset {
  readonly versions: RulesetVersions;
  readonly needs: Readonly<Record<NeedKind, NeedConfig>>;
  readonly restMinutes: number;

  constructor(
    versions: RulesetVersions,
    needs: Readonly<Record<NeedKind, NeedConfig>>,
    restMinutes: number,
  ) {
    if (!Number.isSafeInteger(restMinutes) || restMinutes <= 0) {
      throw new Error(
        `ruleset: restMinutes обязан быть положительным целым числом минут, получено ${String(restMinutes)}`,
      );
    }
    this.versions = versions;
    this.needs = needs;
    this.restMinutes = restMinutes;
  }
}

/**
 * Ruleset для мира с этими версиями. Отказ громкий и по названной причине: коэффициенты для
 * чужой версии правил неизвестны, а подставить свои значило бы продолжить мир по правилам, по
 * которым он не записан.
 */
export function rulesetFor(versions: RulesetVersions): Ruleset {
  if (versions.rulesVersion !== RULES_VERSION) {
    throw new Error(
      `ruleset: мир записан по правилам ${versions.rulesVersion}, а этот код знает только ` +
        `${RULES_VERSION}; коэффициенты чужой версии неизвестны и не подставляются молча`,
    );
  }
  return new FixedRuleset(versions, PROTOTYPE_NEEDS, PROTOTYPE_REST_MINUTES);
}

/** Версии для тестов и dev-фикстур: текущая версия правил и первая версия контента. */
export function testRulesetVersions(): RulesetVersions {
  return { schemaVersion: 1, rulesVersion: RULES_VERSION, contentVersion: '0.1.0' };
}

/** Ruleset для тестов и dev-фикстур. */
export function testRuleset(): Ruleset {
  return new FixedRuleset(testRulesetVersions(), PROTOTYPE_NEEDS, PROTOTYPE_REST_MINUTES);
}
