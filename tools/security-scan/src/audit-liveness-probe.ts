/**
 * Liveness-проба audit endpoint: это runtime-артефакт проверки, а не тестовая фикстура.
 * Каталог `__fixtures__` исключён из сборки как test-only, поэтому проба живёт рядом
 * с production-кодом скана (обнаружено сборкой при интеграции I00-R3).
 */
/**
 * Fixture для B1 (audit endpoint liveness probe, ADR-008).
 *
 * `pnpm audit --json` возвращает `{"advisories": {}, "metadata": {...}}` — валидный
 * JSON — как честно чистый результат, так и когда registry вернул пустую заглушку
 * (не отличить по форме). Перед тем как доверять пустому набору advisories,
 * `scan-dependencies.ts` прогоняет ЭТОТ фикстурный проект (изолированный, вне
 * pnpm workspace репозитория — иначе pnpm поднимется до корневого
 * `pnpm-workspace.yaml` и проаудирует весь монорепозиторий вместо фикстуры) через
 * тот же `pnpm audit --json`, и ожидает НЕНУЛЕВОЕ количество advisories.
 *
 * `minimatch@3.0.4` пин — историческая, давно исправленная (>=3.0.5/3.1.3/3.1.4)
 * ReDoS-уязвимость (GHSA-f8q6-p94x-37v3 и др.), которая остаётся в advisory-базе
 * навсегда как факт истории конкретной версии: реального сетевого запроса к
 * реальному npm audit endpoint достаточно, чтобы получить эти advisories обратно.
 * Если проба вернула 0 advisories для ЭТОГО пина — endpoint не подтверждён живым.
 *
 * Границы пробы (задокументировано также в scan-dependencies.ts и в отчёте):
 * - подтверждает, что audit endpoint СЕЙЧАС отвечает реальными данными по тому же
 *   registry/пути, что и основной запрос — не то, что основной запрос конкретно
 *   для графа зависимостей репозитория отработал корректно;
 *   любой сравнимый по риску механизм столкнётся с тем же ограничением;
 * - не защищает от скомпрометированного registry, который намеренно отвечает
 *   правильно на этот конкретный фикстурный пакет, но лжёт по остальному графу;
 * - зависит от того, что запись об этих advisories не будет вычищена из БД —
 *   практически такого не происходит (это подтверждённая историческая уязвимость
 *   конкретной опубликованной версии), но не является логической гарантией навечно;
 * - lockfile сгенерирован один раз (`pnpm install --lockfile-only`) и закоммичен;
 *   проба не требует сетевого install/resolve, только сетевой audit-запрос.
 */

export const AUDIT_LIVENESS_FIXTURE_PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'zona-audit-liveness-fixture',
    version: '0.0.0',
    private: true,
    dependencies: {
      minimatch: '3.0.4',
    },
  },
  null,
  2,
)}\n`;

export const AUDIT_LIVENESS_FIXTURE_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      minimatch:
        specifier: 3.0.4
        version: 3.0.4

packages:

  balanced-match@1.0.2:
    resolution: {integrity: sha512-3oSeUO0TMV67hN1AmbXsK4yaqU7tjiHlbxRDZOpH0KW9+CeX4bRAaX0Anxt0tx2MrpRpWwQaPwIlISEJhYU5Pw==}

  brace-expansion@1.1.18:
    resolution: {integrity: sha512-Edep/X9fGqVNmzKBVsDYIOtD+z1tuezV70LBjdCst9Tqu76lsnvRiZ6oTic1n+/BIwX6QDGAO94PN4N2SADvtw==}

  concat-map@0.0.1:
    resolution: {integrity: sha512-/Srv4dswyQNBfohGpz9o6Yb3Gz3SrUDqBH5rTuhGR7ahtlbYKnVxw2bCFMRljaA7EXHaXZ8wsHdodFvbkhKmqg==}

  minimatch@3.0.4:
    resolution: {integrity: sha512-yJHVQEhyqPLUTgt9B83PXu6W3rx4MvvHvSUvToogpwoGDOUQ+yDrR0HRot+yOCdCO7u4hX3pWft6kWBBcqh0UA==}

snapshots:

  balanced-match@1.0.2: {}

  brace-expansion@1.1.18:
    dependencies:
      balanced-match: 1.0.2
      concat-map: 0.0.1

  concat-map@0.0.1: {}

  minimatch@3.0.4:
    dependencies:
      brace-expansion: 1.1.18
`;
