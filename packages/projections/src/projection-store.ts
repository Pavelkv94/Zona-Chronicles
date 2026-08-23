/**
 * Чтение и запись observer projection (I03).
 *
 * Разделение обязанностей: ЧТЕНИЕ обслуживает observer API, ЗАПИСЬ — сборщик проекции в worker-е.
 * Обе половины живут здесь, потому что обе работают с одной схемой, но физическое разделение даёт
 * не код, а гранты: `zona_api` имеет только `SELECT` на `projection_*`, поэтому вызов writer-а из
 * API отвергнет БАЗА, а не соглашение (D5).
 */
import type { ObserverEvent, ObserverWorldSnapshot } from '@zona/contracts';
import type { ObserverProjectionState } from './observer-fold.ts';
import { type ProjectionDatabase, requireSafeInteger } from './projection-database.ts';

/** Позиция проекции: докуда доведена и сколько журнала применено. */
export interface ProjectionCursor {
  readonly projectionSequence: number;
  readonly lastEventSequence: number;
  readonly worldTime: string;
}

export const loadProjectionCursor = async (
  db: ProjectionDatabase,
  worldId: string,
): Promise<ProjectionCursor | null> => {
  const row = await db
    .selectFrom('projection_state')
    .selectAll()
    .where('world_id', '=', worldId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    projectionSequence: requireSafeInteger(row.projection_sequence, 'projection_sequence'),
    lastEventSequence: requireSafeInteger(row.last_event_sequence, 'last_event_sequence'),
    worldTime: row.world_time,
  };
};

/**
 * Полный observer snapshot: карта, агенты и курсор.
 *
 * Читается В ОДНОЙ ТРАНЗАКЦИИ (D14). Четыре независимых запроса под `read committed` могли бы
 * вернуть агентов версии N и курсор версии N+k — зритель получил бы состояние, которого в мире
 * не было, и восстановление после перезагрузки страницы стало бы неверным именно тогда, когда
 * мир активно меняется. Тот же дефект, что BLOCKER 2 первого раунда I02B, и повторять его в
 * observer-слое, зная о нём, было бы непростительно.
 */
export const loadObserverSnapshot = async (
  db: ProjectionDatabase,
  worldId: string,
): Promise<ObserverWorldSnapshot | null> =>
  db.transaction().execute(async (trx) => {
    const state = await trx
      .selectFrom('projection_state')
      .selectAll()
      .where('world_id', '=', worldId)
      .executeTakeFirst();
    if (state === undefined) return null;

    const [nodes, edges, agents] = await Promise.all([
      trx
        .selectFrom('projection_locations')
        .selectAll()
        .where('world_id', '=', worldId)
        .orderBy('location_id')
        .execute(),
      trx
        .selectFrom('projection_routes')
        .selectAll()
        .where('world_id', '=', worldId)
        .orderBy('route_id')
        .execute(),
      trx
        .selectFrom('projection_agents')
        .selectAll()
        .where('world_id', '=', worldId)
        .orderBy('agent_id')
        .execute(),
    ]);

    return {
      world_id: state.world_id,
      projection_sequence: requireSafeInteger(state.projection_sequence, 'projection_sequence'),
      world_time: state.world_time,
      nodes: nodes.map((row) => ({
        location_id: row.location_id,
        name: row.name,
        description: row.description,
      })),
      edges: edges.map((row) => ({
        route_id: row.route_id,
        from_location_id: row.from_location_id,
        to_location_id: row.to_location_id,
        travel_minutes: row.travel_minutes,
      })),
      agents: agents.map((row) => ({
        agent_id: row.agent_id,
        name: row.name,
        location_id: row.location_id,
        status: row.status === 'traveling' ? ('traveling' as const) : ('idle' as const),
        route_id: row.route_id,
      })),
    };
  });

export interface ObserverEventPage {
  readonly events: readonly ObserverEvent[];
  /** Самая ранняя доступная позиция: нужна, чтобы отличить «ещё нет» от «уже нет» (D10). */
  readonly earliestAvailableSequence: number | null;
}

/**
 * Лента строго ПОСЛЕ курсора, по возрастанию, не более `limit` записей.
 *
 * `earliestAvailableSequence` возвращается всегда, а не только при промахе: вызывающему нужно
 * отличить «клиент отстал за пределы окна» от «событий пока нет». Без этого различия
 * переподключение с потерянной позицией выглядело бы как тихая пустая лента (D10).
 */
export const loadObserverEvents = async (
  db: ProjectionDatabase,
  worldId: string,
  options: { readonly after: number; readonly limit: number },
): Promise<ObserverEventPage> => {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    throw new Error(
      `projections: limit обязан быть положительным целым, получено ${String(options.limit)}`,
    );
  }
  const rows = await db
    .selectFrom('projection_events')
    .selectAll()
    .where('world_id', '=', worldId)
    .where('projection_sequence', '>', String(options.after))
    .orderBy('projection_sequence')
    .limit(options.limit)
    .execute();

  const earliest = await db
    .selectFrom('projection_events')
    .select('projection_sequence')
    .where('world_id', '=', worldId)
    .orderBy('projection_sequence')
    .limit(1)
    .executeTakeFirst();

  return {
    events: rows.map((row) => ({
      projection_sequence: requireSafeInteger(row.projection_sequence, 'projection_sequence'),
      event_id: row.event_id,
      world_time: row.world_time,
      type: row.type as ObserverEvent['type'],
      actor_ids: row.actor_ids,
      location_id: row.location_id,
      route_id: row.route_id,
    })),
    earliestAvailableSequence:
      earliest === undefined
        ? null
        : requireSafeInteger(earliest.projection_sequence, 'projection_sequence'),
  };
};

/**
 * Записывает результат шага сборки: состояние карты/агентов, курсор и порождённые записи ленты.
 *
 * Всё В ОДНОЙ ТРАНЗАКЦИИ, и это условие D6: курсор, продвинутый без записи ленты, означал бы
 * потерянные события при следующем догоне, а лента без курсора — их дубли. Атомарность здесь не
 * оптимизация, а само свойство «ровно один раз».
 */
export const saveProjectionStep = async (
  db: ProjectionDatabase,
  state: ObserverProjectionState,
  emitted: readonly ObserverEvent[],
  now: Date,
): Promise<void> => {
  await db.transaction().execute(async (trx) => {
    for (const event of emitted) {
      await trx
        .insertInto('projection_events')
        .values({
          world_id: state.worldId,
          projection_sequence: event.projection_sequence,
          event_id: event.event_id,
          world_time: event.world_time,
          type: event.type,
          actor_ids: [...event.actor_ids],
          location_id: event.location_id,
          route_id: event.route_id,
        })
        .execute();
    }

    for (const agent of Object.values(state.agents)) {
      await trx
        .updateTable('projection_agents')
        .set({
          name: agent.name,
          location_id: agent.location_id,
          status: agent.status,
          route_id: agent.route_id,
        })
        .where('world_id', '=', state.worldId)
        .where('agent_id', '=', agent.agent_id)
        .execute();
    }

    await trx
      .updateTable('projection_state')
      .set({
        projection_sequence: state.projectionSequence,
        last_event_sequence: state.lastEventSequence,
        world_time: state.worldTime,
        updated_at: now,
      })
      .where('world_id', '=', state.worldId)
      .execute();
  });
};

/**
 * Создаёт проекцию мира с нуля: карта, агенты и нулевой курсор.
 *
 * Идемпотентности нет намеренно — тот же довод, что у `initializeWorld`: повторная инициализация
 * существующей проекции это не повтор, а затирание. Пересборка выполняется через
 * {@link resetProjection}, где намерение выражено явно.
 */
export const initializeProjection = async (
  db: ProjectionDatabase,
  state: ObserverProjectionState,
  seed: {
    readonly nodes: ObserverWorldSnapshot['nodes'];
    readonly edges: ObserverWorldSnapshot['edges'];
  },
  now: Date,
): Promise<void> => {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('projection_state')
      .values({
        world_id: state.worldId,
        projection_sequence: state.projectionSequence,
        last_event_sequence: state.lastEventSequence,
        world_time: state.worldTime,
        updated_at: now,
      })
      .execute();

    if (seed.nodes.length > 0) {
      await trx
        .insertInto('projection_locations')
        .values(seed.nodes.map((node) => ({ world_id: state.worldId, ...node })))
        .execute();
    }
    if (seed.edges.length > 0) {
      await trx
        .insertInto('projection_routes')
        .values(seed.edges.map((edge) => ({ world_id: state.worldId, ...edge })))
        .execute();
    }
    const agents = Object.values(state.agents);
    if (agents.length > 0) {
      await trx
        .insertInto('projection_agents')
        .values(
          agents.map((agent) => ({
            world_id: state.worldId,
            agent_id: agent.agent_id,
            name: agent.name,
            location_id: agent.location_id,
            status: agent.status,
            route_id: agent.route_id,
          })),
        )
        .execute();
    }
  });
};

/**
 * Стирает проекцию мира целиком (D7).
 *
 * Единственный поддерживаемый способ починки: проекция не источник факта, поэтому её не правят, а
 * собирают заново из журнала. Правка строк «чтобы стало правильно» создала бы состояние, которое
 * из журнала не выводится, и следующая пересборка молча его отменила бы.
 */
export const resetProjection = async (db: ProjectionDatabase, worldId: string): Promise<void> => {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('projection_events').where('world_id', '=', worldId).execute();
    await trx.deleteFrom('projection_agents').where('world_id', '=', worldId).execute();
    await trx.deleteFrom('projection_routes').where('world_id', '=', worldId).execute();
    await trx.deleteFrom('projection_locations').where('world_id', '=', worldId).execute();
    await trx.deleteFrom('projection_state').where('world_id', '=', worldId).execute();
  });
};
