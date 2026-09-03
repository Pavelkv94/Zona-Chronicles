/**
 * B2, B3, B4 — транзакционный command handler (I02A ACCEPTANCE).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { RUNTIME_ID_PREFIXES, type JourneyStartCommand } from '@zona/contracts';
import { DerivedIdFactory } from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_BACK_ROUTE_ID,
  FIXTURE_OTHER_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { initializeWorld, loadWorldEvents, loadWorldState } from './world-repository.ts';
import { executeCommand } from './command-handler.ts';

const ids = new DerivedIdFactory('i02a-test');

const command = (overrides: Partial<JourneyStartCommand> = {}): JourneyStartCommand => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: FIXTURE_AGENT_ID,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: 0,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
  ...overrides,
});

describe('B2/B3/B4 — атомарный старт journey', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('command_handler');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  afterEach(async () => {
    await truncateWorldData(db);
  });

  const seedWorld = async (): Promise<void> => {
    await initializeWorld(db, fixtureInitialization());
  };

  const counts = async (): Promise<Record<string, number>> => {
    const rows = await Promise.all(
      (['world_events', 'outbox', 'command_results'] as const).map(async (table) => {
        const result = await db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        return [table, Number(result.n)] as const;
      }),
    );
    return Object.fromEntries(rows);
  };

  it('B2: принятая команда пишет событие, состояние, outbox и результат', async () => {
    await seedWorld();
    const cmd = command();
    const result = await executeCommand(db, cmd);

    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.eventIds).toHaveLength(1);
    expect(result.worldVersionBefore).toBe(0);
    expect(result.worldVersionAfter).toBe(1);
    expect(result.replayed).toBe(false);

    const events = await db.selectFrom('world_events').selectAll().execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('journey.started');
    expect(Number(events[0]?.sequence)).toBe(1);
    expect(events[0]?.command_id).toBe(cmd.command_id);
    expect(events[0]?.recorded_at).toBeInstanceOf(Date);

    const world = await db
      .selectFrom('worlds')
      .selectAll()
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .executeTakeFirstOrThrow();
    expect(Number(world.version)).toBe(1);
    expect(Number(world.last_sequence)).toBe(1);

    const agent = await db
      .selectFrom('agents')
      .selectAll()
      .where('agent_id', '=', FIXTURE_AGENT_ID)
      .executeTakeFirstOrThrow();
    expect(agent.status).toBe('traveling');
    expect(agent.route_id).toBe(FIXTURE_ROUTE_ID);

    const outbox = await db.selectFrom('outbox').selectAll().execute();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event_id).toBe(events[0]?.event_id);
    expect(outbox[0]?.published_at).toBeNull();

    const stored = await db.selectFrom('command_results').selectAll().executeTakeFirstOrThrow();
    expect(stored.outcome).toBe('accepted');
    expect(stored.event_ids).toEqual([events[0]?.event_id]);
  });

  it('B3: повтор той же команды возвращает записанный результат без второго события', async () => {
    await seedWorld();
    const cmd = command();
    const first = await executeCommand(db, cmd);
    const before = await counts();

    const second = await executeCommand(db, cmd);
    expect(second).toEqual({ ...first, replayed: true });
    expect(await counts()).toEqual(before);
  });

  it('B3: повтор идемпотентен даже с устаревшей expected_world_version', async () => {
    await seedWorld();
    const cmd = command();
    const first = await executeCommand(db, cmd);
    const before = await counts();

    // Мир уже версии 1, команда всё ещё заявляет 0 — но это ТОТ ЖЕ command_id.
    const second = await executeCommand(db, cmd);
    expect(second.outcome).toBe('accepted');
    expect(second).toEqual({ ...first, replayed: true });
    expect(await counts()).toEqual(before);
  });

  it('M-2: чужая команда под уже записанным command_id отвергается, а не «принимается»', async () => {
    // Аудит I02A: `readStoredResult` сверял только (world_id, command_id) и возвращал чужой
    // результат как свой. `--command-id` — публичный флаг CLI, то есть вход, управляемый
    // снаружи: вызывающему сообщали «принято» про команду, которой не было, и отдавали чужие
    // event_ids. Идемпотентность обязана требовать ТУ ЖЕ команду, а не тот же идентификатор.
    await seedWorld();
    const original = command();
    const first = await executeCommand(db, original);
    expect(first.outcome).toBe('accepted');

    const impostor: JourneyStartCommand = {
      ...original,
      actor_id: 'agent:ghost',
      expected_world_version: 999,
      payload: { route_id: 'route:missing' },
    };
    const result = await executeCommand(db, impostor);

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') return;
    expect(result.rejectionCode).toBe('precondition_failed');
    expect(result.rejectionMessage).toMatch(/command_id/);
    // Ни события, ни второй строки journal: подделка не меняет мир и не переписывает результат.
    expect(await counts()).toEqual({ world_events: 1, outbox: 1, command_results: 1 });

    // N-3: но след она оставляет. Это единственный отказ, значимый для безопасности —
    // попытка подставить чужой command_id обязана быть видна, а не исчезать бесследно.
    const attempts = await db.selectFrom('command_attempt_rejections').selectAll().execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.command_id).toBe(original.command_id);
    expect(attempts[0]?.rejection_code).toBe('precondition_failed');
    expect(attempts[0]?.recorded_fingerprint).not.toBe(attempts[0]?.attempted_fingerprint);
    expect(attempts[0]?.recorded_at).toBeInstanceOf(Date);
  });

  it('N-4: повтор со свежим correlation_id остаётся идемпотентным, а не подменой', async () => {
    // Отпечаток считается по СЕМАНТИЧЕСКИМ полям. Клиент, пересобравший команду при ретрае со
    // свежим id трассировки, обязан получить записанный результат, а не precondition_failed:
    // иначе journal защищал бы от добросовестного повтора, ради которого он и существует.
    await seedWorld();
    const original = command();
    const first = await executeCommand(db, original);
    expect(first.outcome).toBe('accepted');

    const retried = await executeCommand(db, {
      ...original,
      correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
      issued_at_world_time: '2028-04-26T09:30:00.000Z',
    });
    expect(retried).toEqual({ ...first, replayed: true });
    expect(await counts()).toEqual({ world_events: 1, outbox: 1, command_results: 1 });
    expect(await db.selectFrom('command_attempt_rejections').selectAll().execute()).toHaveLength(0);
  });

  it.each([
    ['маршрут не существует', { payload: { route_id: 'route:missing' } }, 'route_unavailable'],
    [
      'маршрут не начинается в локации агента',
      { payload: { route_id: FIXTURE_BACK_ROUTE_ID } },
      'route_unavailable',
    ],
    ['агент не существует', { actor_id: 'agent:ghost' }, 'actor_not_actionable'],
    ['устаревшая версия мира', { expected_world_version: 7 }, 'stale_world_version'],
  ])('B4: отказ «%s» записан и не породил событий', async (_label, overrides, code) => {
    await seedWorld();
    const result = await executeCommand(db, command(overrides));

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') return;
    expect(result.rejectionCode).toBe(code);
    expect(result.worldVersionAfter).toBe(0);

    expect(await counts()).toEqual({ world_events: 0, outbox: 0, command_results: 1 });
    const world = await db
      .selectFrom('worlds')
      .selectAll()
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .executeTakeFirstOrThrow();
    expect(Number(world.version)).toBe(0);
  });

  it('B4: агент уже в пути отклоняется как actor_not_actionable', async () => {
    await seedWorld();
    await executeCommand(db, command());
    const result = await executeCommand(
      db,
      command({ expected_world_version: 1, payload: { route_id: FIXTURE_ROUTE_ID } }),
    );
    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') return;
    expect(result.rejectionCode).toBe('actor_not_actionable');
    expect(await counts()).toEqual({ world_events: 1, outbox: 1, command_results: 2 });
  });

  it('состояние, прочитанное обратно, отражает применённое событие', async () => {
    await seedWorld();
    await executeCommand(db, command({ actor_id: FIXTURE_OTHER_AGENT_ID }));
    const state = await loadWorldState(db, FIXTURE_WORLD_ID);
    expect(state?.worldVersion).toBe(1);
    expect(state?.sequence).toBe(1);
    expect(state?.agents[FIXTURE_OTHER_AGENT_ID]).toEqual({
      id: FIXTURE_OTHER_AGENT_ID,
      locationId: 'loc:quiet-yard',
      status: 'traveling',
      routeId: FIXTURE_ROUTE_ID,
      needBaseline: { hunger: FIXTURE_WORLD_TIME, fatigue: FIXTURE_WORLD_TIME },
      // Вышедший в путь занят: цель у него по-прежнему праздная, потому что путь этого среза
      // целью не является — маршруты выбирает оператор, а не агент (I05 §6, out of scope).
      goal: 'idle',
      // Плана нет по той же причине: у праздности плана не бывает.
      planId: null,
      caution: 1000,
      knownRoutes: {},
    });
  });
});

describe('M-3 — точность round-trip события через jsonb', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('event_roundtrip');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  afterEach(async () => {
    await truncateWorldData(db);
  });

  it('прочитанное событие совпадает с записанным по checksum', async () => {
    await initializeWorld(db, fixtureInitialization());
    const cmd = command();
    const executed = await executeCommand(db, cmd);
    expect(executed.outcome).toBe('accepted');

    const events = await loadWorldEvents(db, FIXTURE_WORLD_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_id).toBe(
      executed.outcome === 'accepted' ? executed.eventIds[0] : undefined,
    );
    expect(events[0]?.command_id).toBe(cmd.command_id);
  });

  it('порча сохранённого события ловится checksum-ом, а не проходит молча', async () => {
    await initializeWorld(db, fixtureInitialization());
    await executeCommand(db, command());

    // Правка идёт мимо приложения (роль owner), как это сделал бы ручной SQL или сбой носителя.
    await sql`update world_events set payload = jsonb_set(payload, '{route_id}', '"route:tampered"')`.execute(
      db,
    );

    await expect(loadWorldEvents(db, FIXTURE_WORLD_ID)).rejects.toThrow(
      /не совпадающей с checksum/,
    );
  });
});

describe('m-4 — сверка перечитанного состояния действительно срабатывает', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('readback_guard');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('запись, потерявшая часть состояния, отменяет транзакцию', async () => {
    // Замечание независимой проверки тестов (п.3): guard выполняется на каждом accepted-пути,
    // но «сработает ли он, если сломается» было доказано рассуждением, а не пробой.
    //
    // Механизм расхождения — ВНЕШНИЙ: триггер БД, молча возвращающий старые значения. Это
    // ровно тот класс дефекта, ради которого guard существует (забытое поле в `changedAgents`,
    // чужой триггер, правило), и он не требует расширять шов `afterStep` в production-коде.
    await initializeWorld(db, fixtureInitialization());
    await sql`
      create function probe_swallow_agent_update() returns trigger as $$
      begin
        new.route_id := old.route_id;
        new.status := old.status;
        return new;
      end;
      $$ language plpgsql
    `.execute(db);
    await sql`
      create trigger probe_swallow_agent_update before update on agents
      for each row execute function probe_swallow_agent_update()
    `.execute(db);

    try {
      await expect(executeCommand(db, command())).rejects.toThrow(
        /записанное состояние мира .* не совпадает с результатом evolve/,
      );

      // Транзакция отменена целиком: события нет, версия мира не сдвинулась.
      expect(await db.selectFrom('world_events').selectAll().execute()).toHaveLength(0);
      const world = await db
        .selectFrom('worlds')
        .selectAll()
        .where('world_id', '=', FIXTURE_WORLD_ID)
        .executeTakeFirstOrThrow();
      expect(Number(world.version)).toBe(0);
    } finally {
      await sql`drop trigger probe_swallow_agent_update on agents`.execute(db);
      await sql`drop function probe_swallow_agent_update()`.execute(db);
    }
  });
});
