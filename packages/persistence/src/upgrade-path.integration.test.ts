/**
 * N-1 — путь ОБНОВЛЕНИЯ: база предыдущей поставки доводится до текущей схемы, данные целы.
 *
 * До этого теста покрытия обновления в проекте не было вообще. B1 проверяет «на пустой и на
 * существующей схеме», но «существующая» там означает «та же поставка, прогнанная дважды».
 * Класс дефектов «применённая миграция отредактирована» проходил незамеченным — им и оказался
 * blocker N-1 повторного аудита.
 *
 * «Предыдущая поставка» здесь моделируется честно: применяются ТОЛЬКО первые N-1 миграций
 * реестра, в базу пишется настоящий мир, и только потом накатывается полный реестр.
 *
 * Мир до обновления пишется ЯВНЫМ SQL прежней поставки, а не текущим `initializeWorld` (M4).
 * Раньше здесь стоял он, и это работало ровно пока писатель не менялся: миграция 0009 добавила
 * `worlds.prng_stream_positions`, текущий писатель стал его заполнять, и тест упал на схеме N-1 —
 * то есть модель «предыдущей поставки» использовала писателя ПОСЛЕДУЮЩЕЙ. Смысл фазы `expand`
 * ровно обратный: старый писатель обязан работать против новой схемы, а не новый против старой.
 * Обещание теста («данные предыдущей поставки переживают обновление») не изменилось и не
 * ослаблено — изменилось только то, чем эти данные создаются.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { sql } from 'kysely';
import { createDatabase, parseDatabaseConnectionUrl, type DatabaseConnection } from './database.ts';
import { createTestDatabase, type TestDatabase } from './__fixtures__/test-database.ts';
import { fixtureInitialization, FIXTURE_WORLD_ID } from './__fixtures__/world-fixture.ts';
import { migrations } from './migrations/index.ts';
import { runMigrations, type Logger } from './migration-runner.ts';
import { applyGrants, ensureApplicationRoles } from './principals.ts';
import { TEST_ROLE_PASSWORD } from './__fixtures__/migrated-database.ts';
import { loadWorldState } from './world-repository.ts';

const SILENT: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Колонки `worlds` в поставке N-1: ровно те, что были до миграции 0009. */
const PREVIOUS_RELEASE_WORLD_COLUMNS =
  'world_id, seed, version, last_sequence, world_time, rules_version, content_version, ' +
  'schema_version, created_at';

/**
 * Пишет мир так, как это делала бы ПРЕДЫДУЩАЯ поставка: перечислением её колонок, без единого
 * поля, добавленного последней миграцией. Использовать здесь `initializeWorld` нельзя — это
 * писатель текущей поставки (см. докстринг файла).
 */
const writePreviousReleaseWorld = async (
  db: DatabaseConnection,
  /**
   * КАКУЮ поставку писать. Два теста этого файла эмулируют РАЗНЫЕ рубежи — «весь реестр без
   * последней миграции» и «состояние до 0010», — и одним списком колонок они не описываются:
   * миграция 0014 сделала моменты отсчёта нужд обязательными, а до неё таких колонок не было.
   *
   * Параметр явный, а не вывод из схемы: писатель, заглядывающий в `information_schema`, — это
   * писатель ТЕКУЩЕЙ поставки, а тест обязан вести себя как старый.
   */
  release: { readonly needBaselines: boolean; readonly goal?: boolean; readonly risk?: boolean },
): Promise<void> => {
  const init = fixtureInitialization();
  const state = init.state;
  await sql`
    insert into worlds (${sql.raw(PREVIOUS_RELEASE_WORLD_COLUMNS)})
    values (
      ${state.worldId}, ${init.seed}, ${state.worldVersion}, ${state.sequence},
      ${state.worldTime}, ${init.versions.rulesVersion}, ${init.versions.contentVersion},
      ${init.versions.schemaVersion}, now()
    )
  `.execute(db);

  for (const location of init.content.locations) {
    if (release.risk === true) {
      await sql`
        insert into locations (world_id, location_id, name, description, risk)
        values (${state.worldId}, ${location.id}, ${location.name}, ${location.description},
                ${state.locations[location.id]?.risk ?? 0})
      `.execute(db);
      continue;
    }
    await sql`
      insert into locations (world_id, location_id, name, description)
      values (${state.worldId}, ${location.id}, ${location.name}, ${location.description})
    `.execute(db);
  }
  for (const route of Object.values(state.routes)) {
    if (release.risk === true) {
      await sql`
        insert into routes (world_id, route_id, from_location_id, to_location_id, travel_minutes,
                            risk)
        values (${state.worldId}, ${route.id}, ${route.fromLocationId}, ${route.toLocationId},
                ${route.travelMinutes}, ${route.risk})
      `.execute(db);
      continue;
    }
    await sql`
      insert into routes (world_id, route_id, from_location_id, to_location_id, travel_minutes)
      values (${state.worldId}, ${route.id}, ${route.fromLocationId}, ${route.toLocationId},
              ${route.travelMinutes})
    `.execute(db);
  }
  for (const agent of Object.values(state.agents)) {
    // Моменты отсчёта нужд перечислены здесь потому, что миграция 0014 сделала их NOT NULL без
    // умолчания (I04). Пока все добавленные колонки были nullable, этот список мог отставать
    // молча; первая же обязательная колонка это отставание назвала — тест упал на вставке, а не
    // на сравнении, и это его работа. Список обязан описывать схему поставки N-1, иначе тест
    // моделирует поставку, которой не существовало.
    if (release.goal === true) {
      // Поставка N-1 после 0019 и 0021: цель и осторожность обязательны и умолчаний у них нет —
      // новый агент получает их явно, иначе забытая вставка дала бы значения «по умолчанию».
      await sql`
        insert into agents (world_id, agent_id, name, location_id, status, route_id,
                            hunger_baseline, fatigue_baseline, goal, caution)
        values (${state.worldId}, ${agent.id}, ${init.content.agentNames[agent.id] ?? agent.id},
                ${agent.locationId}, ${agent.status}, ${agent.routeId},
                ${agent.needBaseline.hunger}, ${agent.needBaseline.fatigue}, ${agent.goal},
                ${agent.caution})
      `.execute(db);
    } else if (release.needBaselines) {
      await sql`
        insert into agents (world_id, agent_id, name, location_id, status, route_id,
                            hunger_baseline, fatigue_baseline)
        values (${state.worldId}, ${agent.id}, ${init.content.agentNames[agent.id] ?? agent.id},
                ${agent.locationId}, ${agent.status}, ${agent.routeId},
                ${agent.needBaseline.hunger}, ${agent.needBaseline.fatigue})
      `.execute(db);
    } else {
      await sql`
        insert into agents (world_id, agent_id, name, location_id, status, route_id)
        values (${state.worldId}, ${agent.id}, ${init.content.agentNames[agent.id] ?? agent.id},
                ${agent.locationId}, ${agent.status}, ${agent.routeId})
      `.execute(db);
    }
  }
};

describe('N-1 — обновление с предыдущей поставки', () => {
  let testDb: TestDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    testDb = await createTestDatabase('upgrade_path');
    db = createDatabase(parseDatabaseConnectionUrl(testDb.url));
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  it('журнал предыдущей поставки доводится до текущей схемы без потери данных', async () => {
    const previous = migrations.slice(0, -1);
    expect(previous.length).toBeGreaterThan(0);

    // 1. Состояние «предыдущей поставки».
    await runMigrations({ db, migrations: previous, logger: SILENT });
    await ensureApplicationRoles(db, TEST_ROLE_PASSWORD);
    // Гранты здесь НЕ применяются намеренно: матрица описывает текущую схему и упоминает
    // таблицу, которой в предыдущей поставке ещё нет. Это не дефект, а порядок: `world migrate`
    // применяет гранты ПОСЛЕ миграций, и модель обновления обязана повторять этот порядок,
    // а не изобретать свой (найдено исполнением при написании теста).
    await writePreviousReleaseWorld(db, { needBaselines: true, goal: true, risk: true });

    const appliedBefore = await db
      .selectFrom('schema_migrations')
      .select('id')
      .orderBy('id')
      .execute();
    expect(appliedBefore.map((row) => row.id)).toEqual(previous.map((m) => m.id));

    // 2. Обновление до текущего реестра.
    const report = await runMigrations({ db, migrations, logger: SILENT });
    expect(report.applied.map((entry) => entry.id)).toEqual([
      migrations[migrations.length - 1]!.id,
    ]);

    // 3. Схема текущая, данные целы, гранты переприменяются без сбоя.
    await applyGrants(db);
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    expect(state?.worldId).toBe(FIXTURE_WORLD_ID);
    expect(Object.keys(state?.agents ?? {})).toHaveLength(2);

    const appliedAfter = await db
      .selectFrom('schema_migrations')
      .select('id')
      .orderBy('id')
      .execute();
    expect(appliedAfter.map((row) => row.id)).toEqual(migrations.map((m) => m.id));
  });

  it('отредактированная выпущенная миграция даёт названный отказ, а не порчу схемы', async () => {
    // Тот самый класс, которым оказался blocker N-1: id переиспользован под другим смыслом.
    // Здесь он обязан быть громким отказом ДО применения чего бы то ни было.
    const client = new Client({ connectionString: testDb.url });
    await client.connect();
    try {
      await client.query(
        `update schema_migrations set name = 'renamed-after-release' where id = $1`,
        [migrations[2]!.id],
      );
    } finally {
      await client.end();
    }

    try {
      await expect(runMigrations({ db, migrations, logger: SILENT })).rejects.toThrow(
        /MIGRATION_NAME_MISMATCH/,
      );

      // Схема не тронута: отказ произошёл до применения.
      const state = await loadWorldState(db, FIXTURE_WORLD_ID);
      expect(state?.worldId).toBe(FIXTURE_WORLD_ID);
    } finally {
      // p-4: журнал возвращается в исходное состояние. Без этого следующий добавленный в файл
      // тест получал бы MIGRATION_NAME_MISMATCH по ЧУЖОЙ причине, и сейчас всё работает лишь
      // потому, что этот тест последний — то есть держится на порядке, а не на инварианте.
      const restore = new Client({ connectionString: testDb.url });
      await restore.connect();
      try {
        await restore.query(`update schema_migrations set name = $2 where id = $1`, [
          migrations[2]!.id,
          migrations[2]!.name,
        ]);
      } finally {
        await restore.end();
      }
    }
  });

  it('после уборки предыдущего теста миграции снова применяются штатно', () => {
    // Явная проверка того, что уборка работает: этот тест зелёный только если журнал
    // действительно восстановлен.
    return expect(runMigrations({ db, migrations, logger: SILENT })).resolves.toMatchObject({
      applied: [],
    });
  });
});

/**
 * Отдельная база: `upgrade-path` выше уже создал мир с тем же `world_id`, а B1 обязан начинать
 * с ПУСТОЙ схемы прежней поставки. Метка базы своя и по той же причине, по которой их вообще
 * различают — два процесса с одинаковой меткой уничтожают базы друг друга.
 */
describe('B1 — восстановление позиций PRNG при обновлении', () => {
  let testDb: TestDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    testDb = await createTestDatabase('upgrade_path_prng');
    db = createDatabase(parseDatabaseConnectionUrl(testDb.url));
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  /**
   * B1 второго раунда верификации. Миграция 0009 добавила `worlds.prng_stream_positions` со
   * значением по умолчанию `'{}'`, обосновав это тем, что «у любого существующего мира позиции
   * пусты по факту». Это неверно: розыгрыши делают не команды, а ГЕНЕЗИС — `seedAgents`
   * распределяет агентов по локациям через `DeterministicRandomSource`, по розыгрышу на агента.
   * Значит мир прежней поставки получал `{}` вместо своих настоящих позиций, и первый будущий
   * розыгрыш по потоку агента повторил бы генезисный при том же seed (SIM-01), молча: позиции не
   * входят в `WorldState`, поэтому ни сверка checksum в `world replay`, ни checksum снимка
   * (внутренне непротиворечивый с неверным значением) этого не видят.
   */
  it('B1: позиции PRNG мира прежней поставки восстанавливаются из его снимка, а не обнуляются', async () => {
    // «Прежняя поставка» здесь — это состояние ДО 0010, а не «весь реестр без последней». Разница
    // проявилась, как только за 0010 появилась 0011: `slice(0, -1)` стал включать сам backfill,
    // и тест проверял бы, что уже починенное остаётся починенным. Привязка к рубежу по ID, а не
    // к длине массива — иначе каждая новая миграция незаметно обессмысливала бы этот тест.
    const backfillIndex = migrations.findIndex((migration) => migration.id === '0010');
    expect(backfillIndex).toBeGreaterThan(0);
    const previous = migrations.slice(0, backfillIndex);
    await runMigrations({ db, migrations: previous, logger: SILENT });
    await ensureApplicationRoles(db, TEST_ROLE_PASSWORD);
    await writePreviousReleaseWorld(db, { needBaselines: false });

    // Снимок прежней поставки: позиции жили ТОЛЬКО в нём (до 0009 другого дома у них не было).
    const genesisPositions = { 'agent:rook': 1, 'agent:kite': 1 };
    await sql`
      insert into world_snapshots (world_id, last_sequence, world_time, checksum,
                                   prng_stream_positions, canonical_state,
                                   deterministic_runtime_profile, created_at)
      values (${FIXTURE_WORLD_ID}, 0, '2028-04-26T06:00:00.000Z', 'sha256:fixture',
              ${JSON.stringify(genesisPositions)}::jsonb, '{}'::jsonb, '{}'::jsonb, now())
    `.execute(db);

    await runMigrations({ db, migrations, logger: SILENT });

    const row = await sql<{
      readonly prng_stream_positions: unknown;
    }>`select prng_stream_positions from worlds where world_id = ${FIXTURE_WORLD_ID}`.execute(db);
    expect(row.rows[0]?.prng_stream_positions).toEqual(genesisPositions);
  });
});
