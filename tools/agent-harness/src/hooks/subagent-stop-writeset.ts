#!/usr/bin/env node
/**
 * SubagentStop hook: сверяет фактический git diff с declared write set (DEV-02, A4).
 *
 * Контроль результата, а не намерения: даже если запись прошла мимо PreToolUse
 * (например, через Bash), расхождение обнаруживается до завершения задачи.
 *
 * B2 review finding: роль сессии решается hook payload-ом (`agent_id`/`agent_type` —
 * `classifySession`), а не наличием `.claude/writeset.json`. Для task-сессии сверка выполняется
 * безусловно:
 *   1. если `.claude/writeset.json` валиден — сверяем diff с ним;
 *   2. если файла нет — используем карту задач итерации `.claude/tasks/*.json`;
 *   3. если нет ни того, ни другого — завершение блокируется явной причиной, а не пропускается.
 * Lead-сессия (нет agent_id/agent_type) по-прежнему не ограничена write set-ом.
 */
import { execFileSync } from 'node:child_process';
import { findDiffViolations, formatViolations } from '../diff-violations.ts';
import { classifySession } from '../session-role.ts';
import { checkOwnership, formatOwnershipProblem } from '../task-ownership.ts';
import { loadTaskDeclarations } from '../tasks-directory.ts';
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

const fail = (reason: string): never => {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
};

const main = async (): Promise<void> => {
  const input = await readHookInput();
  const projectRoot =
    typeof input['cwd'] === 'string' && input['cwd'].length > 0 ? input['cwd'] : process.cwd();

  const sessionRole = classifySession(input);
  if (sessionRole === 'lead') return; // backward compat: lead-сессия не ограничена write set-ом.

  const changed = [
    ...git(projectRoot, ['diff', '--name-only', 'HEAD']),
    ...git(projectRoot, ['ls-files', '--others', '--exclude-standard']),
  ];
  const uniqueChanged = [...new Set(changed)];

  const loaded = loadWriteSet(`${projectRoot}/.claude/writeset.json`);

  if (loaded.kind === 'invalid') {
    fail(`Fail-closed: .claude/writeset.json повреждён: ${loaded.reason}`);
    return;
  }

  if (loaded.kind === 'task') {
    const violations = findDiffViolations(uniqueChanged, loaded.writeSet);
    if (violations.length > 0) {
      fail(formatViolations(violations, loaded.writeSet.task_id));
    }
    return;
  }

  // loaded.kind === 'lead' — .claude/writeset.json отсутствует (в т.ч. удалён самой сессией).
  // Task-сессия обязана быть покрыта картой задач итерации; иначе завершение блокируется.
  const tasksResult = loadTaskDeclarations(`${projectRoot}/.claude/tasks`);

  if (tasksResult.kind === 'invalid') {
    fail(`Fail-closed: .claude/tasks/*.json повреждена: ${tasksResult.reason}`);
    return;
  }

  if (tasksResult.kind === 'absent') {
    fail(
      'Task-сессия завершается без .claude/writeset.json и без .claude/tasks/*.json: ' +
        'нет объявленного источника write set. Lead обязан объявить write set до запуска задачи ' +
        '(это не пропуск проверки: отсутствие обоих источников — fail-closed).',
    );
    return;
  }

  const report = checkOwnership(uniqueChanged, tasksResult.tasks, tasksResult.leadPaths);
  if (report.problems.length > 0) {
    const lines = report.problems.map((problem) => `  - ${formatOwnershipProblem(problem)}`);
    fail(
      [
        'Task-сессия изменила файлы вне карты владения задачами итерации (.claude/tasks/*.json):',
        ...lines,
      ].join('\n'),
    );
  }
};

await main();
