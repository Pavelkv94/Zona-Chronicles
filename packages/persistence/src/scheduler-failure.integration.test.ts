/**
 * Явный исход отвергнутого запланированного действия (blocker независимого аудита I02B).
 *
 * До исправления доменный отказ не был ни «выполнено», ни «ожидает»: действие возвращалось в
 * очередь каждым следующим тиком и отвергалось снова — вечно. Агент навсегда оставался
 * `traveling`, а в append-only журнале оставалось `journey.started` без завершения. Худшее в
 * этом то, что наружу это выглядело нормальной работой: `world tick` возвращал успех.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ID_PREFIXES, type Command } from '@zona/contracts';
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
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { executeCommand } from './command-handler.ts';
import { claimDueActions, commandFor, runWorldTick } from './scheduler.ts';
import { initializeWorld, loadWorldState } from './world-repository.ts';

const ids = new DerivedIdFactory('i02b-failure');
const ARRIVAL = '2028-04-26T06:40:00.000Z';

const start = (actor: string, version: number): Command => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: actor,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: version,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
});

describe('отвергнутое запланированное действие получает конечный исход', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('scheduler_failure');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('однажды отвергнутое действие не возвращается в очередь вечно', async () => {
    await truncateWorldData(db);
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, start(FIXTURE_AGENT_ID, 0));
    await executeCommand(db, start(FIXTURE_OTHER_AGENT_ID, 1));

    // Детерминированно вызываем отказ: команда действия исполняется с устаревшей версией мира
    // (так собирал её scheduler до ADR-011). Гонок здесь нет — сценарий воспроизводится точно.
    const claimed = await claimDueActions(db, {
      worldId: FIXTURE_WORLD_ID,
      worldTime: ARRIVAL,
      owner: 'stale',
      leaseMs: 1,
      batchSize: 1,
      now: () => new Date(Date.now() - 60_000),
    });
    const action = claimed[0]!;
    const stale = await executeCommand(
      db,
      {
        ...commandFor(action, { worldId: FIXTURE_WORLD_ID, schemaVersion: 1 }),
        expected_world_version: 0,
      },
      { worldTime: action.dueAt },
    );
    expect(stale.outcome).toBe('rejected');

    // Пять догоняющих тиков. Раньше каждый заново захватывал это действие и заново отвергал.
    for (let round = 0; round < 5; round += 1) {
      await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'catchup', horizon: ARRIVAL });
    }

    const actions = await db.selectFrom('scheduled_actions').selectAll().execute();
    const pending = actions.filter((a) => a.completed_at === null && a.failed_at === null);
    const failed = actions.filter((a) => a.failed_at !== null);

    // Главное утверждение: очередь ПУСТА. Ни одно действие не осталось вечно ожидающим.
    expect(pending).toEqual([]);
    // Отказ виден и назван, а не растворился в успешных тиках.
    expect(failed).toHaveLength(1);
    expect(failed[0]?.failure_code).toBeTruthy();
    expect(failed[0]?.lease_owner).toBeNull();

    // Честно: агент остался в пути. Мир не знает, чего хотел оператор, и чинить сам не вправе —
    // но и делать вид, что всё в порядке, больше не может.
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    expect(state?.agents[failed[0]!.entity_id]?.status).toBe('traveling');
  });

  it('отвергнутое действие исключено из захвата, а не просто помечено', async () => {
    const claimed = await claimDueActions(db, {
      worldId: FIXTURE_WORLD_ID,
      worldTime: ARRIVAL,
      owner: 'after-failure',
      leaseMs: 30_000,
      batchSize: 10,
    });
    expect(claimed).toEqual([]);
  });
});
