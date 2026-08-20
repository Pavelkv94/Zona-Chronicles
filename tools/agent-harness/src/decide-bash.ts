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

type Rule = {
  readonly pattern: RegExp;
  readonly reason: string;
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
 *     'w').write(...)"`, `node -e`, `perl -e`, `awk`, `dd of=...`;
 *   - запись через переменные/косвенные пути: `f=.claude/writeset.json; cat > "$f"`,
 *     конкатенацию строк, `eval`, base64-декодирование пути;
 *   - запись по абсолютному пути, если он не содержит буквально `.claude/`
 *     (симлинк, `$PWD/../…`, переход через другой worktree на тот же файл);
 *   - вложенные кавычки/экранирование, ломающие простые текстовые паттерны.
 */
const PROTECTED_DIR = '\\.claude/';
const CLAUDE_DIR_WRITE_RULES: readonly Rule[] = [
  {
    pattern: new RegExp(`>{1,2}\\s*['"]?(\\./)?${PROTECTED_DIR}`),
    reason:
      'Перенаправление вывода (>/>>) в .claude/** запрещено task-сессии: это источник её же ' +
      'ограничений (N2). Изменение вносит orchestrator/lead.',
  },
  {
    pattern: new RegExp(`\\btee\\b[^|;&\\n]*${PROTECTED_DIR}`),
    reason: '`tee` в .claude/** запрещён task-сессии: это источник её же ограничений (N2).',
  },
  {
    pattern: new RegExp(`\\b(cp|mv)\\b[^|;&\\n]*${PROTECTED_DIR}`),
    reason:
      '`cp`/`mv`, упоминающие .claude/**, запрещены task-сессии: это источник её же ' +
      'ограничений (N2). Правило намеренно шире факта записи (ловит и чтение из .claude/** этой ' +
      'командой), потому что различить источник и назначение без разбора shell ненадёжно.',
  },
  {
    pattern: new RegExp(`\\brm\\b[^|;&\\n]*${PROTECTED_DIR}`),
    reason:
      'Удаление файлов в .claude/** запрещено task-сессии (тот же класс, что и исходный B2: ' +
      '`rm -f .claude/writeset.json`).',
  },
  {
    pattern: new RegExp(`\\bsed\\b[^|;&\\n]*-i[^|;&\\n]*${PROTECTED_DIR}`),
    reason:
      '`sed -i` над файлом в .claude/** запрещён task-сессии: это источник её же ограничений (N2).',
  },
  {
    pattern: new RegExp(`\\btruncate\\b[^|;&\\n]*${PROTECTED_DIR}`),
    reason:
      '`truncate` файла в .claude/** запрещён task-сессии: это источник её же ограничений (N2).',
  },
];

const LEAD_ONLY_RULES: readonly Rule[] = [
  {
    pattern: /\b(pnpm|npm|yarn|bun)\s+(i|add|install|update|upgrade|remove|link)\b/,
    reason: 'Установку и изменение зависимостей выполняет только orchestrator/lead (ADR-008).',
  },
  {
    pattern: /\bcorepack\s+(enable|prepare|install)\b/,
    reason: 'Изменение package manager выполняет только orchestrator/lead.',
  },
  {
    pattern: /\bgit\s+(push|merge|rebase|cherry-pick|revert)\b/,
    reason:
      'Интеграцию веток выполняет только orchestrator/lead; subagent возвращает commits и handoff.',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason: 'Destructive reset запрещён внутри задачи: он уничтожает evidence итерации.',
  },
  {
    pattern: /\bgit\s+stash\b/,
    reason: 'Скрытый stash запрещён: изменения обязаны оставаться видимыми в diff.',
  },
  {
    pattern: /\bgit\s+(clean\s+-[a-z]*f|checkout\s+--\s+\.)/,
    reason: 'Массовое удаление незакоммиченных изменений запрещено внутри задачи.',
  },
  {
    pattern: /\bgit\s+commit\b[^|;]*--no-verify\b/,
    reason: 'Обход pre-commit проверок запрещён.',
  },
];

/** Чистое решение по строке Bash-команды task-сессии, без учёта роли/write set. */
export const decideBashCommand = (command: string): BashDecision => {
  const normalized = command.replace(/\s+/g, ' ').trim();
  for (const rule of [...CLAUDE_DIR_WRITE_RULES, ...LEAD_ONLY_RULES]) {
    if (rule.pattern.test(normalized)) {
      return { decision: 'deny', reason: rule.reason };
    }
  }
  return { decision: 'allow', reason: 'Команда не входит в список операций orchestrator/lead.' };
};

export type BashSessionRequest = {
  readonly command: string;
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

  return decideBashCommand(command);
};
