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
 */

export type ScannedFile = { readonly path: string; readonly content: string };

const SCAN_ROOTS = ['apps', 'packages', 'tools', 'scripts', 'tests'] as const;
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'] as const;
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

/** Корневые config-файлы вне SCAN_ROOTS, тоже исполняемый код репозитория (N11). */
const ROOT_CONFIG_FILES = [
  'eslint.config.mjs',
  'vitest.config.ts',
  '.dependency-cruiser.cjs',
] as const;

export const collectSourceFiles = (repoRoot: string): readonly ScannedFile[] => {
  const files: ScannedFile[] = [];

  const walk = (absoluteDir: string, relativeDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
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
        // Нечитаемый файл: пропускаем, не проваливаем скан.
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
    } catch {
      // Конфиг отсутствует в этом checkout (например ещё не создан) — пропускаем.
    }
  }
  return files;
};
