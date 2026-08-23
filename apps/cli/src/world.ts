/**
 * Мир прототипа: тонкая обёртка над генератором из `@zona/simulation` (I03).
 *
 * До I03 здесь жила сама генерация. Она переехала в пакет, как только понадобилась ВТОРОМУ
 * приложению: сборщику проекции нужны те же `bundles`, чтобы прочитать генезисный снимок, а
 * приложения не имеют права импортировать друг друга. Подробности решения — в докстринге
 * `packages/simulation/src/world-generation.ts` и в `PLAN.md` §10.3 итерации I03.
 *
 * Здесь осталось ровно то, что принадлежит ПРИЛОЖЕНИЮ:
 *
 * - чтение профиля хоста (`process.version` — в пакете запрещён, ADR-003);
 * - привязка генератора к КОНКРЕТНОМУ контенту (`PROTOTYPE_WORLD`): пакету знать, какой именно
 *   мир он порождает, не положено.
 *
 * Сигнатуры не изменились: `seedWorld(seed)`, `currentBundles()`,
 * `currentDeterministicRuntimeProfile()` вызываются как раньше, поэтому ни один из существующих
 * вызовов не потребовал правки.
 */
import {
  CONTENT_VERSION,
  PROTOTYPE_RULESET_VERSIONS,
  PROTOTYPE_WORLD,
  type WorldDefinition,
} from '@zona/content';
import type { DeterministicRuntimeProfile, Snapshot } from '@zona/contracts';
import type { RulesetVersions } from '@zona/domain';
import {
  bundlesFor,
  deterministicRuntimeProfileFor,
  seedWorld as generateWorld,
  type HostRuntimeProfile,
  type SeededWorld,
} from '@zona/simulation';

export type { HostRuntimeProfile, SeededWorld };
export { rulesBundleContent } from '@zona/simulation';

/**
 * Профиль текущего процесса. Node/ICU одинаковы в рамках хоста независимо от TZ/LC_ALL (A3).
 *
 * Живёт в приложении, а не в пакете: `process` — источник недетерминизма, и ядру он запрещён.
 * Инъекция нужна и по второй причине, записанной ещё в I01: профиль не входит в snapshot
 * checksum, и это свойство обязано быть проверяемым тестом, подставляющим чужой хост, а не
 * второй машиной.
 */
export function currentHostRuntimeProfile(): HostRuntimeProfile {
  return {
    nodeVersion: process.version.replace(/^v/, ''),
    icuVersion: process.versions['icu'] ?? 'unavailable',
  };
}

/**
 * Версии, которыми подписывается КАЖДОЕ событие мира прототипа.
 *
 * Источник ОДИН — `@zona/content`. Раньше версия контента жила двумя независимыми литералами
 * `'0.1.0'` (в контенте и в `testRulesetVersions()`), и совпадали они лишь потому, что контент не
 * менялся. Расширение мира в I03 их развело, и worker перестал читать генезисный снимок: он
 * собирал bundles со старой версией, checksum не сошёлся. Найдено E2E-прогоном, а не рассуждением.
 */
export function prototypeRulesetVersions(): RulesetVersions {
  return { ...PROTOTYPE_RULESET_VERSIONS };
}

/** `bundles` ровно одного снимка для мира прототипа. */
export function currentBundles(
  rulesetVersions: RulesetVersions = prototypeRulesetVersions(),
): Snapshot['bundles'] {
  return bundlesFor(PROTOTYPE_WORLD, CONTENT_VERSION, rulesetVersions);
}

/** `deterministic_runtime_profile` ровно одного снимка. */
export function currentDeterministicRuntimeProfile(
  host: HostRuntimeProfile = currentHostRuntimeProfile(),
): DeterministicRuntimeProfile {
  return deterministicRuntimeProfileFor(host);
}

/**
 * Строит детерминированный in-memory мир прототипа из seed. Тот же seed даёт побайтово тот же
 * `snapshot` в любом процессе (A1); разный seed даёт другой, но валидный мир (A2).
 */
export function seedWorld(
  seed: number,
  host: HostRuntimeProfile = currentHostRuntimeProfile(),
): PrototypeWorld {
  return generateWorld(
    PROTOTYPE_WORLD,
    CONTENT_VERSION,
    seed,
    host,
    prototypeRulesetVersions(),
  ) as PrototypeWorld;
}

/**
 * Результат генерации, суженный до КОНКРЕТНОГО контента.
 *
 * Пакет отдаёт `GeneratorContent` — минимальную форму, которая ему нужна. Здесь известно
 * больше: контент это ровно `PROTOTYPE_WORLD`, со всеми именами и описаниями. Сужение возвращает
 * вызывающим ту же типизацию, что была до переезда, поэтому ни одна из 76 существующих ссылок
 * не потребовала правки.
 */
export type PrototypeWorld = Omit<SeededWorld, 'content'> & { readonly content: WorldDefinition };
