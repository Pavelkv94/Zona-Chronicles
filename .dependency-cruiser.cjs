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
      name: 'core-has-no-adapter-dependencies',
      severity: 'error',
      comment: 'ADR-003: домен и симуляция не знают о БД, HTTP и логгере.',
      from: { path: `^${core}/` },
      // Матчим и резолвленный путь в node_modules, и голое имя модуля: незаявленная
      // зависимость не резолвится (dependencyTypes: unknown), и ограничение по типу
      // делало это правило инертным ровно в самом опасном случае.
      to: {
        path: '(^|node_modules/)(@fastify/|(fastify|kysely|pg|pino|next|react|maplibre-gl)($|/))',
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
