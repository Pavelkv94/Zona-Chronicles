/**
 * `replay.ts` — ACCEPTANCE C9 (снимок плюс суффикс журнала равен непрерывному прогону) и C10
 * (replay структурно не может обратиться к случайности — доказано `boundaries:check`, здесь
 * только round-trip поля `random_audit`, см. change request в ACCEPTANCE.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  RUNTIME_ID_PREFIXES,
  bundleRefFor,
  canonicalChecksum,
  isCanonicalizationError,
  requireChecksum,
  type Command,
  type DeterministicRuntimeProfile,
  type Snapshot,
} from '@zona/contracts';
import {
  CANONICAL_SERIALIZATION_VERSION,
  CANONICAL_TRANSACTION_ISOLATION_LEVEL,
  SNAPSHOT_CHECKSUM_SCOPE_VERSION,
} from '@zona/contracts';
import { DerivedIdFactory } from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_OTHER_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
  fixtureState,
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { executeCommand } from './command-handler.ts';
import { runWorldTick } from './scheduler.ts';
import { initializeWorld, loadWorldEvents, loadWorldState } from './world-repository.ts';
import { writeSnapshot } from './snapshot-store.ts';
import { replayFromSnapshot, replayWorld } from './replay.ts';

const ids = new DerivedIdFactory('i02b-replay');
const ARRIVAL = '2028-04-26T06:40:00.000Z'; // FIXTURE_WORLD_TIME + 40 минут (FIXTURE_ROUTE_ID)

const bundles = (): Snapshot['bundles'] => ({
  rules: bundleRefFor('0.1.0', { travel: { base_minutes: 40 } }),
  content: bundleRefFor('0.1.0', { locations: ['loc:quiet-yard', 'loc:bridge'] }),
  schema: bundleRefFor('1.0.0', { world_event: 'zona:world-event/1' }),
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

const startJourney = (actorId: string, expectedVersion: number): Command => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: actorId,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: expectedVersion,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
});

const checksumOf = (value: unknown): string => {
  const result = canonicalChecksum(value);
  if (isCanonicalizationError(result)) throw new Error(`test: неканонично: ${result.error}`);
  return result.checksum;
};

describe('replay: снимок плюс суффикс журнала (C9, C10)', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('replay');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  const seed = async (): Promise<void> => {
    await truncateWorldData(db);
    await initializeWorld(db, fixtureInitialization());
  };

  it('C9: снимок на sequence K плюс суффикс журнала даёт то же состояние и checksum, что непрерывный прогон до N', async () => {
    await seed();

    // sequence 1: rook выходит на маршрут — здесь снимаем снимок (K = 1, не 0 — ACCEPTANCE
    // требует именно "K < N", а не только вырожденный случай пустой истории).
    const first = await executeCommand(db, startJourney(FIXTURE_AGENT_ID, 0));
    expect(first.outcome).toBe('accepted');
    const stateAtK = await loadWorldState(db, FIXTURE_WORLD_ID);
    const snapshotAtK = await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: stateAtK!.sequence,
      worldTime: stateAtK!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: stateAtK,
    });
    expect(snapshotAtK.last_sequence).toBe(1);

    // sequence 2: kite тоже выходит на маршрут.
    const second = await executeCommand(db, startJourney(FIXTURE_OTHER_AGENT_ID, 1));
    expect(second.outcome).toBe('accepted');

    // sequence 3, 4: worker доводит оба пути до конца — оба агента вышли в один момент
    // мирового времени и по одному маршруту, поэтому due одновременно; в суффиксе появляется
    // другой тип события (journey.completed), не только journey.started, иначе тест проверял
    // бы только одну ветку `evolve`.
    const tick = await runWorldTick(db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'w',
      horizon: ARRIVAL,
    });
    expect(tick.claimed).toBe(2);

    const continuous = await loadWorldState(db, FIXTURE_WORLD_ID);
    expect(continuous!.sequence).toBe(4); // N = 4 > K = 1 — сравнение не тавтологично

    const replayed = await replayFromSnapshot(db, FIXTURE_WORLD_ID, snapshotAtK);
    expect(replayed.appliedEventCount).toBe(3); // суффикс K+1..N = {2, 3, 4}
    expect(replayed.state).toEqual(continuous);
    expect(replayed.checksum).toBe(checksumOf(continuous));

    // Удобный вход тоже: единственный снимок мира — как раз snapshotAtK, `replayWorld`
    // обязан найти его сам и дать тот же результат.
    const viaLatest = await replayWorld(db, FIXTURE_WORLD_ID, { bundles: bundles() });
    expect(viaLatest).toEqual(replayed);
  });

  it('снимок ровно на N: суффикс пуст, replay ничего не доигрывает', async () => {
    await seed();
    await executeCommand(db, startJourney(FIXTURE_AGENT_ID, 0));
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    const snapshot = await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: state,
    });

    const replayed = await replayFromSnapshot(db, FIXTURE_WORLD_ID, snapshot);
    expect(replayed.appliedEventCount).toBe(0);
    expect(replayed.state).toEqual(state);
  });

  it('replayWorld без единого снимка отказывает по названной причине, а не берёт состояние из ниоткуда', async () => {
    await seed();
    await executeCommand(db, startJourney(FIXTURE_AGENT_ID, 0));
    await expect(replayWorld(db, FIXTURE_WORLD_ID, { bundles: bundles() })).rejects.toThrow(
      /нет ни одного снимка/,
    );
  });

  it('разрыв в журнале после снимка обнаруживается отказом, а не тихо доигранным "почти тем же" миром', async () => {
    await seed();

    // Снимок сразу на sequence 0 — тем же начальным состоянием, что даёт `initializeWorld`
    // (никаким событием оно не восстановимо, поэтому фикстура даёт его напрямую).
    const snapshotAtZero = await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: 0,
      worldTime: FIXTURE_WORLD_TIME,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: fixtureState(),
    });

    await executeCommand(db, startJourney(FIXTURE_AGENT_ID, 0)); // sequence 1
    await executeCommand(db, startJourney(FIXTURE_OTHER_AGENT_ID, 1)); // sequence 2
    // sequence 3, 4: оба агента due одновременно (см. довод в тесте выше).
    await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'w', horizon: ARRIVAL });

    const beforeDeletion = await loadWorldEvents(db, FIXTURE_WORLD_ID);
    expect(beforeDeletion.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);

    // Порча журнала В ОБХОД приложения: и `world_events`, и рантайм-роль (миграция 0003) не
    // дают delete НИКОМУ на уровне грантов (`principals.ts`) — здесь подключаемся владельцем
    // тестовой БД напрямую, как `isolation-level.integration.test.ts`, чтобы СМОДЕЛИРОВАТЬ
    // внешнюю порчу/усечение журнала, а не обойти собственную защиту приложения.
    const admin = new Client({ connectionString: migrated.testDb.url });
    await admin.connect();
    try {
      // `outbox` ссылается на `world_events` по `event_id` — сначала снимаем зависимую строку
      // доставки, иначе внешний ключ (законно) не даёт стереть событие.
      await admin.query('delete from outbox where world_id = $1 and sequence = 2', [
        FIXTURE_WORLD_ID,
      ]);
      const deleted = await admin.query(
        'delete from world_events where world_id = $1 and sequence = 2',
        [FIXTURE_WORLD_ID],
      );
      expect(deleted.rowCount).toBe(1);
    } finally {
      await admin.end();
    }

    const afterDeletion = await loadWorldEvents(db, FIXTURE_WORLD_ID);
    expect(afterDeletion.map((event) => event.sequence)).toEqual([1, 3, 4]);

    await expect(replayFromSnapshot(db, FIXTURE_WORLD_ID, snapshotAtZero)).rejects.toThrow(
      /разрыв в журнале/,
    );
  });

  it('C10 (round-trip поля, НЕ доказательство: см. change request в ACCEPTANCE.md): событие с random_audit реплеится по записанному outcome, без изменения результата', async () => {
    await seed();
    const snapshotAtZero = await writeSnapshot(db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: 0,
      worldTime: FIXTURE_WORLD_TIME,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: fixtureState(),
    });

    await executeCommand(db, startJourney(FIXTURE_AGENT_ID, 0)); // sequence 1
    const [recorded] = await loadWorldEvents(db, FIXTURE_WORLD_ID);
    expect(recorded).toBeDefined();

    // Текущие journey.start/journey.complete розыгрышей не делают (`decide.ts`: `random_audit:
    // null` буквально) — реального события с random_audit в этом slice ещё нет. Синтетическая
    // подмена — единственный способ проверить, что replay ПРИМЕНЯЕТ record, а не спотыкается о
    // его наличие; она не доказывает C10 (это делает `boundaries:check`, см. докстринг
    // `replay.ts`), а проверяет, что поле не мешает round-trip.
    const withAudit = {
      ...recorded!,
      random_audit: { stream_key: FIXTURE_AGENT_ID, first_draw_index: 0, draw_count: 1 },
    };
    const admin = new Client({ connectionString: migrated.testDb.url });
    await admin.connect();
    try {
      await admin.query(
        'update world_events set random_audit = $1, event_checksum = $2 where world_id = $3 and sequence = $4',
        [
          JSON.stringify(withAudit.random_audit),
          requireChecksum(withAudit, `test event(${withAudit.event_id})`),
          FIXTURE_WORLD_ID,
          1,
        ],
      );
    } finally {
      await admin.end();
    }

    const replayed = await replayFromSnapshot(db, FIXTURE_WORLD_ID, snapshotAtZero);
    const continuous = await loadWorldState(db, FIXTURE_WORLD_ID);
    // evolve не читает random_audit (см. evolve.ts) — присутствие поля не меняет состояние.
    expect(replayed.state).toEqual(continuous);
    expect(replayed.appliedEventCount).toBe(1);
  });
});

describe('M5 — рассогласование снимка и журнала не выдаётся за пустой суффикс', () => {
  let migrated: MigratedDatabase;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('replay_mismatch');
  });

  afterAll(async () => {
    await migrated.close();
  });

  /** Снимок текущего состояния мира, записанный тем же путём, что и в проде. */
  const snapshotNow = async (): Promise<Snapshot> => {
    const state = await loadWorldState(migrated.db, FIXTURE_WORLD_ID);
    return writeSnapshot(migrated.db, {
      worldId: FIXTURE_WORLD_ID,
      lastSequence: state!.sequence,
      worldTime: state!.worldTime,
      bundles: bundles(),
      deterministicRuntimeProfile: runtimeProfile(),
      prngStreamPositions: {},
      canonicalState: state!,
    });
  };

  it('снимок НОВЕЕ журнала — отказ, а не «нечего доигрывать»', async () => {
    // Реальный случай: журнал восстановлен из более старого бэкапа, чем снимок (PITR). Без
    // проверки replay вернул бы состояние снимка как истину, и сверка checksum сошлась бы сама
    // с собой — детектор детерминизма подтвердил бы несуществующий мир.
    await truncateWorldData(migrated.db);
    await initializeWorld(migrated.db, fixtureInitialization());

    const ahead: Snapshot = { ...(await snapshotNow()), last_sequence: 99 };
    await expect(replayFromSnapshot(migrated.db, FIXTURE_WORLD_ID, ahead)).rejects.toThrow(
      /новее журнала/,
    );
  });

  it('снимок ЧУЖОГО мира — отказ по идентификатору', async () => {
    // Своя точка: PK `(world_id, last_sequence)` не даёт записать второй снимок на ту же
    // sequence, и это правильное поведение (проверяется отдельно) — здесь нужен просто мир
    // с историей.
    await truncateWorldData(migrated.db);
    await initializeWorld(migrated.db, fixtureInitialization());
    const foreign: Snapshot = { ...(await snapshotNow()), world_id: 'world:somebody-else' };
    await expect(replayFromSnapshot(migrated.db, FIXTURE_WORLD_ID, foreign)).rejects.toThrow(
      /принадлежит миру world:somebody-else/,
    );
  });
});
