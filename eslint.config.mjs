// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Запрещённые конструкции ядра симуляции (SIM-01, ADR-003).
 * Домен получает время, случайность и конфигурацию только через инъектированные порты.
 */
/**
 * M2 верификации I01. Прежние селекторы были завязаны на `object.name` + `property.name`,
 * поэтому мимо них проходили: computed-доступ (`Date['now']()`), обращение через
 * `globalThis.*` и алиас (`const D = Date; D.now()`). Проверено исполнением: файл с этими
 * тремя формами давал `eslint` exit 0 и `boundaries:check` без нарушений.
 *
 * Закрыты первые две формы. **Алиасинг остаётся известным пределом контроля**: поймать
 * `const D = Date` можно только type-aware правилом, которого здесь нет. Это записано в
 * ADR-003 как предел, а не подразумевается закрытым — недоказанное абсолютное правило хуже
 * задокументированного частичного.
 */
/**
 * ALLOW-LIST внешних импортов канонического ядра (N-5 повторного аудита I02A).
 *
 * Перечисления запрещённого недостаточно: незаявленный импорт корневой devDependency —
 * например `@testcontainers/postgresql`, то есть Docker, сеть и настоящий PostgreSQL —
 * не ловил НИ ОДИН контроль. Manifest-проверка молчала (не объявлено), dependency-cruiser
 * молчал (резолвится в `node_modules`, а `node_modules` исключён из его графа —
 * подтверждено исполнением), `no-unresolvable` молчал (резолвится).
 *
 * eslint работает с ТЕКСТОМ спецификатора импорта, до резолва, поэтому здесь запрет
 * выразим как allow-list: разрешены относительные пути, workspace-пакеты и короткий
 * список внешних. Всё остальное — ошибка.
 *
 * `@zona/*` разрешены здесь, а не поимённо: направление рёбер между workspace-пакетами
 * проверяет `boundaries:check`, и дублировать его матрицу в eslint значило бы завести
 * второй источник правды, который разойдётся с первым.
 */
const CORE_ALLOWED_EXTERNAL_IMPORTS = ['@sinclair/typebox', 'vitest', 'fast-check'];

const coreExternalAllowlist = {
  // Разрешены: относительный путь (начинается с точки), `node:`-встроенные (их отдельно
  // ограничивает `adapterImportRestrictions`), workspace-пакеты и поимённо перечисленные
  // внешние — целиком или с подпутём. Всё остальное отвергается.
  regex: `^(?!(?:\\.|node:|@zona/)|(?:${CORE_ALLOWED_EXTERNAL_IMPORTS.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|')})(?:$|/))`,
  message:
    'ADR-003: каноническому ядру разрешены только относительные импорты, @zona/* и явно ' +
    `перечисленные внешние пакеты (${CORE_ALLOWED_EXTERNAL_IMPORTS.join(', ')}). ` +
    'Перечисление запрещённого не может быть полным; перечисление разрешённого может.',
};

const nondeterminismRestrictions = [
  {
    selector:
      "MemberExpression[computed=true][object.name='Date'][property.value=/^(now|parse|UTC)$/]",
    message: 'SIM-01: computed-доступ к Date.now/parse/UTC запрещён так же, как обычный.',
  },
  {
    selector: "MemberExpression[computed=true][object.name='Math'][property.value='random']",
    message: 'SIM-01: computed-доступ к Math.random запрещён так же, как обычный.',
  },
  {
    selector: "MemberExpression[object.name='globalThis']",
    message:
      'SIM-01/ADR-003: обращение к globalThis в каноническом ядре запрещено — оно обходит запреты на Date, Math.random, crypto и process.',
  },
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
    files: [
      'packages/domain/**/*.ts',
      'packages/simulation/**/*.ts',
      'packages/contracts/**/*.ts',
      'packages/content/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...nondeterminismRestrictions],
      'no-restricted-globals': ['error', ...nondeterminismGlobals],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...adapterImportRestrictions.patterns,
            ...llmImportRestrictions.patterns,
            coreExternalAllowlist,
          ],
        },
      ],
    },
  },
  {
    /**
     * ACCEPTANCE C10 (I02B): replay применяет УЖЕ ЗАПИСАННЫЕ факты и не принимает решений
     * заново. Свойство структурное — replay есть свёртка `evolve`, а `evolve` чист и источника
     * случайности не принимает, — но структурный довод держится только пока replay остаётся
     * свёрткой. Здесь он превращён в контроль, который упадёт в день, когда конструкция
     * изменится.
     *
     * Почему eslint, а не dependency-cruiser. Сначала запрет был правилом графа зависимостей с
     * `reachable: true`, и он оказался НЕВЫПОЛНИМЫМ: `depcruise` строит граф по файлам, а
     * `@zona/domain` — баррель, реэкспортирующий и `evolve`, и `decide` из одного `index.ts`.
     * Любая реализация replay, которой нужен `evolve`, транзитивно «достигает» `decide` — то
     * есть правило падало и на ПРАВИЛЬНОМ коде. Моя проба этого не показала, потому что я
     * проверил только направление «нарушение ловится», не проверив «корректный код проходит».
     * Нашёл исполнитель I02B-T3.
     *
     * eslint видит ИМЕНОВАННЫЕ импорты, а не файлы, поэтому здесь запрет выражается точно:
     * `evolve` можно, `decide` и источники случайности — нет.
     *
     * M6 (аудит I02B): привязка была к ОДНОМУ файлу, `packages/persistence/src/replay.ts`. Второй
     * replay — в другом пакете, в подкаталоге, под другим именем — не был бы ограничен ничем, и
     * заметить это было бы нечем: правило молчит одинаково и когда нарушения нет, и когда файла
     * для него не существует.
     *
     * Привязка расширена до соглашения об именовании. Она честно слабее, чем хотелось бы, и предел
     * записан здесь, а не подразумевается: replay, реализованный в файле с ЛЮБЫМ другим именем,
     * из-под правила уходит. Сильнее выразить нельзя — запретить `decide` всему пакету
     * `persistence` невозможно, `command-handler.ts` вызывает его законно и обязан вызывать. Если
     * появится третий путь исполнения записанных фактов, он либо назовётся по соглашению, либо
     * должен быть добавлен сюда явным перечислением.
     *
     * Обе стороны правила покрыты фикстурами в `tools/agent-harness/src/boundary-fixtures.test.ts`
     * (ADR-003: правило без фикстуры считается несуществующим).
     */
    files: ['**/replay.ts', '**/replay/**/*.ts', '**/replay-*.ts', '**/*-replay.ts'],
    // Каноническое ядро исключено намеренно, и это не косметика: правила eslint не сливаются, а
    // ПЕРЕОПРЕДЕЛЯЮТСЯ целиком, поэтому файл `packages/domain/src/replay.ts` попал бы сюда и
    // потерял бы вместе с этим весь набор детерминистских запретов ядра (adapter-импорты,
    // источники недетерминизма). Replay в ядре и не место: `evolve` там, свёртка — в persistence.
    ignores: [
      '**/*.test.ts',
      'packages/domain/**/*.ts',
      'packages/simulation/**/*.ts',
      'packages/contracts/**/*.ts',
      'packages/content/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // Тот же довод о переопределении, но уже про базовый слой: без явного повторения
          // `llmImportRestrictions` запрет ADR-006 молча исчезал бы именно в replay-файлах.
          // Так и было до M6 — для единственного `packages/persistence/src/replay.ts`.
          patterns: [...llmImportRestrictions.patterns],
          paths: [
            {
              name: '@zona/domain',
              importNames: ['decide', 'DeterministicRandomSource', 'RandomSource'],
              message:
                'ACCEPTANCE C10: replay применяет записанные факты, а не принимает решения ' +
                'заново. Повторный decide означал бы, что outcome вычисляется снова, и ' +
                'одинаковый журнал перестал бы давать одинаковый мир (SIM-01).',
            },
          ],
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
