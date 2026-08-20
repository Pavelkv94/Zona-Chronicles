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

/** Чистое решение по строке Bash-команды task-сессии. */
export const decideBashCommand = (command: string): BashDecision => {
  const normalized = command.replace(/\s+/g, ' ').trim();
  for (const rule of LEAD_ONLY_RULES) {
    if (rule.pattern.test(normalized)) {
      return { decision: 'deny', reason: rule.reason };
    }
  }
  return { decision: 'allow', reason: 'Команда не входит в список операций orchestrator/lead.' };
};
