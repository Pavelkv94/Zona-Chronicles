/**
 * B1 (второй раунд верификации I02B) — мир прежней поставки БЕЗ снимка не остаётся с пустыми
 * позициями PRNG после обновления.
 *
 * Миграция 0009 добавила `worlds.prng_stream_positions` с `default '{}'`, обосновав это тем, что
 * «до неё ни одна команда не могла сделать розыгрыш». Про команды это верно, а розыгрыши делает
 * ГЕНЕЗИС: `seedAgents` распределяет агентов по локациям, по розыгрышу на агента. Миграция 0010
 * восстанавливает позиции из снимка — но только у миров, у которых снимок есть. Мир без снимка
 * чинится пересчётом генезиса из `seed`, и делает это `world migrate`.
 *
 * Проверяется НАСТОЯЩИМ процессом CLI (`spawnSync`), а не вызовом функции: чинить обязана
 * команда, которую запускает оператор, а не внутренний помощник, до которого он может не дойти.
 *
 * Состояние «мир прежней поставки» моделируется прямым SQL — обнулением колонки. Это ровно то
 * наблюдаемое состояние, которое 0009 оставляла после себя, и оно достижимо в любой базе,
 * пережившей ту миграцию без 0010.
 *
 * Импорты относительные — `tests/` не workspace-пакет.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  parseDatabaseConnectionUrl,
  type DatabaseConnection,
} from '../../packages/persistence/src/database.ts';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../packages/persistence/src/__fixtures__/test-database.ts';
import { seedWorld } from '../../apps/cli/src/world.ts';
import { spawnWorldCliDirect } from './support/spawn-world-cli.ts';

const SEED = 42;
const WORLD_ID = 'world:prototype';

const cli = (argv: readonly string[], databaseUrl: string) =>
  spawnWorldCliDirect(argv, { env: { DATABASE_URL: databaseUrl } });

/** Читается query builder-ом соединения: `kysely` из `tests/` не резолвится — это не пакет workspace. */
const positionsInWorld = async (db: DatabaseConnection): Promise<unknown> => {
  const row = await db
    .selectFrom('worlds')
    .select('prng_stream_positions')
    .where('world_id', '=', WORLD_ID)
    .executeTakeFirst();
  return row?.prng_stream_positions;
};

describe('I02B B1 — `world migrate` чинит позиции PRNG мира прежней поставки', () => {
  let testDb: TestDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    testDb = await createTestDatabase('acceptance_i02b_b1_prng');
    db = createDatabase(parseDatabaseConnectionUrl(testDb.url));
    expect(cli(['world', 'migrate'], testDb.url).exitCode).toBe(0);
    expect(cli(['world', 'init', '--seed', String(SEED)], testDb.url).exitCode).toBe(0);
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  it('B1: обнулённые позиции восстанавливаются из генезиса и сообщение об этом печатается', async () => {
    const genesis = seedWorld(SEED).snapshot.prng_stream_positions;
    // Убеждаемся, что генезис вообще НЕ пуст — иначе тест доказывал бы пустоту пустотой.
    expect(Object.keys(genesis).length).toBeGreaterThan(0);

    // Состояние после 0009 без 0010: колонка обнулена.
    await db
      .updateTable('worlds')
      .set({ prng_stream_positions: '{}' })
      .where('world_id', '=', WORLD_ID)
      .execute();
    expect(await positionsInWorld(db)).toEqual({});

    const migrate = cli(['world', 'migrate'], testDb.url);
    expect(migrate.exitCode, migrate.stdout + migrate.stderr).toBe(0);
    expect(migrate.stdout).toContain('Позиции PRNG мира world:prototype восстановлены из генезиса');

    expect(await positionsInWorld(db)).toEqual(genesis);
  });

  it('B1: повторный `world migrate` уже ничего не чинит и об этом молчит', async () => {
    const migrate = cli(['world', 'migrate'], testDb.url);
    expect(migrate.exitCode).toBe(0);
    expect(migrate.stdout).not.toContain('восстановлены из генезиса');
    expect(await positionsInWorld(db)).toEqual(seedWorld(SEED).snapshot.prng_stream_positions);
  });
});
