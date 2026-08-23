/**
 * B7 — append-only и разделение ролей исполняются грантами PostgreSQL (OPS-03).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { TestDatabase } from './__fixtures__/test-database.ts';
import {
  TEST_ROLE_PASSWORD,
  createMigratedDatabase,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import { APPLICATION_ROLES, GRANT_MATRIX, ROLE_NAMES } from './principals.ts';

const asRole = async <T>(
  db: TestDatabase,
  role: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> => {
  const url = new URL(db.url);
  url.username = role;
  url.password = TEST_ROLE_PASSWORD;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

const expectDenied = async (client: Client, sql: string): Promise<string> => {
  try {
    await client.query(sql);
  } catch (error) {
    return String((error as { message?: string }).message ?? error);
  }
  throw new Error(`Ожидался отказ по правам, но запрос выполнился: ${sql}`);
};

describe('B7 — гранты ролей', () => {
  let migrated: MigratedDatabase;
  let db: TestDatabase;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('grants');
    db = migrated.testDb;
    const admin = new Client({ connectionString: db.url });
    await admin.connect();
    try {
      await admin.query(
        `insert into worlds (world_id, seed, version, last_sequence, world_time, rules_version,
                             content_version, schema_version, created_at)
         values ('world:grants', 1, 0, 0, '2028-04-26T06:00:00.000Z', '0.1.0', '0.1.0', 1, now())`,
      );
      await admin.query(
        `insert into world_events (event_id, world_id, sequence, world_time, type, schema_version,
                                   rules_version, content_version, actor_ids, subject_ids,
                                   location_id, correlation_id, caused_by, command_id,
                                   random_audit, payload, recorded_at, event_checksum)
         values ('evt_seed', 'world:grants', 1, '2028-04-26T06:00:00.000Z', 'journey.started', 1,
                 '0.1.0', '0.1.0', '{}', '{}', null, 'corr_seed', '{}', null, null, '{}', now(),
                 'sha256:0000000000000000000000000000000000000000000000000000000000000000')`,
      );
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('canonical worker пишет и читает world_events', async () => {
    await asRole(db, ROLE_NAMES.worker, async (client) => {
      const read = await client.query(`select count(*)::int as n from world_events`);
      expect(read.rows[0]).toEqual({ n: 1 });
      await client.query(
        `insert into world_events (event_id, world_id, sequence, world_time, type, schema_version,
                                   rules_version, content_version, actor_ids, subject_ids,
                                   location_id, correlation_id, caused_by, command_id,
                                   random_audit, payload, recorded_at, event_checksum)
         values ('evt_worker', 'world:grants', 2, '2028-04-26T06:10:00.000Z', 'journey.started', 1,
                 '0.1.0', '0.1.0', '{}', '{}', null, 'corr_worker', '{}', null, null, '{}', now(),
                 'sha256:0000000000000000000000000000000000000000000000000000000000000000')`,
      );
    });
  });

  it('canonical worker НЕ может переписать или удалить историю', async () => {
    await asRole(db, ROLE_NAMES.worker, async (client) => {
      const updateError = await expectDenied(
        client,
        `update world_events set type = 'tampered' where event_id = 'evt_seed'`,
      );
      expect(updateError).toMatch(/permission denied/i);
      const deleteError = await expectDenied(
        client,
        `delete from world_events where event_id = 'evt_seed'`,
      );
      expect(deleteError).toMatch(/permission denied/i);
    });
  });

  /**
   * I03, D5. Список таблиц выводится ИЗ СХЕМЫ, а не перечисляется в тесте.
   *
   * Прежняя редакция называла пять имён, а критерий D5 перечисляет шесть, из которых
   * `scheduled_actions` и `world_snapshots` в тест не попали: их добавила I02B, а тест писался
   * до неё. Дефект того же класса, что M-7 чинил для матрицы грантов, только этажом выше —
   * перечисление устаревает молча, и «api не читает канонические таблицы» оказывается
   * доказанным для тех таблиц, о которых тест успел узнать.
   *
   * Теперь канонической считается любая таблица `public`, не начинающаяся с `projection_` и не
   * являющаяся журналом миграций. Новая каноническая таблица попадает под проверку в тот же
   * день, когда появляется, и не требует, чтобы кто-то вспомнил про этот тест.
   */
  it('read-only api не имеет доступа НИ К ОДНОЙ канонической таблице (OPS-02, D5)', async () => {
    const owner = new Client({ connectionString: db.url });
    await owner.connect();
    let canonicalTables: string[];
    try {
      const rows = await owner.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
            and table_type = 'BASE TABLE'
            and table_name not like 'projection\\_%'
            and table_name <> 'schema_migrations'
          order by table_name`,
      );
      canonicalTables = rows.rows.map((row) => row.table_name);
    } finally {
      await owner.end();
    }

    // Пустой список означал бы, что запрос выше сломался, а тест прошёл, ничего не проверив.
    expect(canonicalTables.length).toBeGreaterThanOrEqual(6);
    expect(canonicalTables).toEqual(
      expect.arrayContaining(['scheduled_actions', 'world_snapshots']),
    );

    await asRole(db, ROLE_NAMES.api, async (client) => {
      for (const table of canonicalTables) {
        const message = await expectDenied(client, `select 1 from ${table} limit 1`);
        expect(message, `таблица ${table}`).toMatch(/permission denied/i);
      }
    });
  });

  it('projection builder читает историю, но не пишет её', async () => {
    await asRole(db, ROLE_NAMES.projection, async (client) => {
      const read = await client.query(`select count(*)::int as n from world_events`);
      expect(read.rows[0]).toEqual({ n: 2 });
      const message = await expectDenied(
        client,
        `insert into world_events (event_id, world_id, sequence, world_time, type, schema_version,
                                   rules_version, content_version, actor_ids, subject_ids,
                                   location_id, correlation_id, caused_by, command_id,
                                   random_audit, payload, recorded_at, event_checksum)
         values ('evt_proj', 'world:grants', 3, '2028-04-26T06:20:00.000Z', 'journey.started', 1,
                 '0.1.0', '0.1.0', '{}', '{}', null, 'corr_proj', '{}', null, null, '{}', now(),
                 'sha256:0000000000000000000000000000000000000000000000000000000000000000')`,
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  it('M-7: фактические гранты совпадают с объявленной матрицей ЦЕЛИКОМ, а не по списку таблиц', async () => {
    // Прежняя редакция перечисляла пять имён таблиц. Когда I02B добавит свои и случайно
    // выдаст права `zona_api`, перечисление останется зелёным — новой таблицы в нём нет.
    // Здесь сверяется весь снимок `role_table_grants` для application-ролей: любое право,
    // которого нет в `GRANT_MATRIX`, роняет тест, даже на таблице, о которой тест не знал.
    //
    // Что этот тест НЕ доказывает: сама матрица правильна. Обе стороны сравнения выводятся из
    // неё, поэтому её изменение он пропустит по построению. Он ловит РАСХОЖДЕНИЕ объявленного
    // и фактического; «api не имеет доступа к каноническим таблицам» остаётся отдельным
    // утверждением теста выше, независимым от матрицы (проба lead-а: выдача api права на
    // world_events роняет именно тот тест, а не этот).
    const client = new Client({ connectionString: db.url });
    await client.connect();
    try {
      const rows = await client.query<{
        grantee: string;
        table_name: string;
        privilege_type: string;
      }>(
        `select grantee, table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public' and grantee = any($1::text[])
          order by grantee, table_name, privilege_type`,
        [[...APPLICATION_ROLES]],
      );

      const actual: Record<string, Record<string, string[]>> = {};
      for (const row of rows.rows) {
        (actual[row.grantee] ??= {})[row.table_name] ??= [];
        actual[row.grantee]![row.table_name]!.push(row.privilege_type);
      }

      const expected: Record<string, Record<string, string[]>> = {};
      for (const role of APPLICATION_ROLES) {
        const tables = GRANT_MATRIX[role];
        const nonEmpty = Object.entries(tables).filter(([, privileges]) => privileges.length > 0);
        if (nonEmpty.length === 0) continue;
        expected[role] = Object.fromEntries(
          nonEmpty.map(([table, privileges]) => [table, [...privileges].sort()]),
        );
      }
      for (const role of Object.keys(actual)) {
        for (const table of Object.keys(actual[role]!)) actual[role]![table]!.sort();
      }

      expect(actual).toEqual(expected);
    } finally {
      await client.end();
    }
  });

  it('application-роли не имеют DDL', async () => {
    for (const role of Object.values(ROLE_NAMES)) {
      await asRole(db, role, async (client) => {
        const message = await expectDenied(client, `create table probe_${role} (id int)`);
        expect(message).toMatch(/permission denied/i);
      });
    }
  });
});
