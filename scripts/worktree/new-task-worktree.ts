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
  'Использование: node scripts/worktree/new-task-worktree.ts <карта-задач.json> <task-id> ' +
  '[каталог] [--base <ref>]';

const argv = process.argv.slice(2);
const baseFlagIndex = argv.indexOf('--base');
const baseFromFlag = baseFlagIndex === -1 ? undefined : argv[baseFlagIndex + 1];
if (baseFlagIndex !== -1 && baseFromFlag === undefined) fail('--base требует значение (ref)');
const positional =
  baseFlagIndex === -1 ? argv : [...argv.slice(0, baseFlagIndex), ...argv.slice(baseFlagIndex + 2)];
const [tasksPathArg, taskIdArg, dirArg] = positional;
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

const map = parsed as {
  readonly iteration_id?: unknown;
  readonly base_commit?: unknown;
  readonly tasks?: unknown;
};
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

/**
 * Reviewer-сессии тоже получают worktree — и это не симметрия ради симметрии.
 *
 * `PLAN.md` §8.6 I02A: изоляция была введена для исполнителей, а верификация продолжала идти в
 * общем дереве. Живой прогон I02A показал цену: пока reviewer работал, lead коммитил, и
 * SubagentStop дважды приписал ему чужие правки — вторая блокировка едва не потеряла его отчёт.
 * Это тот же F5-3, просто с другой ролью.
 *
 * Отличие от worktree исполнителя одно, но существенное: reviewer создаётся от КОММИТА, который
 * он проверяет, а не от текущего HEAD. Тогда последующая работа lead-а физически не попадает в
 * его дерево, а `git diff <base>..HEAD` внутри worktree описывает ровно проверяемый диапазон.
 */
const isReviewer = task!.owner_role === 'reviewer';
const baseRef =
  baseFromFlag ?? (typeof map.base_commit === 'string' ? map.base_commit : undefined) ?? 'HEAD';
const branch = `${isReviewer ? 'review' : 'task'}/${taskIdArg}`;
process.stdout.write(`Создаю worktree ${worktreeDir} на ветке ${branch} от ${baseRef}\n`);
git(['worktree', 'add', '-b', branch, worktreeDir, baseRef]);

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
// Коммит только если файл действительно изменился: у reviewer-сессии, созданной от коммита, в
// котором её write set уже объявлен, коммитить нечего, и `git commit` там падает с «nothing to
// commit» — найдено исполнением при первой же пробе.
const staged = git(['status', '--porcelain', '--', '.claude/writeset.json'], worktreeDir).trim();
if (staged.length > 0) {
  git(
    ['commit', '-q', '-m', `${taskIdArg}: declare write set for the isolated worktree`],
    worktreeDir,
  );
  process.stdout.write('Write set объявлен и закоммичен.\n');
} else {
  process.stdout.write('Write set уже объявлен в базовом коммите — коммитить нечего.\n');
}

process.stdout.write(
  [
    '',
    `Готово. Задача ${taskIdArg} (${task!.owner_role}) изолирована.`,
    `  каталог: ${worktreeDir}`,
    `  ветка:   ${branch}`,
    `  write_paths: ${task!.write_paths.join(', ') || '(пусто — только чтение)'}`,
    `  база:    ${baseRef}`,
    '',
    isReviewer
      ? 'Дерево зафиксировано на проверяемом коммите: работа lead-а сюда не попадёт, и вердикт\n' +
        'о владении путями относится к сессии, а не к общему дереву (PLAN §8.6 I02A).'
      : 'Diff этого worktree и есть работа сессии: атрибуция больше не требует догадок (F5-3).',
    '',
  ].join('\n'),
);
