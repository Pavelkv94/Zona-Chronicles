import { matchesAnyGlob } from './glob.ts';
import { HUMAN_ONLY_PATHS, PROTECTED_PATHS } from './protected-paths.ts';

/**
 * Владение путями при параллельном исполнении задач итерации.
 *
 * `.claude/writeset.json` описывает ровно одну активную задачу и работает для
 * последовательного исполнения. Когда lead запускает несколько implementer-задач
 * одновременно в одном worktree, ownership проверяется по объявленной карте задач:
 * каждый изменённый файл обязан принадлежать ровно одной задаче.
 */
export type TaskDeclaration = {
  readonly task_id: string;
  readonly owner_role: string;
  readonly write_paths: readonly string[];
  readonly allow_protected_paths?: readonly string[];
};

export type OwnershipProblem =
  | { readonly kind: 'unowned'; readonly path: string }
  | { readonly kind: 'overlap'; readonly path: string; readonly taskIds: readonly string[] }
  | { readonly kind: 'protected'; readonly path: string; readonly taskId: string }
  | { readonly kind: 'human-only'; readonly path: string }
  | { readonly kind: 'lead-only'; readonly path: string };

export type OwnershipReport = {
  readonly problems: readonly OwnershipProblem[];
  readonly ownedBy: Readonly<Record<string, string>>;
};

/**
 * Режим проверки (N1 review finding, второй раунд верификации).
 *
 * `lead_paths` объявляет пути, которые вправе менять lead — это утверждение имеет смысл только
 * когда проверку **выполняет lead** над всем деревом (`ownership:check`, режим `'lead-audit'`):
 * тогда файл, попадающий только в `lead_paths`, законно принадлежит lead-у.
 *
 * Когда те же данные использует `subagent-stop-writeset.ts` для завершения **task-сессии**
 * (режим `'task-session'`), то же совпадение обязано быть нарушением: `lead_paths` описывает
 * «это меняет lead», а не «это разрешено менять субагенту, потому что путь есть в чьём-то
 * списке». До этого фикса `checkOwnership` не различала режимы и трактовала `lead_paths` как
 * законное владение в обоих случаях — удаление `.claude/writeset.json` task-сессией превращало
 * запрет в разрешение (файлы вроде `README.md`, `.claude/settings.autonomous.json` проходили как
 * `ownedBy: 'lead'` ещё до проверки `PROTECTED_PATHS`).
 */
export type OwnershipMode = 'lead-audit' | 'task-session';

/** Сопоставляет изменённые файлы с задачами и находит нарушения владения. */
export const checkOwnership = (
  changedFiles: readonly string[],
  tasks: readonly TaskDeclaration[],
  leadPaths: readonly string[] = [],
  mode: OwnershipMode = 'lead-audit',
): OwnershipReport => {
  const problems: OwnershipProblem[] = [];
  const ownedBy: Record<string, string> = {};

  for (const path of changedFiles) {
    if (path.length === 0) continue;

    if (matchesAnyGlob(path, HUMAN_ONLY_PATHS)) {
      problems.push({ kind: 'human-only', path });
      continue;
    }

    const owners = tasks.filter((task) => matchesAnyGlob(path, task.write_paths));

    if (owners.length === 0) {
      const matchesLeadPaths = matchesAnyGlob(path, leadPaths);
      if (matchesLeadPaths && mode === 'lead-audit') {
        ownedBy[path] = 'lead';
        continue;
      }
      if (matchesLeadPaths && mode === 'task-session') {
        problems.push({ kind: 'lead-only', path });
        continue;
      }
      problems.push({ kind: 'unowned', path });
      continue;
    }
    if (owners.length > 1) {
      problems.push({ kind: 'overlap', path, taskIds: owners.map((task) => task.task_id) });
      continue;
    }

    const owner = owners[0] as TaskDeclaration;
    const allowedProtected = owner.allow_protected_paths ?? [];
    if (matchesAnyGlob(path, PROTECTED_PATHS) && !matchesAnyGlob(path, allowedProtected)) {
      problems.push({ kind: 'protected', path, taskId: owner.task_id });
      continue;
    }
    ownedBy[path] = owner.task_id;
  }

  return { problems, ownedBy };
};

export const formatOwnershipProblem = (problem: OwnershipProblem): string => {
  switch (problem.kind) {
    case 'unowned':
      return `${problem.path}: изменён, но не принадлежит ни одной объявленной задаче`;
    case 'overlap':
      return `${problem.path}: пересечение write sets задач ${problem.taskIds.join(', ')}`;
    case 'protected':
      return `${problem.path}: protected path, задача ${problem.taskId} им не владеет`;
    case 'human-only':
      return `${problem.path}: секреты и ключи редактирует только человек`;
    case 'lead-only':
      return `${problem.path}: путь принадлежит только lead-у (lead_paths); task-сессия не может владеть им`;
  }
};
