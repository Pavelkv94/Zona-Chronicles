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
];

/**
 * Пути, которые не может редактировать никто из агентов, включая lead-а,
 * без явного участия человека.
 */
export const HUMAN_ONLY_PATHS: readonly string[] = ['.env', '.env.*', '**/*.pem', '**/*.key'];
