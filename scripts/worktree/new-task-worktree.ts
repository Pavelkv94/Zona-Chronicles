#!/usr/bin/env node
/**
 * Создаёт изолированный git worktree для одной task-сессии (DEV-02, ADR-008).
 *
 * Зачем это существует. Раунд I00-F5 предъявил цену общего рабочего дерева тремя
 * независимыми findings, и каждый из них неустраним по отдельности:
 *
 *   F5-1 — hook блокировал завершение сессии за чужие изменения, и сессия не могла
 *          ни исправить их, ни прекратить работу;
 *   F5-2 — task-сессия правит исполняемый скрипт hook-а, который в этот момент
 *          запускается всеми остальными сессиями;
 *   F5-3 — вердикт о владении путями относится к дереву, а не к сессии: в общем дереве
 *          у diff нет автора. Подтверждено на живом примере — фикс заблокировал
 *          собственного автора за коммиты lead-а.
 *
 * Изоляция снимает все три сразу: diff worktree и есть работа сессии, `.claude/writeset.json`
 * перестаёт быть одним файлом на всех, а скрипт hook-а перестаёт быть общим изменяемым
 * состоянием.
 *
 * Отклонение `PLAN.md` §8 обосновывалось тем, что свежий worktree не имеет `node_modules`,
 * а установка зависимостей запрещена feature-агентам, и подлежало пересмотру, «когда появится
 * bootstrap без установки агентом». Этот скрипт и есть тот bootstrap: устанавливает **lead**,
 * до передачи worktree агенту. Благодаря content-addressable store pnpm установка занимает
 * секунды и почти не занимает диска — пакеты приходят хардлинками из общего store.
 *
 * Write set задачи берётся из карты итерации и материализуется внутри worktree. Права
 * объявляет lead до старта задачи — как и требует протокол; отличие лишь в том, что теперь
 * у каждой задачи свой файл, а не общий на всех.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

type TaskDeclaration = {
  readonly task_id: string;
  readonly owner_role: string;
  readonly write_paths: readonly string[];
  readonly allow_protected_paths?: readonly string[];
};

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const usage =
  'Использование: node scripts/worktree/new-task-worktree.ts <карта-задач.json> <task-id> [каталог]';

const [, , tasksPathArg, taskIdArg, dirArg] = process.argv;
if (tasksPathArg === undefined || taskIdArg === undefined) fail(usage);

const projectRoot = process.cwd();
const tasksPath = resolve(projectRoot, tasksPathArg!);
if (!existsSync(tasksPath)) fail(`Карта задач не найдена: ${tasksPath}`);

let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(tasksPath, 'utf8'));
} catch (error) {
  fail(`Карта задач не является валидным JSON: ${String(error)}`);
}

const map = parsed as { readonly iteration_id?: unknown; readonly tasks?: unknown };
if (!Array.isArray(map.tasks)) fail('Карта задач: обязательное поле tasks (список).');

const task = (map.tasks as readonly TaskDeclaration[]).find((item) => item.task_id === taskIdArg);
if (task === undefined) {
  const known = (map.tasks as readonly TaskDeclaration[]).map((item) => item.task_id).join(', ');
  // Fail-closed: неизвестная задача не получает worktree с пустыми или широкими правами.
  fail(`Задача ${taskIdArg} отсутствует в ${tasksPathArg}. Объявленные задачи: ${known}`);
}

const worktreeDir =
  dirArg ?? join(dirname(projectRoot), `${basename(projectRoot)}-wt-${taskIdArg!.toLowerCase()}`);
if (existsSync(worktreeDir)) fail(`Каталог уже существует: ${worktreeDir}`);

const git = (args: readonly string[], cwd = projectRoot): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' });

const branch = `task/${taskIdArg}`;
process.stdout.write(`Создаю worktree ${worktreeDir} на ветке ${branch}\n`);
git(['worktree', 'add', '-b', branch, worktreeDir]);

// Bootstrap делает lead, а не агент: установка зависимостей — операция orchestrator/lead
// (ADR-008), и запрет на неё для task-сессии остаётся в силе внутри worktree.
process.stdout.write('Устанавливаю зависимости (--frozen-lockfile)\n');
execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: worktreeDir, stdio: 'inherit' });

const writeSet: TaskDeclaration = {
  task_id: task!.task_id,
  owner_role: task!.owner_role,
  write_paths: task!.write_paths,
  ...(task!.allow_protected_paths === undefined
    ? {}
    : { allow_protected_paths: task!.allow_protected_paths }),
};
mkdirSync(join(worktreeDir, '.claude'), { recursive: true });
writeFileSync(
  join(worktreeDir, '.claude', 'writeset.json'),
  `${JSON.stringify(writeSet, null, 2)}\n`,
  'utf8',
);

// Коммит обязателен: PreToolUse читает write set с диска, а SubagentStop — из git-объекта.
// Незакоммиченный файл разблокировал бы работу и завалил завершение как untracked путь
// в .claude/**.
git(['add', '.claude/writeset.json'], worktreeDir);
git(
  ['commit', '-q', '-m', `${taskIdArg}: declare write set for the isolated worktree`],
  worktreeDir,
);

process.stdout.write(
  [
    '',
    `Готово. Задача ${taskIdArg} (${task!.owner_role}) изолирована.`,
    `  каталог: ${worktreeDir}`,
    `  ветка:   ${branch}`,
    `  write_paths: ${task!.write_paths.join(', ') || '(пусто — только чтение)'}`,
    '',
    'Diff этого worktree и есть работа сессии: атрибуция больше не требует догадок (F5-3).',
    '',
  ].join('\n'),
);
