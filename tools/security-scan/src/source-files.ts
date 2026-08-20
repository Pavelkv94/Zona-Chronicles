import { readdirSync, readFileSync } from 'node:fs';

/**
 * io: рекурсивно собирает исходники под `apps/**`, `packages/**`, `tools/**`.
 *
 * Общий сборщик для `scan-static.ts` и `scan-no-llm.ts` — обе проверки читают
 * один и тот же набор исходников репозитория.
 */

export type ScannedFile = { readonly path: string; readonly content: string };

const SCAN_ROOTS = ['apps', 'packages', 'tools'] as const;
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'] as const;
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

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
  return files;
};
