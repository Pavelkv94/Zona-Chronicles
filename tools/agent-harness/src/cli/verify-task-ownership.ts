#!/usr/bin/env node
/**
 * Сверяет фактические изменения с картой владения задачами итерации (DEV-02).
 *
 * Использование:
 *   node .../verify-task-ownership.ts <tasks-file-or-dir> <base-sha>
 *
 * Примеры:
 *   node .../verify-task-ownership.ts .claude/tasks/I00.json <base-sha>   # один файл (как в CI)
 *   node .../verify-task-ownership.ts .claude/tasks <base-sha>            # весь каталог задач (minor 6)
 *
 * Применяется lead-ом после параллельного исполнения implementer-задач в одном worktree,
 * где `.claude/writeset.json` описывает только одну активную задачу.
 *
 * N2 review finding (второй раунд верификации): и карта задач, и diff читаются относительно
 * `<base-sha>` из git-объекта, а не с диска. Подмена `.claude/tasks/*.json` в рабочем дереве перед
 * запуском этой команды (или её оставшийся на диске повреждённый черновик) не влияет на результат:
 * источник — `git show <base-sha>:<path>`, тот же принцип, что и в `subagent-stop-writeset.ts`
 * (`../git-source.ts`). `<base-sha>` — обязательный аргумент: если он не задан или не резолвится
 * в коммит, команда завершается ошибкой (fail-closed), а не читает рабочее дерево.
 *
 * minor 6: путь может указывать на один файл (сохранена форма вызова из CI,
 * `.github/workflows/ci.yml` не меняется в рамках этого фикса) или на каталог — тогда
 * объединяются все `*.json` внутри него, как это уже делает `subagent-stop-writeset.ts` для
 * `.claude/tasks/`. Отсутствие пути в дереве `<base-sha>` — понятная ошибка, а не молчаливый 0.
 */
import { execFileSync } from 'node:child_process';
import { checkOwnership, formatOwnershipProblem } from '../task-ownership.ts';
import type { TaskDeclaration } from '../task-ownership.ts';
import { gitPathKind, readGitBlob, resolveCommit } from '../git-source.ts';
import { loadTaskDeclarationsFromGit } from '../tasks-directory.ts';

const projectRoot = process.cwd();

const usageAndExit = (message: string): never => {
  console.error(message);
  console.error('Использование: verify-task-ownership.ts <tasks-file-or-dir> <base-sha>');
  process.exit(2);
};

/**
 * Отказ по СОСТОЯНИЮ МИРА, а не по аргументам. Код тот же (fail-closed не ослабляется), но
 * подсказка по аргументам не печатается.
 *
 * Разница не косметическая. Первый прогон CI этого репозитория упёрся сюда: `origin/main` стоит
 * на первом коммите, каталога задач в нём нет, и шаг падал, печатая «Использование: …» — то есть
 * сообщал оператору, что тот неверно набрал команду, тогда как команда была верной, а нечего было
 * проверять. Диагностика, отправляющая читателя не туда, дороже отсутствующей: по ней чинят не то.
 */
const cannotVerifyAndExit = (message: string): never => {
  console.error(message);
  console.error(
    'Проверить владение относительно этой базы невозможно: в ней не объявлено ни одной задачи. ' +
      'Это не нарушение и не ошибка вызова. Так выглядит база, предшествующая появлению harness — ' +
      'например первый коммит репозитория. Вызывающий (CI) обязан различать этот случай сам.',
  );
  process.exit(2);
};

// `?? usageAndExit(...)` вместо `if (x === undefined) usageAndExit(...)`: тип результата берётся
// из самого выражения (never исключается из объединения), а не из control-flow narrowing после
// вызова функции — narrowing по звонку в const-хранимую never-функцию в этой версии TS не
// применяется к переменным вне текущего блока (проверено отдельно), поэтому полагаться на него
// для дальнейшего использования `tasksPathArg`/`baseSha` как `string` было бы хрупко.
const [, , tasksPathRaw, baseShaRaw] = process.argv;
const tasksPathArg: string =
  tasksPathRaw ?? usageAndExit('Не хватает аргументов: <tasks-file-or-dir>.');
const baseSha: string = baseShaRaw ?? usageAndExit('Не хватает аргументов: <base-sha>.');

const commit = resolveCommit(projectRoot, baseSha);
if (commit.kind === 'error') {
  usageAndExit(`Fail-closed: ${commit.reason}`);
}

const isTaskDeclaration = (value: unknown): value is TaskDeclaration =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)['task_id'] === 'string' &&
  typeof (value as Record<string, unknown>)['owner_role'] === 'string' &&
  Array.isArray((value as Record<string, unknown>)['write_paths']);

type LoadedTasks = {
  readonly label: string;
  readonly tasks: readonly TaskDeclaration[];
  readonly leadPaths: readonly string[];
};

/** Один файл карты задач (форма из CI: `iteration_id` + `tasks` + опциональный `lead_paths`). */
const loadSingleFile = (path: string): LoadedTasks => {
  const blob = readGitBlob(projectRoot, baseSha, path);
  if (blob.kind === 'absent') {
    return cannotVerifyAndExit(`${path} отсутствует в git-объекте ${baseSha}.`);
  }
  if (blob.kind === 'error') {
    return usageAndExit(`${path} недоступен из git-объекта ${baseSha}: ${blob.reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(blob.content);
  } catch (error) {
    return usageAndExit(`${path} не является валидным JSON: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return usageAndExit(`${path}: должен быть объектом`);
  }
  const file = parsed as {
    readonly iteration_id?: unknown;
    readonly lead_paths?: unknown;
    readonly tasks?: unknown;
  };
  if (!Array.isArray(file.tasks) || !file.tasks.every(isTaskDeclaration)) {
    return usageAndExit(
      `${path}: обязательное поле tasks — массив TaskDeclaration (task_id, owner_role, write_paths)`,
    );
  }
  const leadPaths =
    file.lead_paths !== undefined && Array.isArray(file.lead_paths)
      ? (file.lead_paths as readonly string[])
      : [];
  const label = typeof file.iteration_id === 'string' ? file.iteration_id : path;
  return { label, tasks: file.tasks, leadPaths };
};

/** Каталог задач: объединяет все `*.json` внутри него (та же логика, что у hook-а). */
const loadDirectory = (dir: string): LoadedTasks => {
  const result = loadTaskDeclarationsFromGit(projectRoot, baseSha, dir);
  if (result.kind === 'invalid') {
    return usageAndExit(`${dir}: ${result.reason}`);
  }
  if (result.kind === 'absent') {
    return cannotVerifyAndExit(`${dir}: в git-объекте ${baseSha} нет ни одного *.json.`);
  }
  return { label: dir, tasks: result.tasks, leadPaths: result.leadPaths };
};

const normalizedPath = tasksPathArg.replace(/\/+$/, '');
const kind = gitPathKind(projectRoot, baseSha, normalizedPath);

const loaded: LoadedTasks =
  kind === 'blob'
    ? loadSingleFile(normalizedPath)
    : kind === 'tree'
      ? loadDirectory(normalizedPath)
      : cannotVerifyAndExit(
          `${tasksPathArg} отсутствует в git-объекте ${baseSha} (ни файл, ни каталог).`,
        );

const git = (args: readonly string[]): string[] =>
  execFileSync('git', [...args], { cwd: projectRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const changed = [
  ...git(['diff', '--name-only', baseSha]),
  ...git(['ls-files', '--others', '--exclude-standard']),
];

const report = checkOwnership([...new Set(changed)], loaded.tasks, loaded.leadPaths, 'lead-audit');

const byTask = new Map<string, number>();
for (const taskId of Object.values(report.ownedBy)) {
  byTask.set(taskId, (byTask.get(taskId) ?? 0) + 1);
}

console.log(`${loaded.label}: изменено файлов ${Object.keys(report.ownedBy).length}`);
for (const [taskId, count] of [...byTask.entries()].sort()) {
  console.log(`  ${taskId}: ${count}`);
}

if (report.problems.length > 0) {
  console.error('\nНарушения владения:');
  for (const problem of report.problems) console.error(`  - ${formatOwnershipProblem(problem)}`);
  process.exit(1);
}
console.log('Нарушений владения нет.');
