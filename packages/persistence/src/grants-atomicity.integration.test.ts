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

/**
 * Проба берётся по ПОЗДНЕЙ таблице матрицы, а сбой инъектируется в РАННЮЮ (P-1 узкой проверки).
 *
 * Первая редакция детектора роняла `applyGrants` на `outbox` — ПОСЛЕДНЕЙ таблице worker — а
 * проверяла право на `world_events`, ПЕРВОЙ. В autocommit-реализации grant на `world_events`
 * успевает зафиксироваться до падения, поэтому утверждение выполнялось и на сломанном коде:
 * тест был зелёным на обеих реализациях, то есть охранял пустоту.
 *
 * Мутационную пробу я тогда прогнал, но не посмотрел, НА ЧЁМ она упала: падение было
 * каскадным, из предыдущего теста файла. Отсюда порядок здесь строго обратный — ломать рано,
 * спрашивать поздно.
 */
const EARLY_TABLE = 'command_results';
const LATE_TABLE = 'agents';

const workerCanSelect = async (migrated: MigratedDatabase, table: string): Promise<boolean> => {
  const result = await sql<{ ok: boolean }>`
    select has_table_privilege(${ROLE_NAMES.worker}, ${table}, 'select') as ok
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

  it('порядок таблиц в матрице таков, что проба действительно позже инъекции', async () => {
    // Утверждение о САМОМ детекторе: если матрицу переставят, тест обязан упасть здесь, а не
    // тихо перестать различать сломанную реализацию (именно так и произошло в первой редакции).
    const order = Object.keys(GRANT_MATRIX[ROLE_NAMES.worker]);
    expect(order.indexOf(EARLY_TABLE)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(LATE_TABLE)).toBeGreaterThan(order.indexOf(EARLY_TABLE));
    await Promise.resolve();
  });

  it('повторное применение идемпотентно и не меняет прав', async () => {
    expect(await workerCanSelect(migrated, LATE_TABLE)).toBe(true);
    await applyGrants(migrated.db);
    expect(await workerCanSelect(migrated, LATE_TABLE)).toBe(true);
  });

  it('сбой посреди применения не оставляет роль без прав', async () => {
    expect(await workerCanSelect(migrated, LATE_TABLE)).toBe(true);

    // `command_results` есть в матрице, но её больше нет в базе: `grant … on command_results`
    // упадёт ПОСЛЕ снятия прав и ДО выдачи прав на `agents`. На неё никто не ссылается по
    // внешнему ключу, поэтому удаление не тянет за собой ничего лишнего.
    await sql`drop table command_results`.execute(migrated.db);

    try {
      await expect(applyGrants(migrated.db)).rejects.toThrow(/command_results/);

      // Главное утверждение: снятие прав откатилось вместе с упавшей выдачей. На сломанной
      // (autocommit) реализации право на поздней таблице здесь было бы уже потеряно.
      expect(await workerCanSelect(migrated, LATE_TABLE)).toBe(true);
    } finally {
      await sql`
        create table command_results (
          world_id              text        not null references worlds (world_id),
          command_id            text        not null,
          type                  text        not null,
          outcome               text        not null check (outcome in ('accepted', 'rejected')),
          rejection_code        text,
          rejection_message     text,
          event_ids             text[]      not null,
          command_fingerprint   text        not null,
          world_version_before  bigint      not null,
          world_version_after   bigint      not null,
          recorded_at           timestamptz not null,
          primary key (world_id, command_id)
        )
      `.execute(migrated.db);
      await applyGrants(migrated.db);
    }
  });
});
