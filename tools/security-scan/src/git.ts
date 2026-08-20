import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * io-обёртки над `git ls-files` (OPS-03: сканы работают на отслеживаемых файлах,
 * а не на всём filesystem — untracked/ignored содержимое не проверяется и не блокирует).
 *
 * `execFileSync` вызывается с массивом аргументов (без `shell: true`), поэтому
 * шаблонной интерполяции в команду нет — см. `static_policy` про child_process.
 */

/** Чистая функция: разбирает NUL-separated вывод `git ls-files -z`. */
export const parseNullSeparatedList = (output: string): readonly string[] =>
  output.split('\0').filter((entry) => entry.length > 0);

/** io: список файлов, отслеживаемых git, относительно `repoRoot`. */
export const listGitTrackedFiles = (repoRoot: string): readonly string[] => {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  return parseNullSeparatedList(output);
};

export type TrackedFile = { readonly path: string; readonly content: string };

/** io: читает содержимое каждого переданного отслеживаемого пути. Бинарные/нечитаемые файлы пропускаются. */
export const readTrackedFiles = (
  repoRoot: string,
  paths: readonly string[],
): readonly TrackedFile[] => {
  const files: TrackedFile[] = [];
  for (const path of paths) {
    try {
      const content = readFileSync(`${repoRoot}/${path}`, 'utf8');
      files.push({ path, content });
    } catch {
      // Удалённый/недоступный/бинарный файл: пропускаем, не проваливаем скан.
    }
  }
  return files;
};
