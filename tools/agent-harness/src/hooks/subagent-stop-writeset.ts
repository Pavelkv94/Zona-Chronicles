#!/usr/bin/env node
/**
 * SubagentStop hook: сверяет фактический git diff с declared write set (DEV-02).
 *
 * Контроль результата, а не намерения: даже если запись прошла мимо PreToolUse
 * (например, через Bash), расхождение обнаруживается до завершения задачи.
 */
import { execFileSync } from 'node:child_process';
import { findDiffViolations, formatViolations } from '../diff-violations.ts';
import { loadWriteSet } from '../writeset.ts';
import { readHookInput } from './read-stdin.ts';

const git = (projectRoot: string, args: readonly string[]): string[] => {
  try {
    return execFileSync('git', [...args], { cwd: projectRoot, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
};

const main = async (): Promise<void> => {
  const input = await readHookInput();
  const projectRoot =
    typeof input['cwd'] === 'string' && input['cwd'].length > 0 ? input['cwd'] : process.cwd();

  const loaded = loadWriteSet(`${projectRoot}/.claude/writeset.json`);
  if (loaded.kind === 'lead') return;
  if (loaded.kind === 'invalid') {
    process.stderr.write(`Fail-closed: ${loaded.reason}\n`);
    process.exit(2);
  }

  const changed = [
    ...git(projectRoot, ['diff', '--name-only', 'HEAD']),
    ...git(projectRoot, ['ls-files', '--others', '--exclude-standard']),
  ];
  const violations = findDiffViolations([...new Set(changed)], loaded.writeSet);

  if (violations.length > 0) {
    process.stderr.write(`${formatViolations(violations, loaded.writeSet.task_id)}\n`);
    process.exit(2);
  }
};

await main();
