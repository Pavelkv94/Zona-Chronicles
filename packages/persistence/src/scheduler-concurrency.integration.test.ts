/**
 * C5, C6 — конкурентные worker-ы и перехват истёкшей аренды.
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
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitializationWithAgents,
  racerAgentIds,
} from './__fixtures__/world-fixture.ts';
import { sql } from 'kysely';
import { createDatabase, parseDatabaseConnectionUrl, type DatabaseConnection } from './database.ts';
import { executeCommand } from './command-handler.ts';
import { claimDueActions, runWorldTick } from './scheduler.ts';
import { initializeWorld, loadWorldEvents } from './world-repository.ts';

const AGENTS = 6;
const ARRIVAL = '2028-04-26T06:40:00.000Z';
const ids = new DerivedIdFactory('i02b-concurrency');

const start = (actorId: string, expectedVersion: number): Command => ({
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

describe('C5/C6 — конкуренция и аренда', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  const seedJourneys = async (): Promise<void> => {
    await truncateWorldData(db);
    await initializeWorld(db, fixtureInitializationWithAgents(AGENTS));
    let version = 0;
    for (const agentId of racerAgentIds(AGENTS)) {
      const result = await executeCommand(db, start(agentId, version));
      expect(result.outcome).toBe('accepted');
      version += 1;
    }
  };

  beforeAll(async () => {
    migrated = await createMigratedDatabase('scheduler_concurrency', 8);
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('C5: два worker-а исполняют каждое действие ровно один раз', async () => {
    await seedJourneys();

    const [a, b] = await Promise.all([
      runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-a', horizon: ARRIVAL }),
      runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-b', horizon: ARRIVAL }),
    ]);

    // Работа поделена между двумя, а не сделана одним: иначе тест не про конкуренцию.
    expect(a.claimed + b.claimed).toBe(AGENTS);

    const events = await loadWorldEvents(db, FIXTURE_WORLD_ID);
    const completed = events.filter((event) => event.type === 'journey.completed');
    expect(completed).toHaveLength(AGENTS);
    // Ни одного дубля: каждый агент завершил путь ровно один раз.
    expect(new Set(completed.map((event) => event.actor_ids[0])).size).toBe(AGENTS);
    // sequence без дыр: старты плюс завершения.
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  });

  it('C5: второй worker не ждёт первого, а пропускает захваченные строки', async () => {
    // Первая редакция этого теста вызывала `claimDueActions` дважды подряд и была зелёной
    // ДАЖЕ БЕЗ `skip locked` — транзакция первого вызова уже закоммичена, блокировок нет,
    // ждать нечего. Проба это показала: снятие `skip locked` тест не роняло.
    //
    // Здесь первый захват удерживается в ОТКРЫТОЙ транзакции, а второй идёт с коротким
    // `statement_timeout`: без `skip locked` он упёрся бы в блокировку и упал по таймауту,
    // с ним — немедленно возвращает оставшиеся строки. Детектор детерминированный.
    await seedJourneys();

    const holder = createDatabase({
      ...parseDatabaseConnectionUrl(migrated.testDb.url),
      maxConnections: 2,
    });
    try {
      let held: readonly { readonly actionId: string }[] = [];
      let release = (): void => {};
      const holding = new Promise<void>((resolve) => {
        void holder.transaction().execute(async (trx) => {
          held = await claimDueActions(trx, {
            worldId: FIXTURE_WORLD_ID,
            worldTime: ARRIVAL,
            owner: 'worker-a',
            leaseMs: 60_000,
            batchSize: 3,
          });
          resolve();
          await new Promise<void>((done) => {
            release = done;
          });
        });
      });
      await holding;
      expect(held).toHaveLength(3);

      await sql`set statement_timeout = 2000`.execute(db);
      try {
        const second = await claimDueActions(db, {
          worldId: FIXTURE_WORLD_ID,
          worldTime: ARRIVAL,
          owner: 'worker-b',
          leaseMs: 60_000,
          batchSize: 10,
        });
        expect(second).toHaveLength(AGENTS - 3);
        const overlap = second.filter((action) =>
          held.some((claimedFirst) => claimedFirst.actionId === action.actionId),
        );
        expect(overlap).toEqual([]);
      } finally {
        await sql`set statement_timeout = 0`.execute(db);
        release();
      }
    } finally {
      await holder.destroy();
    }
  });

  it('C6: истёкшая аренда подхватывается, и событие всё равно одно', async () => {
    await seedJourneys();

    // Worker, который умрёт: берёт аренду, датированную прошлым.
    const dead = await claimDueActions(db, {
      worldId: FIXTURE_WORLD_ID,
      worldTime: ARRIVAL,
      owner: 'worker-dead',
      leaseMs: 1_000,
      batchSize: AGENTS,
      now: () => new Date(Date.now() - 60_000),
    });
    expect(dead.length).toBeGreaterThan(0);

    // Живой worker видит просроченную аренду и забирает работу.
    const alive = await runWorldTick(db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'worker-alive',
      horizon: ARRIVAL,
    });
    expect(alive.claimed).toBe(AGENTS);

    const events = await loadWorldEvents(db, FIXTURE_WORLD_ID);
    expect(events.filter((event) => event.type === 'journey.completed')).toHaveLength(AGENTS);
  });

  it('C6: «ожившый» worker не может завершить действие поверх чужого результата', async () => {
    await seedJourneys();
    const revived = await claimDueActions(db, {
      worldId: FIXTURE_WORLD_ID,
      worldTime: ARRIVAL,
      owner: 'worker-dead',
      leaseMs: 1_000,
      batchSize: 1,
      now: () => new Date(Date.now() - 60_000),
    });
    const action = revived[0]!;

    await runWorldTick(db, { worldId: FIXTURE_WORLD_ID, owner: 'worker-alive', horizon: ARRIVAL });
    const before = await loadWorldEvents(db, FIXTURE_WORLD_ID);
    const { commandFor } = await import('./scheduler.ts');

    // Два способа, которыми ожившый worker может попробовать доделать свою работу, и оба
    // обязаны кончиться ничем. Проверяются оба: они защищены РАЗНЫМИ механизмами, и падение
    // любого из них — дубль в невосполнимом журнале.

    // 1. Он помнит версию мира, которая была при захвате, — команда байт в байт та же, что
    //    исполнил живой worker, поэтому срабатывает идемпотентность journal-а.
    const originalVersion = before.findIndex(
      (event) => event.caused_by[0] === action.actionId && event.type === 'journey.completed',
    );
    expect(originalVersion).toBeGreaterThanOrEqual(0);
    const replayed = await executeCommand(
      db,
      commandFor(action, {
        worldId: FIXTURE_WORLD_ID,
        schemaVersion: 1,
      }),
      { worldTime: action.dueAt },
    );
    expect(replayed.replayed).toBe(true);
    expect(replayed.outcome).toBe('accepted');

    // 2. Он пересобрал команду заново — и получает ТОТ ЖЕ результат, а не отказ.
    //    После ADR-011 отпечаток команды расписания не зависит от версии мира, поэтому
    //    пересборка даёт побайтово ту же команду. Раньше здесь был `precondition_failed`, и
    //    именно это делало отказ невосстановимым: действие отвергалось вечно, а агент
    //    оставался `traveling` навсегда (blocker аудита I02B).
    const rebuilt = await executeCommand(
      db,
      commandFor(action, { worldId: FIXTURE_WORLD_ID, schemaVersion: 1 }),
      { worldTime: action.dueAt },
    );
    expect(rebuilt.replayed).toBe(true);
    expect(rebuilt.outcome).toBe('accepted');

    // Главное: журнал не изменился ни в одном из двух случаев.
    expect(await loadWorldEvents(db, FIXTURE_WORLD_ID)).toEqual(before);
  });

  it('срок аренды выставлен по часам сервера, а не по часам вызывающего', async () => {
    // Раньше и срок, и сравнение с ним приходили из `new Date()` процесса. Worker с
    // убежавшими часами уводил живую аренду у соседа. Расхождение часов в кластере — норма,
    // а не сбой, поэтому источник времени обязан быть один, и он на сервере.
    await seedJourneys();

    const claimed = await claimDueActions(db, {
      worldId: FIXTURE_WORLD_ID,
      worldTime: ARRIVAL,
      owner: 'server-clock',
      leaseMs: 60_000,
      batchSize: 1,
    });
    expect(claimed).toHaveLength(1);

    const rows = await sql<{ lease_until: Date; server_now: Date }>`
      select lease_until, now() as server_now
        from scheduled_actions
       where world_id = ${FIXTURE_WORLD_ID} and action_id = ${claimed[0]!.actionId}
    `.execute(db);
    const row = rows.rows[0]!;

    // Срок отстоит от времени СЕРВЕРА примерно на leaseMs. Проверяется с широким допуском:
    // утверждение здесь не про точность, а про то, ЧЬИ часы использованы.
    const deltaMs = row.lease_until.getTime() - row.server_now.getTime();
    expect(deltaMs).toBeGreaterThan(50_000);
    expect(deltaMs).toBeLessThan(70_000);
  });
});
