/**
 * N-2 — переприменение грантов атомарно: промежуточное состояние снаружи не наблюдается,
 * а падение посреди операции не оставляет роль без прав.
 *
 * `world migrate` запускается против живого кластера, а с I02B появится постоянный worker.
 * Пока `applyGrants` шла в autocommit, `revoke all on all tables` фиксировался немедленно, а
 * `grant`-ы доезжали позже и по одному.
 *
 * ## Почему проверка сделана через СБОЙ, а не через наблюдение окна
 *
 * Первая редакция теста опрашивала `has_table_privilege` из наблюдательного подключения, пока
 * гранты переприменялись, и требовала «ни одной пропажи». Проба показала, что такой детектор
 * различает не то свойство: autocommit-вариант проходит все 40 раундов за 26 мс, наблюдатель
 * успевает сделать 9 замеров, и тест падает на «слишком мало наблюдений», а не на «право
 * пропадало». То есть он отличал БЫСТРУЮ реализацию от медленной, и медленная сломанная
 * реализация прошла бы его. Детектор заменён на детерминированный.
 *
 * Здесь `applyGrants` заставляют упасть ПОСЛЕ снятия прав и ДО их выдачи — тем, что одной из
 * таблиц матрики в базе нет. Транзакционная реализация откатывает снятие целиком; autocommit
 * оставляет роль без прав насовсем, и это видно одним запросом, без гонок и таймингов.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createMigratedDatabase, type MigratedDatabase } from './__fixtures__/migrated-database.ts';
import { GRANT_MATRIX, ROLE_NAMES, applyGrants } from './principals.ts';

const workerCanSelectEvents = async (migrated: MigratedDatabase): Promise<boolean> => {
  const result = await sql<{ ok: boolean }>`
    select has_table_privilege(${ROLE_NAMES.worker}, 'world_events', 'select') as ok
  `.execute(migrated.db);
  return result.rows[0]?.ok === true;
};

describe('N-2 — атомарность переприменения грантов', () => {
  let migrated: MigratedDatabase;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('grants_atomicity');
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('повторное применение идемпотентно и не меняет прав', async () => {
    expect(await workerCanSelectEvents(migrated)).toBe(true);
    await applyGrants(migrated.db);
    expect(await workerCanSelectEvents(migrated)).toBe(true);
  });

  it('сбой посреди применения не оставляет роль без прав', async () => {
    expect(await workerCanSelectEvents(migrated)).toBe(true);

    // `outbox` есть в матрице, но её больше нет в базе: `grant … on outbox` упадёт уже ПОСЛЕ
    // того, как права сняты. Ни одна другая таблица на неё не ссылается, поэтому удаление
    // не тянет за собой ничего лишнего.
    expect(Object.keys(GRANT_MATRIX[ROLE_NAMES.worker])).toContain('outbox');
    await sql`drop table outbox`.execute(migrated.db);

    try {
      await expect(applyGrants(migrated.db)).rejects.toThrow(/outbox/);

      // Главное утверждение: снятие прав откатилось вместе с упавшей выдачей.
      expect(await workerCanSelectEvents(migrated)).toBe(true);
    } finally {
      // Возвращаем таблицу, чтобы файл не оставлял базу в изменённом виде.
      await sql`
        create table outbox (
          outbox_id     bigint generated always as identity primary key,
          world_id      text        not null references worlds (world_id),
          event_id      text        not null references world_events (event_id),
          sequence      bigint      not null,
          payload       jsonb       not null,
          created_at    timestamptz not null,
          published_at  timestamptz,
          unique (event_id)
        )
      `.execute(migrated.db);
      await applyGrants(migrated.db);
    }
  });
});
