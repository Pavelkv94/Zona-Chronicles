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
  | { readonly kind: 'human-only'; readonly path: string };

export type OwnershipReport = {
  readonly problems: readonly OwnershipProblem[];
  readonly ownedBy: Readonly<Record<string, string>>;
};

/** Сопоставляет изменённые файлы с задачами и находит нарушения владения. */
export const checkOwnership = (
  changedFiles: readonly string[],
  tasks: readonly TaskDeclaration[],
  leadPaths: readonly string[] = [],
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
      if (matchesAnyGlob(path, leadPaths)) {
        ownedBy[path] = 'lead';
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
  }
};
