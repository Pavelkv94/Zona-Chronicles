import { describe, expect, it } from 'vitest';
import { matchesAnyGlob } from './glob.ts';
import { HUMAN_ONLY_PATHS, PROTECTED_PATHS } from './protected-paths.ts';

const isProtected = (path: string): boolean => matchesAnyGlob(path, PROTECTED_PATHS);

describe('PROTECTED_PATHS: исполняемый код самих контролей', () => {
  /**
   * N-M6 верификации раунда I00-F5. Task-сессия, владеющая
   * `tools/agent-harness/src/hooks/**`, получала ALLOW на запись в
   * `subagent-stop-writeset.ts` — то есть в исполняемый код контроля, который её же
   * ограничивает. Структурно тот же дефект, что исходный B2: источник ограничений доступен
   * ограничиваемой стороне, только подменяются не данные, а код.
   *
   * Protected path не запрещает изменение — он требует объявить его явно через
   * `allow_protected_paths`. Правка контроля перестаёт быть побочным эффектом задачи.
   */
  const controlCode = [
    'tools/agent-harness/src/hooks/subagent-stop-writeset.ts',
    'tools/agent-harness/src/hooks/pre-tool-use-write.ts',
    'tools/agent-harness/src/hooks/pre-tool-use-bash.ts',
    'tools/agent-harness/src/decide-write.ts',
    'tools/agent-harness/src/decide-bash.ts',
    'tools/agent-harness/src/session-role.ts',
    'tools/agent-harness/src/writeset.ts',
    'tools/agent-harness/src/git-source.ts',
    'tools/agent-harness/src/protected-paths.ts',
  ];

  it.each(controlCode)('%s защищён', (path) => {
    expect(isProtected(path)).toBe(true);
  });

  /** Контроль без своих тестов недоказуем, поэтому тесты контроля защищены наравне с кодом. */
  it('тесты контролей защищены наравне с кодом', () => {
    expect(isProtected('tools/agent-harness/src/decide-bash.test.ts')).toBe(true);
    expect(isProtected('tools/agent-harness/src/boundary-fixtures.test.ts')).toBe(true);
  });
});

describe('PROTECTED_PATHS: конфигурация, от которой зависят контроли', () => {
  /**
   * minor 4 раунда 3. `tsconfig.depcruise.json` отображает `@zona/*` на исходники — без него
   * dependency-cruiser не видит ни одного ребра между пакетами, и все правила границ
   * становятся инертными. Это и был blocker M5 первого раунда.
   */
  it.each([
    'tsconfig.depcruise.json',
    'security/policy.json',
    'security/exceptions.json',
    'scripts/security/scan-dependencies.ts',
    'scripts/worktree/new-task-worktree.ts',
    'tools/security-scan/src/exceptions.ts',
  ])('%s защищён', (path) => {
    expect(isProtected(path)).toBe(true);
  });
});

describe('PROTECTED_PATHS: границы защиты', () => {
  it('обычный продуктовый код не защищён — иначе список перестаёт что-либо значить', () => {
    for (const path of [
      'packages/domain/src/journey.ts',
      'packages/simulation/src/scheduler.ts',
      'apps/api/src/routes/health.ts',
    ]) {
      expect(isProtected(path), path).toBe(false);
    }
  });

  it('секреты остаются человеческими и не смешиваются с protected', () => {
    expect(matchesAnyGlob('.env', HUMAN_ONLY_PATHS)).toBe(true);
    expect(matchesAnyGlob('deploy/key.pem', HUMAN_ONLY_PATHS)).toBe(true);
  });
});
