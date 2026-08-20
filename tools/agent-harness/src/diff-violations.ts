import { matchesAnyGlob } from './glob.ts';
import { HUMAN_ONLY_PATHS, PROTECTED_PATHS } from './protected-paths.ts';
import type { WriteSet } from './writeset.ts';

export type DiffViolation = {
  readonly path: string;
  readonly rule: 'human-only' | 'protected-path' | 'outside-write-set';
};

/**
 * Сверяет фактический `git diff --name-only` с declared write set.
 *
 * Этот контроль намеренно не доверяет намерению агента и не парсит текст команд:
 * он смотрит на результат работы (`08_TDD_AND_AGENT_WORKFLOW` §9).
 */
export const findDiffViolations = (
  changedFiles: readonly string[],
  writeSet: WriteSet,
): readonly DiffViolation[] => {
  const allowedProtected = writeSet.allow_protected_paths ?? [];
  const violations: DiffViolation[] = [];

  for (const path of changedFiles) {
    if (path.length === 0) continue;

    if (matchesAnyGlob(path, HUMAN_ONLY_PATHS)) {
      violations.push({ path, rule: 'human-only' });
      continue;
    }
    if (matchesAnyGlob(path, PROTECTED_PATHS) && !matchesAnyGlob(path, allowedProtected)) {
      violations.push({ path, rule: 'protected-path' });
      continue;
    }
    if (!matchesAnyGlob(path, writeSet.write_paths)) {
      violations.push({ path, rule: 'outside-write-set' });
    }
  }
  return violations;
};

export const formatViolations = (violations: readonly DiffViolation[], taskId: string): string => {
  const lines = violations.map(({ path, rule }) => `  - ${path} (${rule})`);
  return [
    `Задача ${taskId} изменила файлы вне declared write set:`,
    ...lines,
    'Верните эти файлы в исходное состояние или запросите расширение write set у orchestrator/lead.',
  ].join('\n');
};
