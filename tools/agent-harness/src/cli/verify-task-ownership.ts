#!/usr/bin/env node
/**
 * Сверяет фактические изменения с картой владения задачами итерации (DEV-02).
 *
 * Использование:
 *   node tools/agent-harness/src/cli/verify-task-ownership.ts .claude/tasks/I00.json <base-sha>
 *
 * Применяется lead-ом после параллельного исполнения implementer-задач в одном worktree,
 * где `.claude/writeset.json` описывает только одну активную задачу.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkOwnership, formatOwnershipProblem } from '../task-ownership.ts';
import type { TaskDeclaration } from '../task-ownership.ts';

type TasksFile = {
  readonly iteration_id: string;
  readonly lead_paths?: readonly string[];
  readonly tasks: readonly TaskDeclaration[];
};

const [, , tasksFilePath, baseSha] = process.argv;

if (tasksFilePath === undefined || baseSha === undefined) {
  console.error('Использование: verify-task-ownership.ts <tasks-file> <base-sha>');
  process.exit(2);
}

const tasksFile = JSON.parse(readFileSync(tasksFilePath, 'utf8')) as TasksFile;

const git = (args: readonly string[]): string[] =>
  execFileSync('git', [...args], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const changed = [
  ...git(['diff', '--name-only', baseSha]),
  ...git(['ls-files', '--others', '--exclude-standard']),
];

const report = checkOwnership([...new Set(changed)], tasksFile.tasks, tasksFile.lead_paths ?? []);

const byTask = new Map<string, number>();
for (const taskId of Object.values(report.ownedBy)) {
  byTask.set(taskId, (byTask.get(taskId) ?? 0) + 1);
}

console.log(
  `Итерация ${tasksFile.iteration_id}: изменено файлов ${Object.keys(report.ownedBy).length}`,
);
for (const [taskId, count] of [...byTask.entries()].sort()) {
  console.log(`  ${taskId}: ${count}`);
}

if (report.problems.length > 0) {
  console.error('\nНарушения владения:');
  for (const problem of report.problems) console.error(`  - ${formatOwnershipProblem(problem)}`);
  process.exit(1);
}
console.log('Нарушений владения нет.');
