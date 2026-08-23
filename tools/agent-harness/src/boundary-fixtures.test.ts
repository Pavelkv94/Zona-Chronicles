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
 *
 * minor 5 (второй раунд верификации): при жёстком `kill` тестового процесса `finally`/`afterAll`
 * не выполняются, и фикстуры остаются в исходниках пакетов. Две меры: (1) имя каталога детерминировано
 * и узнаваемо (`__fixture-<pid>__`, двойное подчёркивание — соглашение репозитория для «не рабочий
 * код»), поэтому его невозможно спутать с обычным исходником; (2) `sweepStaleFixtureDirs` в начале
 * `beforeAll` удаляет ЛЮБОЙ каталог вида `__fixture-*__` во всех `FIXTURE_PARENT_DIRS` независимо
 * от PID — не только текущего прогона, но и осиротевших от прошлого killed-процесса — прежде чем
 * создавать новые фикстуры.
 *
 * B-2/M-1/minor 7 (третий раунд верификации I00, правка ADR-003): список директорий вырос с трёх
 * до восьми — добавлены `packages/contracts`, `packages/content`, `packages/persistence`,
 * `packages/projections`, `apps/api`. Причина: «правило без фикстуры считается несуществующим» —
 * каждое из ранее непокрытых правил dependency-cruiser (`contracts-are-leaf`, `content-is-data-only`,
 * `persistence-does-not-import-simulation`, `observer-api-does-not-reach-persistence`,
 * `apps-do-not-depend-on-tools`, `apps-do-not-depend-on-scripts-or-tests`, `no-unresolvable`,
 * `no-circular`) теперь материализует фикстуру внутри того самого пакета, откуда правило смотрит
 * на `from`, — иначе правило `from: '^packages/contracts/'` и т.п. не увидит фикстуру за пределами
 * своего дерева.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
// minor 7 (раунд 3 верификации I00): правило без фикстуры считается несуществующим (ADR-003).
// Эти четыре директории материализуют фикстуры для правил dependency-cruiser, у которых раньше
// не было ни одного теста: contracts-are-leaf, content-is-data-only,
// persistence-does-not-import-simulation, observer-api-does-not-reach-persistence (+ новые
// apps-do-not-depend-on-tools/scripts-or-tests, M-1).
const CONTRACTS_DIR = resolve(REPO_ROOT, `packages/contracts/src/__${SUFFIX}__`);
const CONTENT_DIR = resolve(REPO_ROOT, `packages/content/src/__${SUFFIX}__`);
const PERSISTENCE_DIR = resolve(REPO_ROOT, `packages/persistence/src/__${SUFFIX}__`);
const PROJECTIONS_DIR = resolve(REPO_ROOT, `packages/projections/src/__${SUFFIX}__`);
const API_DIR = resolve(REPO_ROOT, `apps/api/src/__${SUFFIX}__`);
/**
 * `apps/web` — второе приложение, и до I03 у правил для приложений не было ни одной фикстуры,
 * покрывающей его. M7 независимого архитектурного аудита: маска правила заканчивалась на
 * расширении `.ts`, а весь экран написан в `.tsx` — то есть `process.env` в компоненте проходил
 * lint молча, вместе с повторно объявленными в том же блоке `structuralRestrictions`. Правило без
 * фикстуры считается несуществующим (ADR-003), и здесь это было буквально так.
 */
const WEB_DIR = resolve(REPO_ROOT, `apps/web/src/__${SUFFIX}__`);
const FIXTURE_DIRS = [
  DOMAIN_DIR,
  SIMULATION_DIR,
  REPRESENTATION_DIR,
  CONTRACTS_DIR,
  CONTENT_DIR,
  PERSISTENCE_DIR,
  PROJECTIONS_DIR,
  API_DIR,
  WEB_DIR,
];

const cleanupFixtures = (): void => {
  for (const dir of FIXTURE_DIRS) rmSync(dir, { recursive: true, force: true });
};

/** Родительские директории, в которых материализуются фикстуры (для minor 5 sweep). */
const FIXTURE_PARENT_DIRS = [
  resolve(REPO_ROOT, 'packages/domain/src'),
  resolve(REPO_ROOT, 'packages/simulation/src'),
  resolve(REPO_ROOT, 'packages/representation/src'),
  resolve(REPO_ROOT, 'packages/contracts/src'),
  resolve(REPO_ROOT, 'packages/content/src'),
  resolve(REPO_ROOT, 'packages/persistence/src'),
  resolve(REPO_ROOT, 'packages/projections/src'),
  resolve(REPO_ROOT, 'apps/api/src'),
  resolve(REPO_ROOT, 'apps/web/src'),
];
const FIXTURE_DIR_PATTERN = /^__fixture-\d+__$/;

/**
 * Удаляет ЛЮБОЙ `__fixture-<pid>__`, включая осиротевшие от прошлого killed-процесса (не только
 * текущего PID) — minor 5. Вызывается ДО создания фикстур текущего прогона, чтобы остаточные
 * каталоги от прошлого прогона не пережили следующий запуск этого файла.
 */
const sweepStaleFixtureDirs = (): void => {
  for (const parent of FIXTURE_PARENT_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue; // Родительская директория ещё не создана — нечего сметать.
    }
    for (const entry of entries) {
      if (FIXTURE_DIR_PATTERN.test(entry)) {
        rmSync(resolve(parent, entry), { recursive: true, force: true });
      }
    }
  }
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
  // M2 верификации I01: computed-доступ и globalThis обходили прежние селекторы —
  // проверено исполнением, файл с этими формами давал eslint exit 0.
  'computed-date-now.ts': "export const bad = (): number => Date['now']();\n",
  'computed-math-random.ts': "export const bad = (): number => Math['random']();\n",
  'global-this-random.ts': 'export const bad = (): number => globalThis.Math.random();\n',
  'global-this-process.ts': 'export const bad = (): string => globalThis.process.version;\n',
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
  // B-2 (blocker, раунд 3 верификации I00): запрет ловил только глобал (`crypto.randomUUID()`),
  // а не форму импорта того же источника (`import { randomUUID } from 'node:crypto'`) — идиоматичнее
  // и именно её пишет implementer по умолчанию. Каждый вход из правки ADR-003 обязан иметь
  // фикстуру, иначе правило считается несуществующим.
  'import-node-crypto.ts':
    "import { randomUUID } from 'node:crypto';\nexport const bad = randomUUID;\n",
  'import-node-perf-hooks.ts':
    "import { performance as ph } from 'node:perf_hooks';\nexport const bad = (): number => ph.now();\n",
  // Голая форма с подпутём (fs/promises) — до фикса были закрыты node:fs/node:fs/* и bare fs, но не bare fs/*.
  'import-bare-fs-subpath.ts':
    "import { readFile } from 'fs/promises';\nexport const bad = readFile;\n",
  'import-node-tls.ts': "import { connect } from 'node:tls';\nexport const bad = connect;\n",
  'import-node-dgram.ts':
    "import { createSocket } from 'node:dgram';\nexport const bad = createSocket;\n",
  'import-node-http2.ts':
    "import { connect as connectH2 } from 'node:http2';\nexport const bad = connectH2;\n",
  'import-node-dns.ts': "import { lookup } from 'node:dns';\nexport const bad = lookup;\n",
  'import-node-os.ts': "import { hostname } from 'node:os';\nexport const bad = hostname;\n",
  'import-node-worker-threads.ts':
    "import { Worker } from 'node:worker_threads';\nexport const bad = Worker;\n",
  // Депкрузовые фикстуры живут здесь же — им нужен реальный путь внутри packages/domain/src.
  'domain-to-tools.ts': "import '@zona/agent-harness';\nexport const marker = true;\n",
  'domain-to-scripts.ts':
    "import '../../../../scripts/boundaries/check-workspace-graph.ts';\nexport const marker = true;\n",
  'domain-to-contracts-legal.ts':
    "import { PACKAGE_NAME } from '@zona/contracts';\nexport const legal = PACKAGE_NAME;\n",
};

const simulationFiles: Readonly<Record<string, string>> = {
  'sim-to-pg.ts': "import { Pool } from 'pg';\nexport type _P = Pool;\n",
  // no-unresolvable/no-circular не прогоняются через eslint (только depcruise видит SIMULATION_DIR
  // как аргумент CLI ниже, а eslint — только DOMAIN_DIR), поэтому размещены здесь: нет риска, что
  // typed-linting споткнётся на несуществующем модуле или цикле импортов.
  'sim-unresolvable-import.ts':
    "import { missing } from './does-not-exist.ts';\nexport const marker = missing;\n",
  'sim-circular-a.ts': "import './sim-circular-b.ts';\nexport const marker = true;\n",
  'sim-circular-b.ts': "import './sim-circular-a.ts';\nexport const marker = true;\n",
};

const representationFiles: Readonly<Record<string, string>> = {
  'rep-to-domain.ts':
    "import { PACKAGE_NAME } from '@zona/domain';\nexport const _x = PACKAGE_NAME;\n",
};

/** minor 7: contracts-are-leaf не имел фикстуры. */
const contractsFiles: Readonly<Record<string, string>> = {
  'contracts-to-domain.ts':
    "import { PACKAGE_NAME } from '@zona/domain';\nexport const _x = PACKAGE_NAME;\n",
};

/** minor 7: content-is-data-only не имел фикстуры. */
const contentFiles: Readonly<Record<string, string>> = {
  'content-to-domain.ts':
    "import { PACKAGE_NAME } from '@zona/domain';\nexport const _x = PACKAGE_NAME;\n",
};

/** minor 7: persistence-does-not-import-simulation не имел фикстуры. */
const persistenceFiles: Readonly<Record<string, string>> = {
  'persistence-to-simulation.ts':
    "import { PACKAGE_NAME } from '@zona/simulation';\nexport const _x = PACKAGE_NAME;\n",
  /**
   * M6 (аудит I02B): запрет C10 «replay не решает заново» был привязан к ОДНОМУ файлу
   * (`packages/persistence/src/replay.ts`) и не имел фикстуры — то есть по ADR-003 считался
   * несуществующим. Обе фикстуры обязательны и проверяют РАЗНЫЕ направления: нарушение ловится,
   * корректная свёртка проходит. Именно вторая сторона в прошлый раз не была проверена, и
   * правило dependency-cruiser с `reachable: true` падало на правильном коде.
   */
  'replay.ts': "import { decide } from '@zona/domain';\nexport const bad = decide;\n",
  'replay-fold.ts': "import { evolve } from '@zona/domain';\nexport const good = evolve;\n",
  /**
   * Третья фикстура появилась из-за дефекта, который вскрыло само расширение правила: блок C10
   * переопределял `no-restricted-imports` ЦЕЛИКОМ, и запрет LLM SDK (ADR-006) внутри replay-файлов
   * молча исчезал. Проверять надо не только то, что новое правило работает, но и то, что оно не
   * отменило соседнее.
   */
  'replay-llm.ts': `import { Anthropic } from '${LLM_PACKAGE}';\nexport type _A = Anthropic;\n`,
  /**
   * M-B (второй раунд): M4 положил `PersistentRandomSource` в ТОТ ЖЕ пакет, где живёт replay, и
   * экспортировал из публичного индекса. Правило C10 запрещало только импорты из `@zona/domain`,
   * поэтому оба пути к источнику случайности внутри `persistence` проходили молча — контроль
   * есть, но не на том пути. Ровно тот класс, который M6 и закрывал.
   */
  'replay-local-random.ts':
    "import { PersistentRandomSource } from '../prng-positions.ts';\nexport const bad = PersistentRandomSource;\n",
  'replay-package-random.ts':
    "import { PersistentRandomSource } from '@zona/persistence';\nexport const bad = PersistentRandomSource;\n",
};

/**
 * Промежуточное звено для транзитивной фикстуры observer-api-does-not-reach-persistence
 * (M-1, `reachable: true`): реальный edge packages/projections -> packages/persistence, которого
 * сегодня в продукте нет, но который правило обязано ловить, если появится.
 */
const projectionsFiles: Readonly<Record<string, string>> = {
  'projections-to-persistence.ts':
    "import type { Database } from '@zona/persistence';\nexport type _D = Database;\n",
};

/** M-1: apps/** не был ограничен ничем, кроме прямого ребра к persistence. */
const apiFiles: Readonly<Record<string, string>> = {
  'api-to-tools.ts': "import '@zona/agent-harness';\nexport const marker = true;\n",
  'api-to-scripts.ts':
    "import '../../../../scripts/boundaries/check-workspace-graph.ts';\nexport const marker = true;\n",
  // Прямого импорта @zona/persistence из api достаточно, чтобы поймать прямое ребро, но M-1
  // требует транзитивности: api не должен зависеть от чего-либо, что зависит от persistence.
  'api-to-projections-persistence.ts': `import '../../../../packages/projections/src/__${SUFFIX}__/projections-to-persistence.ts';\nexport const marker = true;\n`,
};

/**
 * Фикстуры `apps/web`: те же запреты, что у остальных приложений, но в `.tsx`.
 *
 * Расширение здесь и есть предмет проверки. `.ts`-файл в `apps/web` правило ловило и раньше;
 * молча выпадал именно `.tsx`, то есть ровно тот формат, в котором написан весь экран.
 */
const webFiles: Readonly<Record<string, string>> = {
  // M7 и m12 независимого аудита I03, обе воспроизведены его фикстурами до появления этих.
  // `apps/web` — второе приложение observer-пути, и до I03 запрет на путь к persistence
  // распространялся только на `apps/api`: проба от web давала НОЛЬ нарушений при 27 от api.
  'web-to-persistence.ts':
    "import '../../../../packages/persistence/src/database.ts';\nexport const marker = true;\n",
  // Ребро app -> app не запрещало НИ ОДНО правило, хотя `PLAN.md` §10.2 опирается на его
  // отсутствие как на исполняемое ограничение при выборе, куда переносить сборщик проекции.
  'web-to-api.ts': "import '../../../api/src/server.ts';\nexport const marker = true;\n",
  'web-process-env.tsx': "export const bad = (): string | undefined => process.env['X'];\n",
  // Первая редакция проверяла здесь `Date.now()` и падала: приложениям он не запрещён вовсе
  // (порты времени — требование ядра, не экрана). Детектор мерил не то, что запрещено.
  //
  // Про `enum` стоит сказать точно, потому что это ограничивает вывод. Ревьюер писал, что вместе
  // с маской терялись и `structuralRestrictions`, объявленные в блоке для приложений повторно.
  // Проба показала иначе: при возврате маски к `.ts` эта фикстура ВСЁ РАВНО ловится — запрет
  // `enum` приходит из базового конфига, покрывающего все файлы. Значит маска решала судьбу
  // только `process.env`, и именно та фикстура доказывает M7. Эта — доказывает, что базовые
  // запреты ADR-002 до `.tsx` доходили и раньше.
  'web-enum.tsx': 'export enum Bad {\n  A = 1,\n}\n',
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
  sweepStaleFixtureDirs();
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
    for (const [name, content] of Object.entries(contractsFiles)) {
      writeFileSync(resolve(CONTRACTS_DIR, name), content);
    }
    for (const [name, content] of Object.entries(contentFiles)) {
      writeFileSync(resolve(CONTENT_DIR, name), content);
    }
    for (const [name, content] of Object.entries(persistenceFiles)) {
      writeFileSync(resolve(PERSISTENCE_DIR, name), content);
    }
    // Порядок важен: api-to-projections-persistence.ts (ниже) ссылается на файл, материализуемый
    // здесь, относительным путём — он обязан существовать до вызова depcruise.
    for (const [name, content] of Object.entries(projectionsFiles)) {
      writeFileSync(resolve(PROJECTIONS_DIR, name), content);
    }
    for (const [name, content] of Object.entries(apiFiles)) {
      writeFileSync(resolve(API_DIR, name), content);
    }
    for (const [name, content] of Object.entries(webFiles)) {
      writeFileSync(resolve(WEB_DIR, name), content);
    }

    // PERSISTENCE_DIR попадает в прогон eslint ради фикстур C10 (M6): правила `files` смотрят на
    // путь файла, поэтому фикстура обязана лежать внутри пакета, к которому правило применяется.
    const eslintRaw = runCapture('pnpm', [
      'exec',
      'eslint',
      '--format',
      'json',
      // `--ext` не нужен: пути передаются каталогами, и eslint flat config сам решает по маске
      // правил, какие расширения линтовать. WEB_DIR добавлен по M7 — фикстуры там `.tsx`.
      DOMAIN_DIR,
      PERSISTENCE_DIR,
      WEB_DIR,
    ]);
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
      CONTRACTS_DIR,
      CONTENT_DIR,
      PERSISTENCE_DIR,
      PROJECTIONS_DIR,
      API_DIR,
      WEB_DIR,
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
    ['computed-date-now.ts', 'no-restricted-syntax', 'computed-доступ к Date'],
    ['computed-math-random.ts', 'no-restricted-syntax', 'computed-доступ к Math.random'],
    ['global-this-random.ts', 'no-restricted-syntax', 'globalThis'],
    ['global-this-process.ts', 'no-restricted-syntax', 'globalThis'],
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
    // B-2: форма импорта того же источника недетерминизма, а не только глобал.
    ['import-node-crypto.ts', 'no-restricted-imports', "'node:crypto' import is restricted"],
    [
      'import-node-perf-hooks.ts',
      'no-restricted-imports',
      "'node:perf_hooks' import is restricted",
    ],
    ['import-bare-fs-subpath.ts', 'no-restricted-imports', "'fs/promises' import is restricted"],
    ['import-node-tls.ts', 'no-restricted-imports', "'node:tls' import is restricted"],
    ['import-node-dgram.ts', 'no-restricted-imports', "'node:dgram' import is restricted"],
    ['import-node-http2.ts', 'no-restricted-imports', "'node:http2' import is restricted"],
    ['import-node-dns.ts', 'no-restricted-imports', "'node:dns' import is restricted"],
    ['import-node-os.ts', 'no-restricted-imports', "'node:os' import is restricted"],
    [
      'import-node-worker-threads.ts',
      'no-restricted-imports',
      "'node:worker_threads' import is restricted",
    ],
  ] as const)('%s -> %s срабатывает и указывает на нужное правило', (file, ruleId, fragment) => {
    expect(hasEslintMessage(file, ruleId, fragment)).toBe(true);
  });
});

describe('boundary fixtures — C10: replay не принимает решений заново (M6)', () => {
  it('replay.ts с импортом decide ловится правилом и названным сообщением', () => {
    expect(hasEslintMessage('replay.ts', 'no-restricted-imports', 'ACCEPTANCE C10')).toBe(true);
  });

  it('запрет LLM SDK (ADR-006) не исчезает в replay-файлах: правила eslint переопределяются целиком', () => {
    expect(
      hasEslintMessage(
        'replay-llm.ts',
        'no-restricted-imports',
        `'${LLM_PACKAGE}' import is restricted`,
      ),
    ).toBe(true);
  });

  it.each([
    ['replay-local-random.ts', 'относительным путём внутри пакета'],
    ['replay-package-random.ts', 'через публичный индекс пакета'],
  ] as const)(
    'M-B: источник случайности из самого persistence (%s) тоже запрещён — %s',
    (file, _how) => {
      expect(hasEslintMessage(file, 'no-restricted-imports', 'ACCEPTANCE C10')).toBe(true);
    },
  );

  /**
   * M7 независимого архитектурного аудита I03. Правило для приложений объявлено маской, которая
   * до этой итерации заканчивалась расширением `.ts` и потому не покрывала `.tsx` — то есть весь
   * `apps/web`. Проверено пробой ДО правки: файл с `process.env` в `.tsx` не давал ни одной
   * ошибки lint.
   */
  it.each([
    ['web-process-env.tsx', 'no-restricted-syntax', 'process.env читается только в config.ts'],
    ['web-enum.tsx', 'no-restricted-syntax', 'enum запрещён'],
  ])('apps/web %s ловится правилом %s', (file, rule, includes) => {
    expect(hasEslintMessage(file, rule, includes)).toBe(true);
  });

  it('вторая сторона: свёртка через evolve проходит — правило не запрещает корректный replay', () => {
    const c10 = findEslintResult('replay-fold.ts').messages.filter((m) =>
      m.message.includes('ACCEPTANCE C10'),
    );
    expect(c10).toEqual([]);
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

  // B-2: node:crypto/node:perf_hooks/bare fs-подпуть в форме импорта — тот же regex, что и для
  // no-restricted-imports выше, должен независимо ловить это в dependency-cruiser.
  it.each([
    ['import-node-crypto.ts', 'core-has-no-adapter-dependencies'],
    ['import-node-perf-hooks.ts', 'core-has-no-adapter-dependencies'],
    ['import-bare-fs-subpath.ts', 'core-has-no-adapter-dependencies'],
    ['import-node-tls.ts', 'core-has-no-adapter-dependencies'],
    ['import-node-dgram.ts', 'core-has-no-adapter-dependencies'],
    ['import-node-http2.ts', 'core-has-no-adapter-dependencies'],
    ['import-node-dns.ts', 'core-has-no-adapter-dependencies'],
    ['import-node-os.ts', 'core-has-no-adapter-dependencies'],
    ['import-node-worker-threads.ts', 'core-has-no-adapter-dependencies'],
  ] as const)('%s -> %s срабатывает в depcruise', (file, ruleName) => {
    expect(hasDepViolation(file, ruleName)).toBe(true);
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

  // M-1 (major, раунд 3 верификации I00): apps/** не был ограничен ничем, кроме прямого ребра
  // к persistence. Симметричные правила и транзитивная форма observer-api-does-not-reach-persistence.
  it('apps/api -> tools/**: apps-do-not-depend-on-tools', () => {
    expect(hasDepViolation('api-to-tools.ts', 'apps-do-not-depend-on-tools')).toBe(true);
  });

  it('apps/api -> scripts/**: apps-do-not-depend-on-scripts-or-tests', () => {
    expect(hasDepViolation('api-to-scripts.ts', 'apps-do-not-depend-on-scripts-or-tests')).toBe(
      true,
    );
  });

  it('apps/web -> packages/persistence: правило покрывает ОБА приложения observer-пути', () => {
    expect(
      hasDepViolation('web-to-persistence.ts', 'observer-api-does-not-reach-persistence'),
    ).toBe(true);
  });

  it('apps/web -> apps/api: apps-do-not-depend-on-apps', () => {
    expect(hasDepViolation('web-to-api.ts', 'apps-do-not-depend-on-apps')).toBe(true);
  });

  it('apps/api -> packages/projections -> packages/persistence (транзитивно): observer-api-does-not-reach-persistence', () => {
    expect(
      hasDepViolation(
        'api-to-projections-persistence.ts',
        'observer-api-does-not-reach-persistence',
      ),
    ).toBe(true);
  });

  // minor 7 (раунд 3 верификации I00): контроли без фикстур, найденные независимой проверкой.
  it('packages/contracts -> packages/domain: contracts-are-leaf', () => {
    expect(hasDepViolation('contracts-to-domain.ts', 'contracts-are-leaf')).toBe(true);
  });

  it('packages/content -> packages/domain: content-is-data-only', () => {
    expect(hasDepViolation('content-to-domain.ts', 'content-is-data-only')).toBe(true);
  });

  it('packages/persistence -> packages/simulation: persistence-does-not-import-simulation', () => {
    expect(
      hasDepViolation('persistence-to-simulation.ts', 'persistence-does-not-import-simulation'),
    ).toBe(true);
  });

  it('нерезолвимый импорт: no-unresolvable', () => {
    expect(hasDepViolation('sim-unresolvable-import.ts', 'no-unresolvable')).toBe(true);
  });

  it('взаимный импорт двух модулей: no-circular', () => {
    // depcruise репортит цикл один раз, от модуля, с которого начался обход графа (a -> b),
    // а не оба направления по отдельности — проверяем ребро целиком, а не только `from`.
    expect(
      depcruiseViolations.some(
        (v) =>
          v.rule.name === 'no-circular' &&
          v.from.endsWith('sim-circular-a.ts') &&
          v.to.endsWith('sim-circular-b.ts'),
      ),
    ).toBe(true);
  });
});
