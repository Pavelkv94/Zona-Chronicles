/**
 * Границы пакетов по ADR-002. Правила исполняются инструментом, а не инструкцией агенту (ADR-008).
 *
 *   contracts <- domain <- simulation
 *        ^          ^          ^
 *    api/web   persistence  worker/cli
 *        ^          ^          |
 *        └──── projections <───┘
 *
 *   representation -> contracts + read-only projections
 */
const core = 'packages/(domain|simulation)';

/**
 * ГДЕ ЖИВЁТ allow-list внешних импортов ядра — и почему НЕ здесь (N-5 аудита I02A).
 *
 * Попытка выразить его правилом dependency-cruiser оказалась полностью инертной, и это
 * проверено исполнением: ни `@testcontainers/postgresql` (установлен, резолвится), ни
 * `left-pad` (не установлен) такое правило не ловит. Причина в `options.exclude` ниже —
 * `node_modules` исключён из графа, поэтому внешняя зависимость, которая РЕЗОЛВИТСЯ, вообще
 * не становится ребром. Существующее правило `core-has-no-adapter-dependencies` работает лишь
 * потому, что `kysely`/`pg` в ядре не установлены и остаются нерезолвимыми голыми именами.
 *
 * Инертное правило хуже отсутствующего: оно создаёт уверенность, которой не подкреплено.
 * Поэтому allow-list живёт в `eslint.config.mjs` (`coreExternalAllowlist`), который работает с
 * ТЕКСТОМ спецификатора до резолва, и в `scripts/boundaries/check-workspace-graph.ts`, который
 * проверяет декларации в манифестах. Проверено: eslint ловит все четыре пробы —
 * `@testcontainers/postgresql`, `nanoid`, `luxon`, `undici`.
 */

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Циклы между модулями делают replay и владение файлами непроверяемыми.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'contracts-are-leaf',
      severity: 'error',
      comment: 'packages/contracts не импортирует внутренние пакеты приложения (ADR-002).',
      from: { path: '^packages/contracts/' },
      to: { path: '^(packages/(?!contracts/)|apps/|tools/|scripts/|tests/)' },
    },
    {
      name: 'domain-depends-on-contracts-only',
      severity: 'error',
      comment: 'packages/domain зависит только от contracts (ADR-003).',
      from: { path: '^packages/domain/' },
      to: { path: '^(packages/(?!contracts/|domain/)|apps/|tools/|scripts/|tests/)' },
    },
    {
      name: 'simulation-depends-on-contracts-and-domain',
      severity: 'error',
      from: { path: '^packages/simulation/' },
      to: { path: '^(packages/(?!contracts/|domain/|simulation/)|apps/|tools/|scripts/|tests/)' },
    },
    {
      name: 'persistence-does-not-import-simulation',
      severity: 'error',
      comment: 'Persistence не дублирует доменные правила и не тянет планировщик.',
      from: { path: '^packages/persistence/' },
      to: { path: '^(packages/(simulation|projections|representation)/|apps/|scripts/)' },
    },
    {
      name: 'representation-reads-projections-only',
      severity: 'error',
      comment: 'ADR-005: representation работает поверх contracts и read-only projections.',
      from: { path: '^packages/representation/' },
      to: { path: '^(packages/(domain|simulation|persistence|testkit)/|apps/|scripts/)' },
    },
    {
      name: 'content-is-data-only',
      severity: 'error',
      comment: 'packages/content — входные данные, а не исполняемая логика.',
      from: { path: '^packages/content/' },
      to: { path: '^(packages/(?!content/)|apps/|tools/|scripts/|tests/)' },
    },
    {
      name: 'observer-api-does-not-reach-persistence',
      severity: 'error',
      comment:
        'OPS-03: observer path не должен иметь физической возможности читать канонические таблицы. ' +
        'Правило транзитивное (`reachable: true`, major M-1, раунд 3 верификации I00): запрет по ' +
        'смыслу распространяется на весь путь до persistence, а не только на прямое ребро — иначе ' +
        'один легальный промежуточный пакет (например packages/projections), случайно или ' +
        'преждевременно получивший зависимость на packages/persistence, тихо снимает запрет для ' +
        'apps/api. ADR-002 не даёт api прямого ребра к persistence; данные приходят только через ' +
        'read-only projections, которые сами не должны транзитивно протаскивать канонические таблицы.',
      from: { path: '^apps/api/' },
      to: { path: '^packages/persistence/', reachable: true },
    },
    {
      name: 'packages-do-not-depend-on-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'packages-do-not-depend-on-scripts-or-tests',
      severity: 'error',
      comment:
        'scripts/ и tests/ не являются продуктовым кодом и не могут быть маршрутом обхода границ.',
      from: { path: '^packages/' },
      to: { path: '^(scripts/|tests/)' },
    },
    {
      name: 'packages-do-not-depend-on-tools',
      severity: 'error',
      comment: 'tools/* — dev harness, он не входит в продукт.',
      from: { path: '^packages/' },
      to: { path: '^tools/' },
    },
    {
      name: 'apps-do-not-depend-on-scripts-or-tests',
      severity: 'error',
      comment:
        'Симметрично packages-do-not-depend-on-scripts-or-tests (major M-1, раунд 3 верификации ' +
        'I00): apps/** ограничивался ADR-002 только правилом про persistence, но не про scripts/ ' +
        'и tests/, поэтому apps мог использовать их как необъявленный обходной путь к чему угодно.',
      from: { path: '^apps/' },
      to: { path: '^(scripts/|tests/)' },
    },
    {
      name: 'apps-do-not-depend-on-tools',
      severity: 'error',
      comment:
        'Симметрично packages-do-not-depend-on-tools (major M-1, раунд 3 верификации I00): tools/* ' +
        '— dev harness, не входит в продукт ни для packages, ни для apps.',
      from: { path: '^apps/' },
      to: { path: '^tools/' },
    },
    {
      name: 'core-has-no-adapter-dependencies',
      severity: 'error',
      comment:
        'ADR-003 (SIM-01, правка от 2026-08-21): домен и симуляция не знают о БД, HTTP, логгере, ' +
        'сети, файловой системе, процессе, crypto/perf_hooks. Запрет описывает источник ' +
        'недетерминизма, а не форму импорта: node: и голое имя core-модуля запрещены одинаково, ' +
        'иначе `import { randomUUID } from "node:crypto"` проходит незамеченным (blocker B-2, ' +
        'раунд 3 верификации I00). Этот же перечень независимо продублирован в eslint.config.mjs ' +
        '(no-restricted-imports) — оба контроля должны срабатывать на один и тот же вход.',
      from: { path: `^${core}/` },
      // Матчим и резолвленный путь в node_modules (сторонние пакеты), и голое имя модуля:
      // незаявленная зависимость не резолвится (dependencyTypes: unknown), и ограничение по типу
      // делало это правило инертным ровно в самом опасном случае. Node builtins резолвятся
      // dependency-cruiser в голую форму без префикса `node:` (подтверждено прогоном), поэтому
      // вторая альтернатива матчит их по имени с необязательным подпутём (fs/promises и т.п.).
      to: {
        path:
          '(^|node_modules/)(@fastify/|(fastify|kysely|pg|pino|next|react|maplibre-gl)($|/))' +
          '|^(crypto|perf_hooks|fs|http|https|net|tls|dgram|http2|dns|process|os|child_process|worker_threads)($|/)',
      },
    },
    {
      name: 'no-runtime-llm-anywhere',
      severity: 'error',
      comment: 'ADR-006: до Gate E в репозитории нет LLM SDK.',
      from: {},
      to: {
        path: '(^|node_modules/)(@anthropic-ai/|@google/(generative-ai|genai)|@mistralai/|@langchain/|@huggingface/|(openai|cohere-ai|ollama|langchain|llamaindex)($|/))',
      },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'Нерезолвимый импорт означает незаявленную зависимость: без этого правила запреты по имени модуля молча не срабатывают.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys)$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|coverage|\\.turbo)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
