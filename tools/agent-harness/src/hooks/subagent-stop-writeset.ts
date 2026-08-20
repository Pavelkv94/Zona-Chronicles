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
 *
 * N1/N2 review finding (второй раунд верификации), два независимых слоя:
 *
 * N1 — `.claude/tasks/*.json` содержит `lead_paths`, и до фикса совпадение с ним трактовалось
 * как владение lead-а даже в контексте task-сессии: `rm -f .claude/writeset.json` откатывал
 * hook на карту задач, где `README.md`/`.claude/**` и другие lead-only пути молча становились
 * `ownedBy: 'lead'`. Исправлено через `checkOwnership(..., 'task-session')`: в этом режиме
 * совпадение только с `lead_paths` — нарушение (`lead-only`), а не владение.
 *
 * N2 — источник ограничений (`.claude/writeset.json`, `.claude/tasks/*.json`) читался с диска,
 * то есть из write path, доступного самой ограничиваемой task-сессии через Bash в обход
 * PreToolUse-слоёв (`cat > .claude/writeset.json <<...`). Исправлено чтением из git-объекта
 * `HEAD` (`loadWriteSetFromGit`/`loadTaskDeclarationsFromGit`, `../git-source.ts`): рабочее дерево
 * для этого решения больше не читается вовсе, а `git commit` не создаёт новый контент — только
 * фиксирует то, что уже есть, куда Bash-эвристика в `decide-bash.ts` не даёт записать `.claude/**`.
 */
import { execFileSync } from 'node:child_process';
import { findDiffViolations, formatViolations } from '../diff-violations.ts';
import { classifySession } from '../session-role.ts';
import { checkOwnership, formatOwnershipProblem } from '../task-ownership.ts';
import { loadTaskDeclarationsFromGit } from '../tasks-directory.ts';
import { loadWriteSetFromGit } from '../writeset.ts';
import { readHookInput } from './read-stdin.ts';

/**
 * База сравнения для источника ограничений — тот же коммит, который уже служит базой для
 * `git diff --name-only HEAD` ниже. Задавать иной base-коммит явно (env/CLI-параметр) для hook-а
 * некуда: hook запускается автоматически, без интерактивного ввода, а `.claude/settings.json`
 * (owner — lead) не в write scope этого фикса. `HEAD` резолвится в git-объект всегда, кроме
 * репозитория без единого коммита, — в этом (единственном) случае ниже сработает fail-closed.
 */
const BASE_REF = 'HEAD';

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

  const loaded = loadWriteSetFromGit(projectRoot, BASE_REF);

  if (loaded.kind === 'invalid') {
    fail(
      `Fail-closed: .claude/writeset.json недоступен из git-объекта ${BASE_REF}: ${loaded.reason}`,
    );
    return;
  }

  if (loaded.kind === 'task') {
    const violations = findDiffViolations(uniqueChanged, loaded.writeSet);
    if (violations.length > 0) {
      fail(formatViolations(violations, loaded.writeSet.task_id));
    }
    return;
  }

  // loaded.kind === 'lead' — .claude/writeset.json отсутствует в git-объекте BASE_REF (в т.ч. никогда
  // не был закоммичен, включая попытку подменить/удалить его в рабочем дереве — N2). Task-сессия
  // обязана быть покрыта картой задач итерации; иначе завершение блокируется.
  const tasksResult = loadTaskDeclarationsFromGit(projectRoot, BASE_REF);

  if (tasksResult.kind === 'invalid') {
    fail(
      `Fail-closed: .claude/tasks/*.json недоступна из git-объекта ${BASE_REF}: ${tasksResult.reason}`,
    );
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

  // N1: leadPaths здесь не дают владения — только фиксируют нарушение (см. checkOwnership doc).
  const report = checkOwnership(
    uniqueChanged,
    tasksResult.tasks,
    tasksResult.leadPaths,
    'task-session',
  );
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
