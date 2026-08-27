/**
 * m10 независимого архитектурного аудита I03 — прочитанный из хранилища JSON проверяется,
 * а не приводится типом.
 *
 * ## Почему `as` здесь не безобиден
 *
 * `as DeterministicRuntimeProfile` и `as { worldTime, agents }` — обещания компилятору, а не
 * факты: значения приходят из `jsonb`, то есть из-за границы процесса, и компилятор о них не
 * знает ничего. Оба места, где это стояло, — контрольные:
 *
 *   - `canonical-writer` сравнивает профиль процесса с записанным у мира. Профиль с недостающим
 *     полем прошёл бы приведение молча, и «квалификация пройдена» означало бы «сравнили с
 *     мусором» — то есть шлюз пропускал бы именно там, где обязан задерживать;
 *   - `projection-builder` берёт из снимка начальную расстановку. Снимок другой формы дал бы
 *     карту с `undefined` вместо локации — зритель увидел бы мир, которого не было.
 *
 * ## Как ломается
 *
 * Порча вносится через builder, а не `sql` из kysely: он не резолвится из корня, а добавлять
 * адаптер в корневые зависимости нельзя — это уже один раз молча ослабило контроль границ.
 * Ломается ОДНО поле, документ остаётся правдоподобным: так и портятся настоящие записи.
 *
 * Импорты относительные — `tests/` не workspace-пакет.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../packages/persistence/src/__fixtures__/migrated-database.ts';
import {
  FIXTURE_WORLD_ID,
  fixtureInitialization,
} from '../../packages/persistence/src/__fixtures__/world-fixture.ts';
import {
  UnqualifiedCanonicalWriterError,
  initializeWorld,
  qualifyCanonicalWriter,
  setWorldQualifiedProfile,
  writeSnapshot,
} from '../../packages/persistence/src/index.ts';
import { snapshotChecksum } from '../../packages/contracts/src/index.ts';
import type { DatabaseConnection } from '../../packages/persistence/src/database.ts';
import { genesisFromSnapshot } from '../../apps/worker/src/projection-builder.ts';
import { currentBundles, currentDeterministicRuntimeProfile } from '../../apps/cli/src/world.ts';

describe('m10 — persisted JSON проверяется на входе', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i03_m10_persisted_json');
    db = migrated.db;
    const init = fixtureInitialization();
    await initializeWorld(db, init);
    await setWorldQualifiedProfile(db, FIXTURE_WORLD_ID, currentDeterministicRuntimeProfile());
    await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: init.state.sequence,
      worldTime: init.state.worldTime,
      bundles: currentBundles(),
      deterministicRuntimeProfile: currentDeterministicRuntimeProfile(),
      prngStreamPositions: init.prngStreamPositions,
      canonicalState: init.state,
    });
  }, 120_000);

  afterAll(async () => {
    await migrated.close();
  });

  it('исправные записи проходят обе проверки', async () => {
    await expect(
      qualifyCanonicalWriter(db, FIXTURE_WORLD_ID, currentDeterministicRuntimeProfile()),
    ).resolves.toBeUndefined();
    await expect(
      genesisFromSnapshot(
        db,
        FIXTURE_WORLD_ID,
        currentBundles(),
        currentDeterministicRuntimeProfile(),
      ),
    ).resolves.not.toBeNull();
  });

  it('профиль мира без обязательного поля — отказ шлюза, а не «сравнили с мусором»', async () => {
    const profile = { ...currentDeterministicRuntimeProfile() } as Record<string, unknown>;
    delete profile['icu_version'];

    await db
      .updateTable('worlds')
      .set({ qualified_runtime_profile: JSON.stringify(profile) as unknown as never })
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .execute();

    const failure = await qualifyCanonicalWriter(
      db,
      FIXTURE_WORLD_ID,
      currentDeterministicRuntimeProfile(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnqualifiedCanonicalWriterError);
    expect(String(failure)).toMatch(/не соответствующий схеме/);

    // Возвращаем как было: следующий тест портит уже снимок, а не мир.
    await setWorldQualifiedProfile(db, FIXTURE_WORLD_ID, currentDeterministicRuntimeProfile());
  });

  it('генезисный снимок неожиданной формы — названный отказ, а не карта с дырами', async () => {
    const rows = await db
      .selectFrom('world_snapshots')
      .select(['canonical_state'])
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .where('last_sequence', '=', '0')
      .execute();
    expect(rows).toHaveLength(1);

    const broken = { ...(rows[0]!.canonical_state as Record<string, unknown>) };
    const agents = { ...(broken['agents'] as Record<string, Record<string, unknown>>) };
    const [firstAgentId] = Object.keys(agents);
    agents[firstAgentId!] = { ...agents[firstAgentId!], status: 'wandering' };
    broken['agents'] = agents;

    /**
     * Checksum ПЕРЕСЧИТЫВАЕТСЯ, и это существенно для того, что здесь проверяется.
     *
     * Первая редакция теста просто портила `canonical_state`, и он падал раньше — на сверке
     * checksum. Падение правильное, но доказывало другое: что снимок защищён от порчи. Проверка
     * ФОРМЫ живёт после неё и ловит другой класс — снимок, внутренне непротиворечивый и при этом
     * описывающий состояние неизвестного вида. Именно так выглядела бы запись, сделанная будущей
     * версией писателя или восстановленная из чужого мира.
     */
    const init = fixtureInitialization();
    const rewritten = {
      world_id: FIXTURE_WORLD_ID,
      last_sequence: init.state.sequence,
      world_time: init.state.worldTime,
      bundles: currentBundles(),
      prng_stream_positions: init.prngStreamPositions,
      canonical_state: broken,
      deterministic_runtime_profile: currentDeterministicRuntimeProfile(),
    };

    await db
      .updateTable('world_snapshots')
      .set({
        canonical_state: JSON.stringify(broken) as unknown as never,
        checksum: snapshotChecksum(rewritten as never),
      })
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .where('last_sequence', '=', '0')
      .execute();

    await expect(
      genesisFromSnapshot(
        db,
        FIXTURE_WORLD_ID,
        currentBundles(),
        currentDeterministicRuntimeProfile(),
      ),
    ).rejects.toThrow(/неожиданную форму/);
  });
});
