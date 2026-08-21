// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Запрещённые конструкции ядра симуляции (SIM-01, ADR-003).
 * Домен получает время, случайность и конфигурацию только через инъектированные порты.
 */
const nondeterminismRestrictions = [
  {
    selector: "MemberExpression[object.name='Date'][property.name=/^(now|parse|UTC)$/]",
    message: 'SIM-01: используйте инъектированный Clock port вместо Date.now/Date.parse/Date.UTC.',
  },
  {
    // `new Date(iso)` детерминирован и разрешён; запрещено только чтение системных часов.
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'SIM-01: `new Date()` читает системные часы; берите world time из Clock port.',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: 'SIM-01: используйте инъектированный RandomSource port вместо Math.random().',
  },
  {
    selector: "MemberExpression[object.name='process']",
    message:
      'ADR-003: домен не обращается к process (env, hrtime, argv); конфигурация приходит через Ruleset/ports.',
  },
  {
    selector: "MemberExpression[object.name='performance'][property.name='now']",
    message: 'SIM-01: wall clock запрещён в каноническом ядре.',
  },
  {
    selector: "MemberExpression[object.name='crypto']",
    message:
      'SIM-01: crypto.randomUUID/getRandomValues недетерминированы; используйте IdFactory и RandomSource ports.',
  },
  {
    selector: "CallExpression[callee.name='fetch']",
    message:
      'ADR-003: сеть в каноническом ядре запрещена. `fetch` — глобал и не ловится запретом импорта.',
  },
  {
    selector: "MemberExpression[object.name='Intl']",
    message: 'SIM-01: locale-зависимое поведение не должно влиять на канонический результат.',
  },
  {
    selector:
      'MemberExpression[property.name=/^(toLocaleString|toLocaleDateString|toLocaleTimeString|toLocaleLowerCase|toLocaleUpperCase|localeCompare)$/]',
    message:
      'SIM-01: locale-зависимые форматирование и сравнение меняют результат между машинами; используйте явные детерминированные функции.',
  },
  {
    selector: 'TSEnumDeclaration',
    message: 'ADR-002: TypeScript enum запрещён, используйте union of literals + const map.',
  },
  {
    selector: 'TSModuleDeclaration[kind="namespace"]',
    message: 'ADR-002: runtime namespaces запрещены.',
  },
  {
    selector: 'Decorator',
    message: 'ADR-002: decorators запрещены.',
  },
];

/** Структурные запреты ADR-002, обязательные во всех пакетах и приложениях. */
const structuralRestrictions = [
  {
    selector: 'TSEnumDeclaration',
    message: 'ADR-002: TypeScript enum запрещён, используйте union of literals + const map.',
  },
  {
    selector: 'TSModuleDeclaration[kind="namespace"]',
    message: 'ADR-002: runtime namespaces запрещены.',
  },
  {
    selector: 'Decorator',
    message: 'ADR-002: decorators запрещены.',
  },
];

/** Глобалы, которых каноническое ядро не должно касаться напрямую (ADR-003, SIM-01). */
const nondeterminismGlobals = [
  { name: 'fetch', message: 'ADR-003: сеть в каноническом ядре запрещена.' },
  { name: 'XMLHttpRequest', message: 'ADR-003: сеть в каноническом ядре запрещена.' },
  { name: 'WebSocket', message: 'ADR-003: сеть в каноническом ядре запрещена.' },
  { name: 'crypto', message: 'SIM-01: используйте IdFactory и RandomSource ports.' },
  { name: 'Intl', message: 'SIM-01: locale не должна влиять на канонический результат.' },
  { name: 'process', message: 'ADR-003: конфигурация приходит через Ruleset/ports.' },
  { name: 'performance', message: 'SIM-01: wall clock запрещён в каноническом ядре.' },
];

/**
 * Пакеты-адаптеры и источники недетерминизма, запрещённые к импорту из ядра (ADR-002, ADR-003,
 * правка SIM-01 от 2026-08-21, blocker B-2 третьего раунда верификации I00).
 *
 * Запрет описывает источник недетерминизма, а не синтаксическую форму обращения к нему: и `node:`,
 * и голая форма модуля запрещены одновременно, иначе `import { randomUUID } from 'node:crypto'`
 * проходит мимо `no-restricted-globals`, который ловит только глобал `crypto`. Тот же список
 * одновременно закрывается regex-правилом `core-has-no-adapter-dependencies` в
 * `.dependency-cruiser.cjs` — это независимый второй контроль на тот же перечень источников.
 */
const adapterImportRestrictions = {
  patterns: [
    {
      group: [
        'fastify',
        'fastify/*',
        '@fastify/*',
        'kysely',
        'kysely/*',
        'pg',
        'pg/*',
        'next',
        'next/*',
        'react',
        'react/*',
        'pino',
        'pino/*',
        // Файловая система: node:fs и голая форма, включая подпути (fs/promises и т.п.).
        'node:fs',
        'node:fs/*',
        'fs',
        'fs/*',
        // Сеть.
        'node:http',
        'http',
        'node:https',
        'https',
        'node:net',
        'net',
        'node:tls',
        'tls',
        'node:dgram',
        'dgram',
        'node:http2',
        'http2',
        'node:dns',
        'dns',
        // Процесс и окружение.
        'node:child_process',
        'child_process',
        'node:process',
        'process',
        'node:os',
        'os',
        'node:worker_threads',
        'worker_threads',
        // Случайность и wall-clock источники недоступные через синтаксические селекторы выше.
        'node:crypto',
        'crypto',
        'node:perf_hooks',
        'perf_hooks',
      ],
      message:
        'ADR-003 (SIM-01): чистое ядро не импортирует адаптеры, сеть, файловую систему, процесс, ' +
        'crypto или perf_hooks — источник недетерминизма запрещён независимо от того, как он назван при импорте.',
    },
  ],
};

/** Запрет runtime LLM до Gate E (ADR-006, NAR-02). Действует на весь репозиторий. */
const llmImportRestrictions = {
  patterns: [
    {
      group: [
        '@anthropic-ai/*',
        'openai',
        'openai/*',
        '@google/generative-ai',
        '@google/genai',
        'cohere-ai',
        '@mistralai/*',
        'ollama',
        'langchain',
        'langchain/*',
        '@langchain/*',
        'llamaindex',
        '@huggingface/*',
      ],
      message:
        'ADR-006: runtime LLM SDK запрещены до Gate E. Основной прототип использует только детерминированные шаблоны.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.d.ts',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-restricted-imports': ['error', llmImportRestrictions],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'ADR-002: TypeScript enum запрещён, используйте union of literals + const map.',
        },
        {
          selector: 'TSModuleDeclaration[kind="namespace"]',
          message: 'ADR-002: runtime namespaces запрещены.',
        },
        {
          selector: 'Decorator',
          message: 'ADR-002: decorators запрещены.',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Каноническое ядро: дополнительные детерминистские запреты.
    files: ['packages/domain/**/*.ts', 'packages/simulation/**/*.ts', 'packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...nondeterminismRestrictions],
      'no-restricted-globals': ['error', ...nondeterminismGlobals],
      'no-restricted-imports': [
        'error',
        {
          patterns: [...adapterImportRestrictions.patterns, ...llmImportRestrictions.patterns],
        },
      ],
    },
  },
  {
    // Приложения читают окружение только через валидируемый allowlist в собственном config.ts.
    files: ['apps/*/src/**/*.ts'],
    ignores: ['apps/*/src/config.ts', 'apps/*/src/config.test.ts'],
    rules: {
      // Правила ESLint не сливаются, а переопределяются целиком: базовые запреты
      // ADR-002 обязаны повторяться здесь явно, иначе они молча исчезают для apps/**.
      'no-restricted-syntax': [
        'error',
        ...structuralRestrictions,
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'process.env читается только в config.ts приложения, где есть allowlist и валидация (§12 03_TECHNICAL_DESIGN).',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/tests/**/*.ts', 'tools/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // Конфиги и служебные скрипты вне TS-проектов: без type-aware правил и без project service.
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },
  prettier,
);
