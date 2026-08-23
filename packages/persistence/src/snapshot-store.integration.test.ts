/**
 * `snapshot-store.ts` — ACCEPTANCE C8 (снимок содержит всё, что нужно для продолжения) и,
 * сквозным сценарием вместе с `prng-positions.ts`, C11 (позиции PRNG переживают перезапуск).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CANONICAL_SERIALIZATION_VERSION,
  CANONICAL_TRANSACTION_ISOLATION_LEVEL,
  RUNTIME_ID_PREFIXES,
  SNAPSHOT_CHECKSUM_SCOPE_VERSION,
  bundleRefFor,
  snapshotChecksum,
  type Command,
  type DeterministicRuntimeProfile,
  type Snapshot,
} from '@zona/contracts';
import { DerivedIdFactory } from '@zona/domain';
import { sql } from 'kysely';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { executeCommand } from './command-handler.ts';
import { initializeWorld, loadWorldState } from './world-repository.ts';
import { PersistentRandomSource } from './prng-positions.ts';
import {
  UnqualifiedRuntimeProfileError,
  loadLatestSnapshot,
  loadSnapshotAt,
  writeSnapshot,
  type SnapshotContent,
} from './snapshot-store.ts';

const ids = new DerivedIdFactory('i02b-snapshot-store');

const RULES_BUNDLE = { travel: { base_minutes: 40 } };
const CONTENT_BUNDLE = { locations: ['loc:quiet-yard', 'loc:bridge'] };
const SCHEMA_BUNDLE = { world_event: 'zona:world-event/1' };

const bundles = (): Snapshot['bundles'] => ({
  rules: bundleRefFor('0.1.0', RULES_BUNDLE),
  content: bundleRefFor('0.1.0', CONTENT_BUNDLE),
  schema: bundleRefFor('1.0.0', SCHEMA_BUNDLE),
});

/**
 * Другой bundle: та же версия, другое содержимое — намеренно, чтобы отличаться от {@link bundles}
 * только checksum-ом (A9: подмена содержимого при неизменной версии обязана быть отличима).
 */
const otherBundles = (): Snapshot['bundles'] => ({
  rules: bundleRefFor('0.1.0', { travel: { base_minutes: 41 } }),
  content: bundleRefFor('0.1.0', CONTENT_BUNDLE),
  schema: bundleRefFor('1.0.0', SCHEMA_BUNDLE),
});

const runtimeProfile = (): DeterministicRuntimeProfile => ({
  canonical_serialization_version: CANONICAL_SERIALIZATION_VERSION,
  snapshot_checksum_scope_version: SNAPSHOT_CHECKSUM_SCOPE_VERSION,
  prng_version: 'xoshiro256++/1',
  numeric_rounding_policy_version: 'numeric-units/1',
  node_version: process.version,
  icu_version: '77.1',
  timezone: 'UTC',
  transaction_isolation_level: CANONICAL_TRANSACTION_ISOLATION_LEVEL,
});

const startJourney: Command = {
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: FIXTURE_AGENT_ID,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: 0,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
};

describe('snapshot-store: запись и чтение снимков (C8, C11)', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  /** Мир "с историей" (C8 given): одна принятая команда, есть событие и запланированное действие. */
  const seedWorldWithHistory = async (): Promise<void> => {
    await truncateWorldData(db);
    await initializeWorld(db, fixtureInitialization());
    const result = await executeCommand(db, startJourney);
    expect(result.outcome).toBe('accepted');
  };

  beforeAll(async () => {
    migrated = await createMigratedDatabase('snapshot_store');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('C8: записанный снимок содержит last_sequence, world_time, PRNG-позиции, состояние, профиль и checksum', async () => {
    await seedWorldWithHistory();
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    expect(state).not.toBeNull();

    const content: SnapshotContent = {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: { [FIXTURE_AGENT_ID]: 3 },
      canonicalState: state,
    };

    const written = await writeSnapshot(db, content);

    expect(written.world_id).toBe(FIXTURE_WORLD_ID);
    expect(written.last_sequence).toBe(state!.sequence);
    expect(written.last_sequence).toBeGreaterThan(0); // мир "с историей", а не пустой
    expect(written.world_time).toBe(state!.worldTime);
    expect(written.prng_stream_positions).toEqual({ [FIXTURE_AGENT_ID]: 3 });
    expect(written.canonical_state).toEqual(state);
    expect(written.deterministic_runtime_profile.transaction_isolation_level).toBe(
      CANONICAL_TRANSACTION_ISOLATION_LEVEL,
    );
    // checksum — не что попало: он обязан совпадать с тем, что дала бы контрактная функция
    // над теми же полями (снимается ДО записи, а не выдумывается персистентностью).
    expect(written.checksum).toBe(snapshotChecksum(written));
  });

  it('C8: checksum снимка не зависит от профиля хоста, включая уровень изоляции (B2 сохраняется)', async () => {
    await seedWorldWithHistory();
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);

    const base: SnapshotContent = {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: state,
    };
    const otherHostProfile: DeterministicRuntimeProfile = {
      ...runtimeProfile(),
      node_version: '24.99.0',
      icu_version: '78.2',
      // Другой уровень изоляции — тоже профиль хоста/кластера (ADR-010 §10.1), тоже вне checksum.
      transaction_isolation_level: 'serializable',
    };

    const written = await writeSnapshot(db, base);
    // Тот же снимок, но с ДРУГИМ снимком на другой sequence был бы конфликтом PK — здесь
    // сравнивается ЧИСТАЯ функция checksum на двух content с разным профилем, не два insert.
    expect(snapshotChecksum({ ...written, deterministic_runtime_profile: otherHostProfile })).toBe(
      written.checksum,
    );
  });

  it('снимок читается обратно тем же содержимым, несмотря на переупорядочивание ключей `jsonb` (ADR-010 §10.2)', async () => {
    await seedWorldWithHistory();
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);

    // Ключи специально разной длины и в порядке, который `jsonb` (сортирует по длине, не по
    // кодовым точкам) переставит иначе, чем канонический порядок: если бы чтение доверяло
    // порядку `jsonb` как есть, round-trip был бы виден в различии между `written` и `loaded`.
    const positions = { 'agent:kite': 9, a: 1, 'world:zzz-long-stream-key': 40 };

    const content: SnapshotContent = {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: positions,
      canonicalState: state,
    };
    const written = await writeSnapshot(db, content);

    const loaded = await loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
      bundles: bundles(),
      runtimeProfile: runtimeProfile(),
    });
    expect(loaded).toEqual(written);
    expect(loaded!.prng_stream_positions).toEqual(positions);
  });

  it('loadSnapshotAt адресует снимок по конкретной sequence, а не только последний', async () => {
    await seedWorldWithHistory();
    const firstState = await loadWorldState(db, FIXTURE_WORLD_ID);
    const first = await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: firstState!.sequence,
      worldTime: firstState!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: firstState,
    });

    // Мир продолжает жить: второй агент тоже выходит на маршрут, sequence растёт.
    const second = await executeCommand(db, {
      ...startJourney,
      command_id: ids.next(RUNTIME_ID_PREFIXES.command),
      correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
      actor_id: 'agent:kite',
      expected_world_version: firstState!.worldVersion,
    });
    expect(second.outcome).toBe('accepted');
    const secondState = await loadWorldState(db, FIXTURE_WORLD_ID);
    expect(secondState!.sequence).toBeGreaterThan(first.last_sequence);

    const latestWritten = await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: secondState!.sequence,
      worldTime: secondState!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: secondState,
    });

    const loadedFirst = await loadSnapshotAt(db, FIXTURE_WORLD_ID, first.last_sequence, {
      bundles: bundles(),
      runtimeProfile: runtimeProfile(),
    });
    expect(loadedFirst).toEqual(first);
    expect(loadedFirst!.last_sequence).not.toBe(latestWritten.last_sequence);

    const loadedLatest = await loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
      bundles: bundles(),
      runtimeProfile: runtimeProfile(),
    });
    expect(loadedLatest).toEqual(latestWritten);
  });

  it('снимков ещё нет: loadLatestSnapshot/loadSnapshotAt возвращают null, а не бросают', async () => {
    await seedWorldWithHistory();
    expect(
      await loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
        bundles: bundles(),
        runtimeProfile: runtimeProfile(),
      }),
    ).toBeNull();
    expect(
      await loadSnapshotAt(db, FIXTURE_WORLD_ID, 1, {
        bundles: bundles(),
        runtimeProfile: runtimeProfile(),
      }),
    ).toBeNull();
  });

  it('повторная запись на ТОЙ ЖЕ sequence — не идемпотентный повтор, а отказ на первичном ключе', async () => {
    await seedWorldWithHistory();
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    const content: SnapshotContent = {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: state,
    };
    await writeSnapshot(db, content);
    await expect(writeSnapshot(db, content)).rejects.toThrow();
  });

  it('M-3: подменённое на диске состояние обнаруживается при чтении, а не тихо принимается', async () => {
    await seedWorldWithHistory();
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: state,
    });

    // Прямая порча строки в обход writeSnapshot — имитация повреждения на диске/чужой записи.
    await sql`
      update world_snapshots set canonical_state = '{"agents":{}}'::jsonb
       where world_id = ${FIXTURE_WORLD_ID} and last_sequence = ${state!.sequence}
    `.execute(db);

    await expect(
      loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
        bundles: bundles(),
        runtimeProfile: runtimeProfile(),
      }),
    ).rejects.toThrow(/checksum/);
  });

  it('bundles, отличные от тех, из которых был снят checksum, — та же громкая ошибка (не молчаливая подмена мира)', async () => {
    await seedWorldWithHistory();
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: state,
    });

    await expect(
      loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
        bundles: otherBundles(),
        runtimeProfile: runtimeProfile(),
      }),
    ).rejects.toThrow(/checksum/);
  });

  /**
   * M3 (аудит I02B): ADR-010 §10.1 утверждает, что уровень изоляции «входит в
   * `deterministic_runtime_profile` снимка и ПРОВЕРЯЕТСЯ `verifyRuntimeProfileCompatibility`».
   * Функция существовала и была покрыта unit-тестами, но не вызывалась ни на одном пути — то
   * есть документ описывал контроль, которого в работающей системе нет. Снимок несёт профиль
   * ВНЕ checksum (осознанно, `SNAPSHOT_CHECKSUM_FIELDS`), поэтому расхождение профиля checksum-ом
   * не ловится по построению: без отдельной проверки оно не ловится ничем.
   */
  it('M3: снимок, снятый под несовместимым профилем выполнения, не восстанавливается молча', async () => {
    await seedWorldWithHistory();
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      // Мир записан под ДРУГОЙ версией PRNG: продолжать его текущим процессом означает
      // получить другую последовательность розыгрышей при том же seed.
      deterministicRuntimeProfile: { ...runtimeProfile(), prng_version: 'xoshiro256++/2' },
      prngStreamPositions: {},
      canonicalState: state,
    });

    await expect(
      loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
        bundles: bundles(),
        runtimeProfile: runtimeProfile(),
      }),
    ).rejects.toThrow(/prng_version/);

    // m-5 второго раунда: отказ обязан быть ОТЛИЧИМ от порчи снимка по типу, а не только по
    // тексту. Для оператора «SIM-01 не проверен» и «SIM-01 нарушен» — разные события.
    await expect(
      loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
        bundles: bundles(),
        runtimeProfile: runtimeProfile(),
      }),
    ).rejects.toBeInstanceOf(UnqualifiedRuntimeProfileError);

    // M-C второго раунда: §7 определяет квалификацию нового runtime как сравнение replay на
    // старом и новом профиле. Без явного согласия такое сравнение неисполнимо — загрузка
    // бросает. Флаг делает процедуру исполнимой и НЕ меняет умолчания (проверено строкой выше).
    const accepted = await loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
      bundles: bundles(),
      runtimeProfile: runtimeProfile(),
      acceptUnqualifiedProfile: true,
    });
    expect(accepted?.deterministic_runtime_profile.prng_version).toBe('xoshiro256++/2');
  });

  /**
   * Вторая половина той же пробы: контроль обязан пропускать корректный случай. §7 квалифицирует
   * major/minor Node, поэтому расхождение patch-версии — НЕ повод отказать в восстановлении мира.
   * Без этой проверки «строгий» контроль, отвергающий вообще всё, выглядел бы работающим.
   */
  it('M3: расхождение patch-версии Node не мешает восстановлению — квалификация по major/minor', async () => {
    await seedWorldWithHistory();
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    const written = runtimeProfile();
    const [major, minor] = written.node_version.replace(/^v/, '').split('.');
    await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: {
        ...written,
        node_version: `v${major!}.${minor!}.999`,
      },
      prngStreamPositions: {},
      canonicalState: state,
    });

    const loaded = await loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
      bundles: bundles(),
      runtimeProfile: written,
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.last_sequence).toBe(state!.sequence);
  });

  it('C11 (сквозной, через настоящую БД): восстановленный источник продолжает PRNG-поток с сохранённой позиции', async () => {
    await seedWorldWithHistory();
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);

    // "До перезапуска": источник сделал несколько розыгрышей по потоку агента.
    const beforeRestart = new PersistentRandomSource({ seed: 42 });
    const madeDraws = Array.from({ length: 4 }, () => beforeRestart.draw(FIXTURE_AGENT_ID));

    const written = await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: beforeRestart.positions(),
      canonicalState: state,
    });

    // "Перезапуск": новый процесс не помнит ничего, кроме того, что прочитал из снимка.
    const loaded = await loadLatestSnapshot(db, FIXTURE_WORLD_ID, {
      bundles: bundles(),
      runtimeProfile: runtimeProfile(),
    });
    expect(loaded!.prng_stream_positions).toEqual(written.prng_stream_positions);
    const afterRestart = new PersistentRandomSource({
      seed: 42,
      startPositions: loaded!.prng_stream_positions,
    });

    // Следующий розыгрыш обязан быть ПЯТЫМ (drawIndex 4) и совпасть с тем, что дал бы источник,
    // который никогда не останавливался — а не начать поток заново с drawIndex 0.
    const continued = afterRestart.draw(FIXTURE_AGENT_ID);
    const uninterrupted = new PersistentRandomSource({ seed: 42 });
    for (const draw of madeDraws) {
      const replay = uninterrupted.draw(FIXTURE_AGENT_ID);
      expect(replay).toEqual(draw);
    }
    expect(continued).toEqual(uninterrupted.draw(FIXTURE_AGENT_ID));
    expect(continued.drawIndex).toBe(4);
  });
});
