/**
 * M6 независимого архитектурного аудита I03 — смена контента не является нарушением SIM-01.
 *
 * ## Что обвиняли не по адресу
 *
 * `bundles` входят в `Snapshot.checksum`, но в строке `world_snapshots` не хранились. Читающая
 * сторона передаёт ТЕКУЩИЕ bundles; после смены версии контента (в этой же итерации 0.1.0 →
 * 0.2.0) checksum ожидаемо не сходится, и мир получал отказ «снимок невосполним — расхождение
 * обязано быть сбоем, а не тихо другим миром», а `world replay` печатал «нарушение SIM-01».
 *
 * Мир при этом цел. Обвинение ложно в обе стороны: оператор идёт искать поломку детерминизма,
 * которой нет, — и одновременно НАСТОЯЩЕЕ нарушение SIM-01 становится неотличимо от рутинной
 * правки контента. Детектор, дающий одинаковый ответ на «мир сломан» и «контент обновлён»,
 * перестаёт быть детектором.
 *
 * ## Что проверяется
 *
 * Различение, а не просто наличие отказа. Три случая: те же bundles — читается; другие bundles —
 * ИМЕННО `SnapshotBundleMismatchError`; испорченное состояние при тех же bundles — прежний отказ
 * по checksum. Третий случай существен: без него правка могла бы «починить» диагностику, заодно
 * перестав ловить настоящую порчу.
 *
 * Импорты относительные — `tests/` не workspace-пакет.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../packages/contracts/src/index.ts';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../packages/persistence/src/__fixtures__/migrated-database.ts';
import {
  FIXTURE_WORLD_ID,
  fixtureInitialization,
} from '../../packages/persistence/src/__fixtures__/world-fixture.ts';
import {
  SnapshotBundleMismatchError,
  initializeWorld,
  loadLatestSnapshot,
  writeSnapshot,
} from '../../packages/persistence/src/index.ts';
import type { DatabaseConnection } from '../../packages/persistence/src/database.ts';
import { currentBundles, currentDeterministicRuntimeProfile } from '../../apps/cli/src/world.ts';

const OTHER_BUNDLES = (): Snapshot['bundles'] => {
  const current = currentBundles();
  return {
    ...current,
    content: { ...current.content, version: '0.99.0', checksum: `sha256:${'a'.repeat(64)}` },
  };
};

describe('M6 — другой bundle и порченый мир различимы', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i03_m6_bundles');
    db = migrated.db;
    const init = fixtureInitialization();
    await initializeWorld(db, init);
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

  it('те же bundles — снимок читается', async () => {
    const snapshot = await loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
      bundles: currentBundles(),
      runtimeProfile: currentDeterministicRuntimeProfile(),
    });
    expect(snapshot).not.toBeNull();
  });

  it('другие bundles — НАЗВАННЫЙ отказ про контент, а не про порчу мира', async () => {
    await expect(
      loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
        bundles: OTHER_BUNDLES(),
        runtimeProfile: currentDeterministicRuntimeProfile(),
      }),
    ).rejects.toBeInstanceOf(SnapshotBundleMismatchError);

    // И текст обязан прямо снимать обвинение: оператор читает именно его.
    await expect(
      loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
        bundles: OTHER_BUNDLES(),
        runtimeProfile: currentDeterministicRuntimeProfile(),
      }),
    ).rejects.toThrow(/НЕ порча мира и НЕ нарушение SIM-01/);
  });

  it('порченое состояние при ТЕХ ЖЕ bundles — прежний отказ по checksum, а не про контент', async () => {
    // Порча вносится через builder: `kysely` из корня не резолвится, и добавлять адаптер в
    // корневые зависимости нельзя — это уже один раз молча ослабило контроль границ.
    await db
      .updateTable('world_snapshots')
      .set({ world_time: '2099-01-01T00:00:00.000Z' })
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .execute();

    const failure = await loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
      bundles: currentBundles(),
      runtimeProfile: currentDeterministicRuntimeProfile(),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SnapshotBundleMismatchError);
    expect(String(failure)).toMatch(/checksum/i);
  });
});
