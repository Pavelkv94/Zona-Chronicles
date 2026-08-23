/**
 * M-C — мир не принимает команды под неквалифицированным профилем выполнения (I03).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CANONICAL_SERIALIZATION_VERSION,
  CANONICAL_TRANSACTION_ISOLATION_LEVEL,
  SNAPSHOT_CHECKSUM_SCOPE_VERSION,
  type DeterministicRuntimeProfile,
} from '@zona/contracts';
import { sql } from 'kysely';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import { FIXTURE_WORLD_ID, fixtureInitialization } from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { initializeWorld } from './world-repository.ts';
import {
  UnqualifiedCanonicalWriterError,
  qualifyCanonicalWriter,
  setWorldQualifiedProfile,
} from './canonical-writer.ts';

const profile = (): DeterministicRuntimeProfile => ({
  canonical_serialization_version: CANONICAL_SERIALIZATION_VERSION,
  snapshot_checksum_scope_version: SNAPSHOT_CHECKSUM_SCOPE_VERSION,
  prng_version: 'xoshiro256++/1',
  numeric_rounding_policy_version: 'numeric-units/1',
  node_version: 'v24.14.0',
  icu_version: '77.1',
  timezone: 'UTC',
  transaction_isolation_level: CANONICAL_TRANSACTION_ISOLATION_LEVEL,
});

describe('M-C: квалификация канонического писателя', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i03_canonical_writer');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  const freshWorld = async (): Promise<void> => {
    await truncateWorldData(db);
    await initializeWorld(db, fixtureInitialization());
  };

  it('совпадающий профиль пропускается', async () => {
    await freshWorld();
    await setWorldQualifiedProfile(db, FIXTURE_WORLD_ID, profile());
    await expect(qualifyCanonicalWriter(db, FIXTURE_WORLD_ID, profile())).resolves.toBeUndefined();
  });

  it('patch-версия Node не мешает: квалификация по major/minor, как и на чтении снимка', async () => {
    await freshWorld();
    await setWorldQualifiedProfile(db, FIXTURE_WORLD_ID, profile());
    await expect(
      qualifyCanonicalWriter(db, FIXTURE_WORLD_ID, { ...profile(), node_version: 'v24.14.999' }),
    ).resolves.toBeUndefined();
  });

  it('несовместимый профиль — отказ ДО любой записи, с названной причиной', async () => {
    await freshWorld();
    await setWorldQualifiedProfile(db, FIXTURE_WORLD_ID, profile());
    await expect(
      qualifyCanonicalWriter(db, FIXTURE_WORLD_ID, {
        ...profile(),
        prng_version: 'xoshiro256++/2',
      }),
    ).rejects.toBeInstanceOf(UnqualifiedCanonicalWriterError);
    await expect(
      qualifyCanonicalWriter(db, FIXTURE_WORLD_ID, {
        ...profile(),
        prng_version: 'xoshiro256++/2',
      }),
    ).rejects.toThrow(/prng_version/);
  });

  /**
   * «Сравнить не с чем» — это НЕ «всё в порядке». Мир без записанного профиля создан до контроля;
   * молча принять его писателя значило бы, что контроль отсутствует ровно там, где он нужен.
   */
  it('мир без записанного профиля не принимает писателя вовсе', async () => {
    await freshWorld();
    await sql`update worlds set qualified_runtime_profile = null where world_id = ${FIXTURE_WORLD_ID}`.execute(
      db,
    );
    await expect(qualifyCanonicalWriter(db, FIXTURE_WORLD_ID, profile())).rejects.toThrow(
      /не записан квалифицированный профиль/,
    );
  });

  it('несуществующий мир отличим от неквалифицированного', async () => {
    await truncateWorldData(db);
    await expect(qualifyCanonicalWriter(db, 'world:absent', profile())).rejects.toThrow(
      /не существует/,
    );
  });
});
