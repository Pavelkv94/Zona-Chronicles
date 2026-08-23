import { readdirSync, readFileSync } from 'node:fs';

/**
 * io: рекурсивно собирает исходники под `apps/**`, `packages/**`, `tools/**`,
 * `scripts/**`, `tests/**` и явно перечисленные корневые config-файлы.
 *
 * Общий сборщик для `scan-static.ts` и `scan-no-llm.ts` — обе проверки читают
 * один и тот же набор исходников репозитория.
 *
 * N11 (review finding): раньше сканировались только `apps`/`packages`/`tools`.
 * Review воспроизвёл: probe-импорт запрещённого до Gate E LLM SDK-пакета в
 * `scripts/__probe__/gen.ts` и в `tests/__probe.ts` проходил `security:no-llm`
 * (pass, exit 0); опасная eval-конструкция в `scripts/__probe__/ev.ts` проходила
 * `security:static` (pass, exit 0) — ACCEPTANCE
 * A11 заявляла проверку исходников шире, чем она реально покрывала. `scripts/` и
 * `tests/` теперь равноправные корни обхода. Корневые build/lint-конфиги
 * (`eslint.config.mjs`, `vitest.config.ts`, `.dependency-cruiser.cjs`) не лежат ни
 * под одним из этих каталогов и не попали бы в обход директорий — они добавлены
 * явным списком `ROOT_CONFIG_FILES`, а не полным обходом корня репозитория (полный
 * обход корня зацепил бы `node_modules`/`docs`/`.git` и был бы избыточно дорогим).
 *
 * M-5 (review finding, раунд 3): раньше нечитаемая директория/файл под
 * `SCAN_ROOTS` (или сам `readdirSync`/`readFileSync`, упавший по любой причине,
 * кроме "пути нет") тихо пропускались — как будто там просто не было исходников.
 * Тот же класс дефекта, что B1 в `scan-dependencies.ts`. Теперь такие пути
 * собираются в `unreadablePaths`; вызывающая сторона (`scan-static.ts`,
 * `scan-no-llm.ts`) обязана трактовать непустой `unreadablePaths` как
 * `config-error`. Исключение — сам `SCAN_ROOT` (или `ROOT_CONFIG_FILES`-файл)
 * ПРОСТО ОТСУТСТВУЕТ (`ENOENT`): для `SCAN_ROOTS` это симметрично уже
 * существовавшему поведению для `ROOT_CONFIG_FILES` — синтетические
 * тест-деревья (см. `source-files.test.ts`) намеренно материализуют не все пять
 * корней сразу, и это не ошибка конфигурации. Любая ДРУГАЯ причина отказа
 * (`EACCES`, `ELOOP` и т.п. — путь существует, но не читается) — уже сигнал,
 * что содержимое могло остаться непроверенным, и идёт в `unreadablePaths`.
 */

export type ScannedFile = { readonly path: string; readonly content: string };

export type SourceCollectionResult = {
  readonly files: readonly ScannedFile[];
  readonly unreadablePaths: readonly string[];
};

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';

const SCAN_ROOTS = ['apps', 'packages', 'tools', 'scripts', 'tests'] as const;
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'] as const;
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'coverage']);

/**
 * Директория, чьё имя начинается с точки, исходником не считается.
 *
 * I03: `apps/web` (Next.js) кладёт сборку в `.next/`, которого в списке имён не было, и
 * `security:static` выдал 54 находки в минифицированных чанках. Опаснее самих находок то, что
 * вердикт скана стал зависеть от того, СОБИРАЛИ ЛИ ПРОЕКТ: `pnpm verify` запускает security до
 * build, поэтому на чистом дереве проверка проходила, а после любой сборки или E2E-прогона
 * падала. Контроль с двумя разными ответами на одном коммите — не контроль.
 *
 * Дописать `.next` к списку значило бы починить случай, а не класс: список имён нужно помнить
 * при добавлении каждого инструмента, и именно о нём никто не помнит. Правило закрывает и
 * `.turbo` (потому и убран из списка выше), и любой будущий `.cache`/`.vercel`.
 *
 * Правило про ДИРЕКТОРИИ, не про файлы: `.eslintrc.cjs` и подобные — исходники и читаются.
 */
const isDotDirectory = (name: string): boolean => name.startsWith('.');

/** Корневые config-файлы вне SCAN_ROOTS, тоже исполняемый код репозитория (N11). */
const ROOT_CONFIG_FILES = [
  'eslint.config.mjs',
  'vitest.config.ts',
  '.dependency-cruiser.cjs',
] as const;

export const collectSourceFiles = (repoRoot: string): SourceCollectionResult => {
  const files: ScannedFile[] = [];
  const unreadablePaths: string[] = [];

  const walk = (absoluteDir: string, relativeDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch (error) {
      // Корень/поддиректория просто отсутствует (ENOENT) — не ошибка (см. docstring).
      // Любая другая причина (EACCES/ELOOP/...) — путь есть, но не читается: содержимое
      // могло остаться непроверенным, это идёт в unreadablePaths (M-5).
      if (!isEnoent(error)) unreadablePaths.push(relativeDir === '' ? '.' : relativeDir);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name) || isDotDirectory(entry.name)) continue;
        walk(
          `${absoluteDir}/${entry.name}`,
          relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`,
        );
        continue;
      }
      if (!SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      try {
        const content = readFileSync(`${absoluteDir}/${entry.name}`, 'utf8');
        files.push({ path: relativePath, content });
      } catch {
        // readdirSync только что подтвердил, что этот путь существует — любой отказ
        // readFileSync здесь (в т.ч. ENOENT из-за гонки удаления) реален: содержимое
        // непроверено, значит и "findings отсутствуют" не подтверждено (M-5).
        unreadablePaths.push(relativePath);
      }
    }
  };

  for (const root of SCAN_ROOTS) {
    walk(`${repoRoot}/${root}`, root);
  }
  for (const fileName of ROOT_CONFIG_FILES) {
    try {
      const content = readFileSync(`${repoRoot}/${fileName}`, 'utf8');
      files.push({ path: fileName, content });
    } catch (error) {
      // Конфиг отсутствует в этом checkout (например ещё не создан) — легитимно,
      // пропускаем. Любая другая причина отказа — реальная проблема (M-5).
      if (!isEnoent(error)) unreadablePaths.push(fileName);
    }
  }
  return { files, unreadablePaths };
};
