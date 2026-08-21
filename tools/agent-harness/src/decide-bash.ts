import { toRepoRelative } from './decide-write.ts';
import { matchesGlob } from './glob.ts';
import type { SessionRole } from './session-role.ts';
import type { WriteSetLoadResult } from './writeset.ts';

/**
 * Ограничение опасных Bash-команд для task-сессий (DEV-02).
 *
 * Это **второй** слой, а не основной: авторитетным контролем остаётся сверка
 * фактического `git diff` с declared write set (`diff-violations.ts`), потому что
 * разбор свободного текста команды принципиально обходим.
 *
 * Поэтому список запретов узкий и описывает операции, которые по
 * `10_ITERATION_MASTER_PLAN` §4 принадлежат исключительно orchestrator/lead:
 * установка зависимостей и операции интеграции истории.
 */
export type BashDecision = {
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
};

/**
 * M-8 (review, третий раунд) — команда разбивается на отдельные statement-ы ПЕРЕД любым
 * сопоставлением с паттернами, а не сопоставляется целиком одной строкой.
 *
 * До фикса `command.replace(/\s+/g, ' ')` схлопывал перевод строки в пробел ДО того, как
 * запускались regex-паттерны вида `\bcp\b[^|;&\n]*\.claude/`: класс символов `[^|;&\n]*` был
 * рассчитан на то, что `\n` остановит совпадение, но `\n` к этому моменту уже не существовало —
 * класс на практике вырождался в `[^|;&]*`, и `cp` из ПЕРВОЙ строки многострочной команды матчился
 * с `.claude/` из ПОСЛЕДНЕЙ, никак не связанной строки. Разбиение на statement-ы по `\n`, `;`,
 * `|`, `&` ДО сопоставления устраняет этот класс ошибок структурно: каждый паттерн проверяется
 * только внутри одного statement-а, который физически не может содержать эти разделители.
 */
const STATEMENT_SEPARATORS = /[\n;|&]+/;

const splitStatements = (command: string): readonly string[] =>
  command
    .split(STATEMENT_SEPARATORS)
    .map((statement) => statement.replace(/[ \t]+/g, ' ').trim())
    .filter((statement) => statement.length > 0);

const stripQuotes = (token: string): string => token.replace(/^['"]+|['"]+$/g, '');

/**
 * M-8 (review, третий раунд) — заменяет сопоставление литеральной подстроки `.claude/` на
 * резолв реального пути относительно `projectRoot`, тем же механизмом, что и авторитетный слой
 * (`toRepoRelative` из `decide-write.ts`).
 *
 * До фикса правило срабатывало на ЛЮБОЕ упоминание текста `.claude/` где угодно в команде, в том
 * числе вне корня репозитория: воспроизведено на построении временного git-репозитория в
 * scratchpad (путь вне репозитория, случайно содержащий сегмент `.claude/`) и на диагностическом
 * `node -e "… decideBashCommand('cp -R /tmp/a /tmp/b/.claude/') …"`, где текст `.claude/` — часть
 * строкового литерала внутри аргумента `node -e`, а не путь, по которому что-либо пишется в ЭТОМ
 * репозитории. Здесь токенизируется statement, каждый токен резолвится через `toRepoRelative`, и
 * правило срабатывает только если РЕЗУЛЬТАТ резолва (путь относительно `projectRoot`) совпадает с
 * `.claude/**`. Абсолютный путь вне `projectRoot` резолвится в `null` (см. `toRepoRelative`) и не
 * совпадает никогда, даже если текстуально содержит `.claude/`.
 *
 * Документированная граница (не полнота, как и раньше): токенизация — по пробелам с грубым
 * снятием ведущих/хвостовых кавычек, а не полноценный shell-парсер (кавычки с пробелами внутри,
 * `$VAR`-подстановки, косвенные пути — не распознаются, см. общий docstring ниже).
 */
const statementTargetsClaudeDir = (statement: string, projectRoot: string): boolean =>
  statement
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .some((token) => {
      const cleaned = stripQuotes(token);
      if (!cleaned.includes('.claude')) return false;
      const repoRelative = toRepoRelative(cleaned, projectRoot);
      return repoRelative !== null && matchesGlob(repoRelative, '.claude/**');
    });

type Rule = {
  readonly verb: RegExp;
  readonly reason: string;
  /** `true` — правило дополнительно требует, чтобы statement резолвился в путь внутри `.claude/**`
   * относительно `projectRoot` (M-8). `false` — верб сам по себе достаточен (lead-only команды). */
  readonly requiresClaudeDirTarget: boolean;
};

/**
 * N2 review finding (второй раунд верификации), первый (не авторитетный) слой.
 *
 * До фикса `decideBashForSession` проверяла только список lead-only команд и не смотрела на пути
 * записи вообще: `cat > .claude/writeset.json <<...` не совпадал ни с одним правилом выше →
 * allow. После этого task-сессия могла выписать себе `{"write_paths":["**"],"allow_protected_paths":
 * ["**"]}` и пройти `pre-tool-use-write.ts`/`subagent-stop-writeset.ts`, потому что источник их
 * решения — тот же файл.
 *
 * Здесь — узкий набор проверок для конкретных операций записи в `.claude/**`, а не попытка
 * разобрать shell целиком (это принципиально невозможно регуляркой, см. docstring файла).
 * Авторитетный слой — `loadWriteSetFromGit`/`loadTaskDeclarationsFromGit` в `subagent-stop-writeset.ts`
 * (`../git-source.ts`): он не доверяет рабочему дереву вовсе, поэтому даже полный обход этого
 * списка не расширяет фактические права — он просто не будет пойман здесь, а будет пойман на
 * `SubagentStop` как protected-path violation.
 *
 * Что этот слой **не** ловит (документированная граница, не полнота):
 *   - запись через интерпретируемый код внутри команды: `python3 -c "open('.claude/writeset.json',
 *     'w').write(...)"`, `node -e`, `perl -e`, `awk`, `dd of=...` (если сам путь не встречается
 *     текстовым токеном в команде — например, собран из конкатенации строк внутри интерпретатора);
 *   - запись через переменные/косвенные пути: `f=.claude/writeset.json; cat > "$f"`,
 *     конкатенацию строк, `eval`, base64-декодирование пути;
 *   - запись по абсолютному пути, если он не резолвится в `.claude/**` относительно `projectRoot`
 *     (симлинк, переход через другой worktree на тот же файл);
 *   - вложенные кавычки/экранирование, ломающие простой токенизатор по пробелам (M-8).
 */
const CLAUDE_DIR_WRITE_RULES: readonly Rule[] = [
  {
    verb: />{1,2}/,
    reason:
      'Перенаправление вывода (>/>>) в .claude/** запрещено task-сессии: это источник её же ' +
      'ограничений (N2). Изменение вносит orchestrator/lead.',
    requiresClaudeDirTarget: true,
  },
  {
    verb: /\btee\b/,
    reason: '`tee` в .claude/** запрещён task-сессии: это источник её же ограничений (N2).',
    requiresClaudeDirTarget: true,
  },
  {
    verb: /\b(cp|mv)\b/,
    reason:
      '`cp`/`mv`, нацеленные на .claude/**, запрещены task-сессии: это источник её же ' +
      'ограничений (N2).',
    requiresClaudeDirTarget: true,
  },
  {
    verb: /\brm\b/,
    reason:
      'Удаление файлов в .claude/** запрещено task-сессии (тот же класс, что и исходный B2: ' +
      '`rm -f .claude/writeset.json`).',
    requiresClaudeDirTarget: true,
  },
  {
    verb: /\bsed\b[\s\S]*-i\b/,
    reason:
      '`sed -i` над файлом в .claude/** запрещён task-сессии: это источник её же ограничений (N2).',
    requiresClaudeDirTarget: true,
  },
  {
    verb: /\btruncate\b/,
    reason:
      '`truncate` файла в .claude/** запрещён task-сессии: это источник её же ограничений (N2).',
    requiresClaudeDirTarget: true,
  },
];

const LEAD_ONLY_RULES: readonly Rule[] = [
  {
    verb: /\b(pnpm|npm|yarn|bun)\s+(i|add|install|update|upgrade|remove|link)\b/,
    reason: 'Установку и изменение зависимостей выполняет только orchestrator/lead (ADR-008).',
    requiresClaudeDirTarget: false,
  },
  {
    verb: /\bcorepack\s+(enable|prepare|install)\b/,
    reason: 'Изменение package manager выполняет только orchestrator/lead.',
    requiresClaudeDirTarget: false,
  },
  {
    verb: /\bgit\s+(push|merge|rebase|cherry-pick|revert)\b/,
    reason:
      'Интеграцию веток выполняет только orchestrator/lead; subagent возвращает commits и handoff.',
    requiresClaudeDirTarget: false,
  },
  {
    verb: /\bgit\s+reset\s+--hard\b/,
    reason: 'Destructive reset запрещён внутри задачи: он уничтожает evidence итерации.',
    requiresClaudeDirTarget: false,
  },
  {
    verb: /\bgit\s+stash\b/,
    reason: 'Скрытый stash запрещён: изменения обязаны оставаться видимыми в diff.',
    requiresClaudeDirTarget: false,
  },
  {
    verb: /\bgit\s+(clean\s+-[a-z]*f|checkout\s+--\s+\.)/,
    reason: 'Массовое удаление незакоммиченных изменений запрещено внутри задачи.',
    requiresClaudeDirTarget: false,
  },
  {
    verb: /\bgit\s+commit\b[\s\S]*--no-verify\b/,
    reason: 'Обход pre-commit проверок запрещён.',
    requiresClaudeDirTarget: false,
  },
];

/**
 * Проверяет ОДНО правило против statement-а. Для `requiresClaudeDirTarget` ищет путь-цель не по
 * всему statement-у, а только в тексте ПОСЛЕ совпадения verb-а (`match.index + match[0].length`).
 *
 * Найдено при собственной проверке этого фикса (не из отчёта review, но тот же класс M-8): без
 * этого ограничения `node script.ts .claude/tasks 0a77b90 2>&1 | tail` ложно запрещался — токен
 * `.claude/tasks` был обычным, ДО-verb-овым аргументом самого `node`-скрипта (путь читается, не
 * записывается), а `>` был частью `2>&1` (дублирование файлового дескриптора, а не редирект в
 * файл); `[\n;|&]+`-разбиение на statement-ы (см. `splitStatements`) режет одиночный `&` внутри
 * `2>&1` и оставляет обрывок `...0a77b90 2>`, в котором ЕСТЬ и `.claude/tasks` (до обрывка), и `>`
 * (сам обрывок) — но это два НЕСВЯЗАННЫХ факта одного текста. Ограничение поиска зоной ПОСЛЕ
 * verb-а устраняет это: цель редиректа/`cp`/`mv`/`rm`/`tee`/`sed -i`/`truncate` находится СПРАВА
 * от глагола, как и в реальном shell-синтаксисе (`cmd > target`, `cp src dst`), а не где угодно в
 * statement-е.
 */
const ruleMatchesStatement = (rule: Rule, statement: string, projectRoot: string): boolean => {
  const match = rule.verb.exec(statement);
  if (match === null) return false;
  if (!rule.requiresClaudeDirTarget) return true;
  const targetZone = statement.slice(match.index + match[0].length);
  return statementTargetsClaudeDir(targetZone, projectRoot);
};

/** Чистое решение по строке Bash-команды task-сессии, без учёта роли/write set/owner_role.
 * `projectRoot` нужен, чтобы M-8-правила резолвили путь, а не сравнивали текст (см. выше). */
export const decideBashCommand = (command: string, projectRoot: string): BashDecision => {
  const statements = splitStatements(command);
  for (const statement of statements) {
    for (const rule of [...CLAUDE_DIR_WRITE_RULES, ...LEAD_ONLY_RULES]) {
      if (!ruleMatchesStatement(rule, statement, projectRoot)) continue;
      return { decision: 'deny', reason: rule.reason };
    }
  }
  return { decision: 'allow', reason: 'Команда не входит в список операций orchestrator/lead.' };
};

/**
 * M-7 (review, третий раунд) — read-only reviewer: текущий (узкий) список запретов остаётся, плюс
 * `git commit` запрещён отдельно. Reviewer уже не может писать ни один файл через Write/Edit-
 * инструменты (`decideWrite` с пустым `write_paths` — см. `writeset.ts`), но Bash сам по себе
 * этот список НЕ проверяет на запись куда угодно (только на запись в `.claude/**` и на lead-only
 * операции) — обычные перенаправления вне `.claude/**` (`echo x > foo.ts`) им не ловятся. Явный
 * запрет `git commit` закрывает ту его часть, что явно попросил review (ADR-008: reviewer read-
 * only). Полная герметизация записи через Bash для reviewer не входит в объявленную границу этого
 * слоя (см. общий docstring файла) и остаётся backstop-ом diff-проверки на `SubagentStop`: там
 * `write_paths: []` не совпадает вообще ни с одним изменённым файлом.
 */
const REVIEWER_DENY_RULES: readonly Rule[] = [
  {
    verb: /\bgit\s+commit\b/,
    reason: 'Reviewer-роль read-only (ADR-008, M-7): git commit запрещён.',
    requiresClaudeDirTarget: false,
  },
];

const decideBashForReviewer = (command: string, projectRoot: string): BashDecision => {
  for (const statement of splitStatements(command)) {
    for (const rule of REVIEWER_DENY_RULES) {
      if (ruleMatchesStatement(rule, statement, projectRoot)) {
        return { decision: 'deny', reason: rule.reason };
      }
    }
  }
  return decideBashCommand(command, projectRoot);
};

export type BashSessionRequest = {
  readonly command: string;
  readonly projectRoot: string;
  /** Роль по `classifySession` (payload `agent_id`/`agent_type`), не по наличию writeset.json. */
  readonly sessionRole: SessionRole;
  readonly writeSet: WriteSetLoadResult;
};

/**
 * Композиция роли сессии + declared write set + `decideBashCommand` (B2 review finding).
 *
 * До фикса hook для Bash пропускал task-сессию без ограничений, если `.claude/writeset.json`
 * отсутствовал (тот же файл, который task-сессия может удалить сама). Здесь роль определяется
 * payload-ом: lead работает без ограничений; task-сессия без валидного write set получает
 * fail-closed deny ещё до применения списка запрещённых команд — lead обязан объявить write set
 * до запуска задачи.
 */
export const decideBashForSession = ({
  command,
  projectRoot,
  sessionRole,
  writeSet,
}: BashSessionRequest): BashDecision => {
  if (sessionRole === 'lead') {
    return {
      decision: 'allow',
      reason: 'Lead-сессия: ограничений orchestrator/lead-операций нет.',
    };
  }

  if (writeSet.kind === 'invalid') {
    return { decision: 'deny', reason: `Fail-closed: ${writeSet.reason}` };
  }

  if (writeSet.kind === 'lead') {
    return {
      decision: 'deny',
      reason:
        'Task-сессия без объявленного write set: lead обязан объявить .claude/writeset.json ' +
        'до запуска задачи. Отсутствие файла — fail-closed, а не разрешение.',
    };
  }

  return writeSet.writeSet.owner_role === 'reviewer'
    ? decideBashForReviewer(command, projectRoot)
    : decideBashCommand(command, projectRoot);
};
