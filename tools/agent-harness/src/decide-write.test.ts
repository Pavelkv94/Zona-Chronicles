import { describe, expect, it } from 'vitest';
import { decideWrite, extractTargetPath, toRepoRelative } from './decide-write.ts';
import type { WriteSetLoadResult } from './writeset.ts';

const ROOT = '/repo';

const taskWriteSet: WriteSetLoadResult = {
  kind: 'task',
  writeSet: {
    task_id: 'I00-T02',
    owner_role: 'tooling-implementer',
    write_paths: ['tools/usage-continuity/**'],
  },
};

const decide = (targetPath: string, writeSet: WriteSetLoadResult = taskWriteSet) =>
  decideWrite({ targetPath, projectRoot: ROOT, writeSet });

describe('toRepoRelative', () => {
  it('приводит абсолютный путь к относительному', () => {
    expect(toRepoRelative('/repo/packages/domain/src/a.ts', ROOT)).toBe('packages/domain/src/a.ts');
  });

  it('возвращает null для пути вне репозитория', () => {
    expect(toRepoRelative('/etc/passwd', ROOT)).toBeNull();
    expect(toRepoRelative('../outside.ts', ROOT)).toBeNull();
  });
});

describe('decideWrite — разрешённые операции', () => {
  it('разрешает запись внутри declared write set', () => {
    const result = decide('/repo/tools/usage-continuity/src/runner.ts');
    expect(result.decision).toBe('allow');
  });

  it('разрешает относительный путь внутри write set', () => {
    expect(decide('tools/usage-continuity/src/a.ts').decision).toBe('allow');
  });

  it('разрешает lead-сессии запись в protected path', () => {
    const result = decide('/repo/pnpm-lock.yaml', { kind: 'lead' });
    expect(result.decision).toBe('allow');
  });

  it('разрешает protected path, явно выданный задаче', () => {
    const result = decide('/repo/packages/contracts/src/index.ts', {
      kind: 'task',
      writeSet: {
        task_id: 'I01-T01',
        owner_role: 'contract-steward',
        write_paths: ['packages/contracts/**'],
        allow_protected_paths: ['packages/contracts/**'],
      },
    });
    expect(result.decision).toBe('allow');
  });
});

describe('decideWrite — запрещённые операции', () => {
  it('запрещает protected path задаче без явного владения', () => {
    const result = decide('/repo/pnpm-lock.yaml');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Protected path');
  });

  it('запрещает запись в .claude/settings.json', () => {
    expect(decide('/repo/.claude/settings.json').decision).toBe('deny');
  });

  it('запрещает запись в замороженные acceptance-тесты', () => {
    expect(decide('/repo/tests/acceptance/journey.test.ts').decision).toBe('deny');
  });

  it('запрещает путь вне declared write set', () => {
    const result = decide('/repo/packages/domain/src/rules.ts');
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('вне declared write set');
  });

  it('запрещает запись вне корня репозитория', () => {
    expect(decide('/etc/cron.d/evil').decision).toBe('deny');
  });

  it('запрещает секреты даже lead-сессии', () => {
    expect(decide('/repo/.env', { kind: 'lead' }).decision).toBe('deny');
    expect(decide('/repo/keys/server.pem', { kind: 'lead' }).decision).toBe('deny');
  });

  it('fail-closed при повреждённом writeset.json', () => {
    const result = decide('/repo/tools/usage-continuity/src/a.ts', {
      kind: 'invalid',
      reason: 'сломанный JSON',
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Fail-closed');
  });

  it('не позволяет обойти write set через ../', () => {
    expect(decide('/repo/tools/usage-continuity/../../pnpm-lock.yaml').decision).toBe('deny');
  });
});

describe('extractTargetPath', () => {
  it('читает file_path, notebook_path и path', () => {
    expect(extractTargetPath({ file_path: 'a.ts' })).toBe('a.ts');
    expect(extractTargetPath({ notebook_path: 'b.ipynb' })).toBe('b.ipynb');
    expect(extractTargetPath({ path: 'c.ts' })).toBe('c.ts');
  });

  it('возвращает null, когда пути нет', () => {
    expect(extractTargetPath({ command: 'ls' })).toBeNull();
    expect(extractTargetPath(null)).toBeNull();
    expect(extractTargetPath({ file_path: '' })).toBeNull();
  });
});
