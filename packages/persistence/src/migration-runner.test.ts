import { describe, expect, it } from 'vitest';
import type { Migration } from './migrations/types.ts';
import { computeChecksum, type AppliedMigrationRecord } from './migration-ledger.ts';
import {
  applyMigrations,
  MigrationChecksumMismatchError,
  MigrationNameMismatchError,
  type Logger,
  type MigrationExecutor,
} from './migration-runner.ts';

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Фейковая миграция: `up` никогда реально не вызывается фейковым executor-ом (см. ниже). */
function fakeMigration(id: string, name: string): Migration {
  return {
    id,
    name,
    up: async () => {
      /* no-op: фейковый executor не вызывает up() напрямую */
    },
  };
}

interface FakeExecutorOptions {
  readonly initiallyApplied?: readonly AppliedMigrationRecord[];
  readonly failOnApply?: readonly string[];
}

function createFakeExecutor(options: FakeExecutorOptions = {}) {
  const applied = new Map<string, AppliedMigrationRecord>(
    (options.initiallyApplied ?? []).map((record) => [record.id, record]),
  );
  const failOnApply = new Set(options.failOnApply ?? []);
  const calls: string[] = [];
  const appliedInOrder: string[] = [];

  const executor: MigrationExecutor = {
    async withAdvisoryLock(run) {
      calls.push('lock');
      try {
        return await run();
      } finally {
        calls.push('unlock');
      }
    },
    loadAppliedMigrations() {
      return Promise.resolve([...applied.values()].sort((a, b) => a.id.localeCompare(b.id)));
    },
    applyMigration(migration, checksum) {
      appliedInOrder.push(migration.id);
      if (failOnApply.has(migration.id)) {
        return Promise.reject(new Error(`boom:${migration.id}`));
      }
      applied.set(migration.id, {
        id: migration.id,
        name: migration.name,
        checksum,
        appliedAt: new Date(0),
        durationMs: 1,
      });
      return Promise.resolve({ durationMs: 1 });
    },
  };

  return { executor, calls, appliedInOrder, applied };
}

describe('applyMigrations — порядок и идемпотентность', () => {
  it('применяет неприменённые миграции в порядке id', async () => {
    const migrations = [fakeMigration('0001', 'bootstrap'), fakeMigration('0002', 'second')];
    const { executor, appliedInOrder } = createFakeExecutor();

    const report = await applyMigrations(executor, migrations, silentLogger);

    expect(appliedInOrder).toEqual(['0001', '0002']);
    expect(report.applied.map((entry) => entry.id)).toEqual(['0001', '0002']);
    expect(report.skipped).toEqual([]);
    expect(report.schemaVersion).toBe('0002');
  });

  it('повторный запуск ничего не применяет (идемпотентность)', async () => {
    const migrations = [fakeMigration('0001', 'bootstrap'), fakeMigration('0002', 'second')];
    const initiallyApplied: AppliedMigrationRecord[] = migrations.map((migration) => ({
      id: migration.id,
      name: migration.name,
      checksum: computeChecksum(migration),
      appliedAt: new Date(0),
      durationMs: 1,
    }));
    const { executor, appliedInOrder } = createFakeExecutor({ initiallyApplied });

    const report = await applyMigrations(executor, migrations, silentLogger);

    expect(appliedInOrder).toEqual([]);
    expect(report.applied).toEqual([]);
    expect(report.skipped.map((entry) => entry.id)).toEqual(['0001', '0002']);
    expect(report.schemaVersion).toBe('0002');
  });
});

describe('applyMigrations — целостность журнала', () => {
  it('падает с MIGRATION_CHECKSUM_MISMATCH и не применяет ничего, если checksum разошёлся', async () => {
    const migration = fakeMigration('0001', 'bootstrap');
    const { executor, appliedInOrder } = createFakeExecutor({
      initiallyApplied: [
        {
          id: '0001',
          name: 'bootstrap',
          checksum: 'corrupted-checksum',
          appliedAt: new Date(0),
          durationMs: 1,
        },
      ],
    });

    await expect(applyMigrations(executor, [migration], silentLogger)).rejects.toThrow(
      MigrationChecksumMismatchError,
    );
    expect(appliedInOrder).toEqual([]);
  });

  it('падает с MIGRATION_NAME_MISMATCH, если применённый id встречается в реестре под другим name', async () => {
    const migration = fakeMigration('0001', 'renamed');
    const { executor, appliedInOrder } = createFakeExecutor({
      initiallyApplied: [
        {
          id: '0001',
          name: 'bootstrap',
          checksum: computeChecksum(fakeMigration('0001', 'bootstrap')),
          appliedAt: new Date(0),
          durationMs: 1,
        },
      ],
    });

    await expect(applyMigrations(executor, [migration], silentLogger)).rejects.toThrow(
      MigrationNameMismatchError,
    );
    expect(appliedInOrder).toEqual([]);
  });
});

describe('applyMigrations — advisory lock', () => {
  it('освобождает lock, даже если применение миграции упало', async () => {
    const migrations = [fakeMigration('0001', 'bootstrap'), fakeMigration('0002', 'second')];
    const { executor, calls, appliedInOrder } = createFakeExecutor({ failOnApply: ['0002'] });

    await expect(applyMigrations(executor, migrations, silentLogger)).rejects.toThrow('boom:0002');

    expect(calls).toEqual(['lock', 'unlock']);
    // 0001 успела примениться до падения 0002 — каждая миграция в своей транзакции.
    expect(appliedInOrder).toEqual(['0001', '0002']);
  });
});
