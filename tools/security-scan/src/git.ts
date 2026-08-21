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

export type ReadTrackedFilesResult = {
  readonly files: readonly TrackedFile[];
  /**
   * M-5 (review finding, раунд 3): пути, отслеживаемые git, но не прочитанные
   * (удалены с диска после `git ls-files -z`, недоступны по правам, либо иначе
   * нечитаемы). Раньше такой путь тихо выпадал из результата — непрочитанное
   * содержимое не могло дать находок, и вызывающий скан по факту подтверждал
   * "чисто", ничего не проверив по этому файлу. Тот же класс дефекта, что и
   * B1 в `scan-dependencies.ts`. Вызывающая сторона обязана трактовать
   * непустой `unreadablePaths` как невозможность подтвердить отсутствие
   * находок — `config-error`, а не "нет находок" (см. `scan-no-llm.ts`,
   * `scan-secrets.ts`).
   */
  readonly unreadablePaths: readonly string[];
};

/** io: читает содержимое каждого переданного отслеживаемого пути. */
export const readTrackedFiles = (
  repoRoot: string,
  paths: readonly string[],
): ReadTrackedFilesResult => {
  const files: TrackedFile[] = [];
  const unreadablePaths: string[] = [];
  for (const path of paths) {
    try {
      const content = readFileSync(`${repoRoot}/${path}`, 'utf8');
      files.push({ path, content });
    } catch {
      unreadablePaths.push(path);
    }
  }
  return { files, unreadablePaths };
};
