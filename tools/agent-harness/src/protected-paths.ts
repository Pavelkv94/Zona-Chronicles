/**
 * Protected paths по `08_TDD_AND_AGENT_WORKFLOW` §12.1 и `10_ITERATION_MASTER_PLAN` §4.
 *
 * В каждый момент времени у этих путей ровно один writer — orchestrator/lead.
 * Список исполняется hook-ом и повторяется в CI: инструкция агенту доказательством не является (ADR-008).
 */
export const PROTECTED_PATHS: readonly string[] = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'turbo.json',
  'tsconfig.base.json',
  'tsconfig.json',
  'vitest.config.ts',
  'eslint.config.mjs',
  '.dependency-cruiser.cjs',
  '.prettierrc.json',
  '.npmrc',
  '.nvmrc',
  '.tool-versions',
  '.claude/**',
  '.github/**',
  'docs/**',
  'tests/acceptance/**',
  'tests/replay/**',
  'packages/contracts/**',
  'packages/persistence/src/migrations/**',
  'scripts/boundaries/**',
  'AGENTS.md',
  'CLAUDE.md',
  // N-M6 верификации раунда I00-F5: исполняемый код самих контролей DEV-02. Задача,
  // владеющая `tools/agent-harness/src/hooks/**`, получала ALLOW на запись в скрипт,
  // который её же ограничивает — структурно тот же дефект, что исходный B2, только
  // подменяются не данные, а код. Protected path не запрещает правку: он требует
  // объявить её явно, чтобы изменение контроля перестало быть побочным эффектом задачи.
  'tools/agent-harness/**',
  // Реализация security-gate-ов: та же логика, что выше.
  'tools/security-scan/**',
  'scripts/security/**',
  'security/**',
  // Bootstrap изолированных worktree — он материализует write set задачи.
  'scripts/worktree/**',
  // minor 4 раунда 3: отображает `@zona/*` на исходники. Без него dependency-cruiser не
  // видит ни одного ребра между пакетами и все правила границ становятся инертными —
  // это и был blocker M5 первого раунда.
  'tsconfig.depcruise.json',
];

/**
 * Пути, которые не может редактировать никто из агентов, включая lead-а,
 * без явного участия человека.
 */
export const HUMAN_ONLY_PATHS: readonly string[] = ['.env', '.env.*', '**/*.pem', '**/*.key'];
