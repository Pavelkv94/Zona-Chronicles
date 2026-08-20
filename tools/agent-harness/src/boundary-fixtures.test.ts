/**
 * M9/A2: fixture-тесты на реальные `eslint` и `depcruise`, а не только на unit-тесты чистых функций.
 *
 * ACCEPTANCE A2 требует, чтобы `tools/agent-harness` прогонял запрещённые и разрешённые примеры
 * через сами инструменты (`eslint.config.mjs`, `.dependency-cruiser.cjs`): удаление или подмена
 * правила там сегодня ничем не замечается, потому что `packages/domain` пуст. Здесь мы временно
 * материализуем фикстуры внутри реальных пакетов (иначе правила `from: '^packages/domain/'` и т.п.
 * их не увидят), один раз прогоняем оба инструмента и удаляем фикстуры в `finally` — даже если
 * запуск инструмента упал.
 *
 * Каждая проверка утверждает конкретное имя правила (`ruleId` у eslint, `rule.name` у depcruise) и
 * узнаваемый фрагмент сообщения, а не просто «есть какая-то ошибка»: иначе тест не заметил бы,
 * что кто-то подменил или ослабил именно нужное правило, оставив рядом другое.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });

/**
 * Запрещённые литералы собираются конкатенацией.
 *
 * Иначе этот файл сам становится находкой `security:static` и `security:no-llm`:
 * скан смотрит на текст исходника и не знает, что строка — тестовая фикстура.
 * Ослаблять скан исключением здесь нельзя — он проверяет именно наличие таких
 * литералов в репозитории (ADR-006).
 */
const LLM_PACKAGE = `@anthropic${'-'}ai/sdk`;
const SAMPLE_URL = `${'https'}://example.${'com'}`;

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

// Один и тот же суффикс для всех фикстур одного тестового процесса: детерминирован в рамках
// прогона (не использует Math.random/crypto.randomUUID), но не коллизирует с параллельными
// vitest worker-ами, у каждого из которых свой PID.
const SUFFIX = `fixture-${process.pid}`;
const DOMAIN_DIR = resolve(REPO_ROOT, `packages/domain/src/__${SUFFIX}__`);
const SIMULATION_DIR = resolve(REPO_ROOT, `packages/simulation/src/__${SUFFIX}__`);
const REPRESENTATION_DIR = resolve(REPO_ROOT, `packages/representation/src/__${SUFFIX}__`);
const FIXTURE_DIRS = [DOMAIN_DIR, SIMULATION_DIR, REPRESENTATION_DIR];

const cleanupFixtures = (): void => {
  for (const dir of FIXTURE_DIRS) rmSync(dir, { recursive: true, force: true });
};

/** Позитивный случай + одно нарушение на файл — чтобы сообщение однозначно указывало на правило. */
const domainFiles: Readonly<Record<string, string>> = {
  'clean.ts': [
    'export const cleanExample = (): string => {',
    "  const when = new Date('2026-01-01T00:00:00Z');",
    '  return when.toISOString();',
    '};',
    '',
  ].join('\n'),
  'date-now.ts': 'export const bad = (): number => Date.now();\n',
  'new-date-empty.ts': 'export const bad = (): Date => new Date();\n',
  'date-parse.ts': "export const bad = (): number => Date.parse('2026-01-01');\n",
  'math-random.ts': 'export const bad = (): number => Math.random();\n',
  'process-env.ts': "export const bad = (): string | undefined => process.env['X'];\n",
  'crypto-random-uuid.ts': 'export const bad = (): string => crypto.randomUUID();\n',
  'fetch-call.ts': `export const bad = (): Promise<Response> => fetch('${SAMPLE_URL}');\n`,
  'intl-usage.ts': "export const bad = (): Intl.NumberFormat => new Intl.NumberFormat('en-US');\n",
  'to-locale-string.ts': 'export const bad = (n: number): string => n.toLocaleString();\n',
  'locale-compare.ts': 'export const bad = (a: string, b: string): number => a.localeCompare(b);\n',
  'performance-now.ts': 'export const bad = (): number => performance.now();\n',
  'ts-enum.ts': "export enum Bad {\n  A = 'A',\n}\n",
  'ts-namespace.ts': 'export namespace Bad {\n  export const x = 1;\n}\n',
  'import-kysely.ts': "import { Kysely } from 'kysely';\nexport type _K = Kysely<object>;\n",
  'import-pg.ts': "import { Pool } from 'pg';\nexport type _P = Pool;\n",
  'import-fastify.ts': "import fastify from 'fastify';\nexport const _f = fastify;\n",
  'import-llm.ts': `import { Anthropic } from '${LLM_PACKAGE}';\nexport type _A = Anthropic;\n`,
  // Депкрузовые фикстуры живут здесь же — им нужен реальный путь внутри packages/domain/src.
  'domain-to-tools.ts': "import '@zona/agent-harness';\nexport const marker = true;\n",
  'domain-to-scripts.ts':
    "import '../../../../scripts/boundaries/check-workspace-graph.ts';\nexport const marker = true;\n",
  'domain-to-contracts-legal.ts':
    "import { PACKAGE_NAME } from '@zona/contracts';\nexport const legal = PACKAGE_NAME;\n",
};

const simulationFiles: Readonly<Record<string, string>> = {
  'sim-to-pg.ts': "import { Pool } from 'pg';\nexport type _P = Pool;\n",
};

const representationFiles: Readonly<Record<string, string>> = {
  'rep-to-domain.ts':
    "import { PACKAGE_NAME } from '@zona/domain';\nexport const _x = PACKAGE_NAME;\n",
};

type EslintMessage = { readonly ruleId: string | null; readonly message: string };
type EslintFileResult = { readonly filePath: string; readonly messages: readonly EslintMessage[] };
type DepcruiseViolation = {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string; readonly severity: string };
};

let eslintResults: readonly EslintFileResult[] = [];
let depcruiseViolations: readonly DepcruiseViolation[] = [];

/** Запускает CLI и возвращает stdout независимо от кода возврата (eslint/depcruise выходят с ошибкой при находках). */
const runCapture = (command: string, args: readonly string[]): string => {
  try {
    return execFileSync(command, [...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string') return stdout;
    throw error;
  }
};

beforeAll(() => {
  try {
    for (const dir of FIXTURE_DIRS) mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(domainFiles)) {
      writeFileSync(resolve(DOMAIN_DIR, name), content);
    }
    for (const [name, content] of Object.entries(simulationFiles)) {
      writeFileSync(resolve(SIMULATION_DIR, name), content);
    }
    for (const [name, content] of Object.entries(representationFiles)) {
      writeFileSync(resolve(REPRESENTATION_DIR, name), content);
    }

    const eslintRaw = runCapture('pnpm', ['exec', 'eslint', '--format', 'json', DOMAIN_DIR]);
    eslintResults = JSON.parse(eslintRaw) as readonly EslintFileResult[];

    const depcruiseRaw = runCapture('pnpm', [
      'exec',
      'depcruise',
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'json',
      DOMAIN_DIR,
      SIMULATION_DIR,
      REPRESENTATION_DIR,
    ]);
    const depcruiseParsed = JSON.parse(depcruiseRaw) as {
      readonly summary: { readonly violations: readonly DepcruiseViolation[] };
    };
    depcruiseViolations = depcruiseParsed.summary.violations;
  } finally {
    // Удаляем сразу после сбора результатов: даже если что-то из блока выше упало, фикстуры
    // не остаются в packages/domain и packages/simulation.
    cleanupFixtures();
  }
});

afterAll(() => {
  // Повторная защита: если beforeAll не добежал до try (например, упал mkdirSync на первой
  // директории), эти каталоги всё равно не должны пережить тестовый файл.
  cleanupFixtures();
});

const findEslintResult = (fileName: string): EslintFileResult => {
  const found = eslintResults.find((r) => r.filePath.endsWith(`/${fileName}`));
  if (found === undefined) {
    throw new Error(
      `eslint не вернул результат для фикстуры ${fileName}; проверьте, что beforeAll отработал`,
    );
  }
  return found;
};

const hasEslintMessage = (fileName: string, ruleId: string, messageIncludes: string): boolean =>
  findEslintResult(fileName).messages.some(
    (m) => m.ruleId === ruleId && m.message.includes(messageIncludes),
  );

describe('boundary fixtures — eslint (A2, DEV-02, SIM-01)', () => {
  it('позитивный случай: new Date(iso) и обычный код не дают ошибок', () => {
    expect(findEslintResult('clean.ts').messages).toEqual([]);
  });

  it.each([
    ['date-now.ts', 'no-restricted-syntax', 'Clock port'],
    ['new-date-empty.ts', 'no-restricted-syntax', 'читает системные часы'],
    ['date-parse.ts', 'no-restricted-syntax', 'Clock port'],
    ['math-random.ts', 'no-restricted-syntax', 'RandomSource'],
    ['process-env.ts', 'no-restricted-syntax', 'домен не обращается к process'],
    ['crypto-random-uuid.ts', 'no-restricted-syntax', 'randomUUID/getRandomValues'],
    ['fetch-call.ts', 'no-restricted-syntax', 'глобал и не ловится'],
    ['intl-usage.ts', 'no-restricted-syntax', 'locale-зависимое поведение'],
    ['to-locale-string.ts', 'no-restricted-syntax', 'locale-зависимые форматирование'],
    ['locale-compare.ts', 'no-restricted-syntax', 'locale-зависимые форматирование'],
    ['performance-now.ts', 'no-restricted-syntax', 'wall clock запрещён'],
    ['ts-enum.ts', 'no-restricted-syntax', 'enum запрещён'],
    ['ts-namespace.ts', 'no-restricted-syntax', 'namespaces запрещены'],
    ['import-kysely.ts', 'no-restricted-imports', "'kysely' import is restricted"],
    ['import-pg.ts', 'no-restricted-imports', "'pg' import is restricted"],
    ['import-fastify.ts', 'no-restricted-imports', "'fastify' import is restricted"],
    ['import-llm.ts', 'no-restricted-imports', `'${LLM_PACKAGE}' import is restricted`],
  ] as const)('%s -> %s срабатывает и указывает на нужное правило', (file, ruleId, fragment) => {
    expect(hasEslintMessage(file, ruleId, fragment)).toBe(true);
  });
});

describe('boundary fixtures — dependency-cruiser (A2, ADR-002/003/006)', () => {
  const hasDepViolation = (fromSuffix: string, ruleName: string): boolean =>
    depcruiseViolations.some((v) => v.from.endsWith(fromSuffix) && v.rule.name === ruleName);

  it('representation -> domain: representation-reads-projections-only', () => {
    expect(hasDepViolation('rep-to-domain.ts', 'representation-reads-projections-only')).toBe(true);
  });

  it('domain -> tools/**: packages-do-not-depend-on-tools', () => {
    expect(hasDepViolation('domain-to-tools.ts', 'packages-do-not-depend-on-tools')).toBe(true);
  });

  it('packages -> scripts/**: packages-do-not-depend-on-scripts-or-tests', () => {
    expect(
      hasDepViolation('domain-to-scripts.ts', 'packages-do-not-depend-on-scripts-or-tests'),
    ).toBe(true);
  });

  it('pg в packages/simulation: core-has-no-adapter-dependencies', () => {
    expect(hasDepViolation('sim-to-pg.ts', 'core-has-no-adapter-dependencies')).toBe(true);
  });

  it('LLM-пакет где угодно: no-runtime-llm-anywhere', () => {
    expect(hasDepViolation('import-llm.ts', 'no-runtime-llm-anywhere')).toBe(true);
  });

  it('легальное ребро domain -> @zona/contracts: без нарушений', () => {
    const anyViolation = depcruiseViolations.some((v) =>
      v.from.endsWith('domain-to-contracts-legal.ts'),
    );
    expect(anyViolation).toBe(false);
  });
});
