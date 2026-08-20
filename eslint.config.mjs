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
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message: 'SIM-01: используйте инъектированный Clock port вместо Date.now().',
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'SIM-01: используйте инъектированный Clock port вместо new Date().',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: 'SIM-01: используйте инъектированный RandomSource port вместо Math.random().',
  },
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: 'ADR-003: домен не читает process.env; конфигурация приходит через Ruleset/ports.',
  },
  {
    selector: "MemberExpression[object.name='performance'][property.name='now']",
    message: 'SIM-01: wall clock запрещён в каноническом ядре.',
  },
];

/** Пакеты-адаптеры, запрещённые к импорту из ядра (ADR-002, ADR-003). */
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
        'node:fs',
        'node:fs/*',
        'node:http',
        'node:https',
        'node:net',
        'node:child_process',
        'node:process',
        'fs',
        'http',
        'https',
        'net',
        'child_process',
      ],
      message: 'ADR-003: чистое ядро не импортирует адаптеры, сеть, файловую систему и процесс.',
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
      'no-restricted-syntax': [
        'error',
        ...nondeterminismRestrictions,
        {
          selector: 'TSEnumDeclaration',
          message: 'ADR-002: TypeScript enum запрещён.',
        },
        {
          selector: 'TSModuleDeclaration[kind="namespace"]',
          message: 'ADR-002: runtime namespaces запрещены.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [...adapterImportRestrictions.patterns, ...llmImportRestrictions.patterns],
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
