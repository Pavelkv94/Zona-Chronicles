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
  /**
   * Итерация, к которой принадлежит задача (finding раунда фиксов I00-F5, найден на живом
   * прогоне: каталожный `ownership:check .claude/tasks <base>` объединяет ВСЕ `.claude/tasks/*.json`
   * без учёта времени — `I00-T04` и `I00-F5-T4` заявляют один и тот же путь в РАЗНЫХ итерациях,
   * разнесённых во времени, и до фикса это читалось как `overlap`, хотя конфликта нет: во второй
   * итерации путь просто правится снова, это ожидаемо). Заполняется из `iteration_id` файла карты
   * задач (`tasks-directory.ts`), не из самого JSON-объекта задачи. `undefined` — карта без
   * `iteration_id` (более старый формат); такие задачи трактуются как принадлежащие одному общему
   * «безымянному» bucket-у для обратной совместимости с уже существующими тестами/фикстурами.
   */
  readonly iteration_id?: string;
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

    // Пересечение — конфликт только ВНУТРИ одной итерации: параллельные задачи одной итерации не
    // вправе делить путь. Между итерациями — норма (тот же путь правится снова позже), поэтому
    // задачи из РАЗНЫХ `iteration_id` здесь не считаются конфликтующими друг с другом (finding
    // раунда I00-F5, живой прогон каталожного `ownership:check`). Задачи без `iteration_id`
    // (`undefined`) остаются одним общим bucket-ом — сохраняет прежнее поведение для карт без
    // этого поля.
    const owningIterationIds = new Set(owners.map((task) => task.iteration_id ?? ''));
    if (owningIterationIds.size > 1) {
      const byIteration = new Map<string, TaskDeclaration[]>();
      for (const task of owners) {
        const key = task.iteration_id ?? '';
        const bucket = byIteration.get(key) ?? [];
        bucket.push(task);
        byIteration.set(key, bucket);
      }
      const sameIterationOverlap = [...byIteration.values()].find((bucket) => bucket.length > 1);
      if (sameIterationOverlap !== undefined) {
        problems.push({
          kind: 'overlap',
          path,
          taskIds: sameIterationOverlap.map((task) => task.task_id),
        });
        continue;
      }
      // Ровно один владелец на итерацию, итераций несколько: не конфликт. Детерминированный
      // (не смысловой, только для отчёта `ownedBy`) выбор — последняя по порядку `tasks`
      // (соответствует порядку файлов карты, `tasks-directory.ts` сортирует их по имени, то есть
      // обычно совпадает с более новой итерацией при обычных именах вида `I00.json`/`I00-F5.json`).
      const chosen = owners[owners.length - 1] as TaskDeclaration;
      const allowedProtectedChosen = chosen.allow_protected_paths ?? [];
      if (matchesAnyGlob(path, PROTECTED_PATHS) && !matchesAnyGlob(path, allowedProtectedChosen)) {
        problems.push({ kind: 'protected', path, taskId: chosen.task_id });
        continue;
      }
      ownedBy[path] = chosen.task_id;
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
