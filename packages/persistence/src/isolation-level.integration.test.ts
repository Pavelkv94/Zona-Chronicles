/**
 * M-1 — семантика отказа не зависит от `default_transaction_isolation` сервера.
 *
 * Аудит I02A: handler не задавал уровень изоляции, и под REPEATABLE READ/SERIALIZABLE
 * конкурентная команда получала брошенный 40001 вместо названного `stale_world_version` —
 * без строки в `command_results` и без ретрая. Уровень задаётся `ALTER DATABASE`/`ALTER ROLE`/
 * `postgresql.conf`, то есть вне репозитория: свойство обязано держаться контролем, а не
 * настройкой хоста.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Client } from 'pg';
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
import { createDatabase, parseDatabaseConnectionUrl, type DatabaseConnection } from './database.ts';
import { executeCommand } from './command-handler.ts';
import { initializeWorld } from './world-repository.ts';

const ids = new DerivedIdFactory('i02a-isolation');

const command = (actorId: string): Command => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: actorId,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: 0,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
});

const SERVER_DEFAULTS = ['read committed', 'repeatable read', 'serializable'] as const;

describe('M-1 — уровень изоляции задан явно', () => {
  let migrated: MigratedDatabase;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('isolation');
  });

  afterAll(async () => {
    // Возвращаем настройку базы, иначе она переживёт тест и повлияет на соседние прогоны.
    const admin = new Client({ connectionString: migrated.testDb.url });
    await admin.connect();
    try {
      await admin.query(
        `alter database "${migrated.testDb.name}" reset default_transaction_isolation`,
      );
    } finally {
      await admin.end();
    }
    await migrated.close();
  });

  it.each(SERVER_DEFAULTS)(
    'при default_transaction_isolation=%s конкуренция даёт названный отказ, а не 40001',
    async (serverDefault) => {
      const admin = new Client({ connectionString: migrated.testDb.url });
      await admin.connect();
      try {
        await admin.query(
          `alter database "${migrated.testDb.name}" set default_transaction_isolation = '${serverDefault}'`,
        );
      } finally {
        await admin.end();
      }

      // Новое подключение: настройка базы читается при старте сессии, старый пул её не увидит.
      let firstResult!: Promise<Awaited<ReturnType<typeof executeCommand>>>;
      const db: DatabaseConnection = createDatabase({
        ...parseDatabaseConnectionUrl(migrated.testDb.url),
        maxConnections: 4,
      });
      try {
        // Проба обязана доказать, что настройка ДЕЙСТВИТЕЛЬНО применилась, иначе тест проверял
        // бы один и тот же уровень три раза и молчал.
        const applied = await sql<{ level: string }>`
          select current_setting('default_transaction_isolation') as level
        `.execute(db);
        expect(applied.rows[0]?.level).toBe(serverDefault);

        await truncateWorldData(db);
        await initializeWorld(db, fixtureInitialization());

        // Пересечение транзакций обязано быть ГАРАНТИРОВАННЫМ, а не вероятным. Простой
        // `Promise.all` двух команд его не даёт: вторая транзакция может начать первый оператор
        // уже после коммита первой, и тогда конфликта нет ни на одном уровне изоляции — тест
        // проходил бы, ничего не проверяя (проба lead-а: снятие setIsolationLevel его не роняло).
        // Здесь первая команда удерживает `FOR UPDATE`, пока вторая гарантированно не войдёт в
        // свою транзакцию и не упрётся в замок.
        let releaseFirst = (): void => {};
        const firstHoldsLock = new Promise<void>((resolve) => {
          const first = executeCommand(db, command(FIXTURE_AGENT_ID), {
            afterStep: async (step) => {
              if (step !== 'world-locked') return;
              resolve();
              await new Promise<void>((done) => {
                releaseFirst = done;
              });
            },
          });
          firstResult = first;
        });
        await firstHoldsLock;

        // Вторая команда стартует внутри окна, пока замок держит первая.
        const second = executeCommand(db, command(FIXTURE_OTHER_AGENT_ID));
        await new Promise<void>((done) => setTimeout(done, 200));
        releaseFirst();

        const [a, b] = await Promise.all([firstResult, second]);

        expect([a.outcome, b.outcome].sort()).toEqual(['accepted', 'rejected']);
        const rejected = a.outcome === 'rejected' ? a : b;
        expect(rejected.outcome === 'rejected' ? rejected.rejectionCode : null).toBe(
          'stale_world_version',
        );

        // Отказ обязан быть ЗАПИСАН: брошенный 40001 не оставил бы строки в journal.
        const results = await db.selectFrom('command_results').selectAll().execute();
        expect(results).toHaveLength(2);
      } finally {
        await db.destroy();
      }
    },
  );
});
