/**
 * Чтение и запись observer projection (I03).
 *
 * Разделение обязанностей: ЧТЕНИЕ обслуживает observer API, ЗАПИСЬ — сборщик проекции в worker-е.
 * Обе половины живут здесь, потому что обе работают с одной схемой, но физическое разделение даёт
 * не код, а гранты: `zona_api` имеет только `SELECT` на `projection_*`, поэтому вызов writer-а из
 * API отвергнет БАЗА, а не соглашение (D5).
 */
import { sql } from 'kysely';
import {
  NEED_KINDS,
  NEED_LEVELS,
  type NeedKind,
  type NeedLevel,
  type ObserverEvent,
  type ObserverWorldSnapshot,
} from '@zona/contracts';
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
        needs: {
          hunger: needLevelFromRow(row.hunger_level, row.agent_id, 'hunger'),
          fatigue: needLevelFromRow(row.fatigue_level, row.agent_id, 'fatigue'),
        },
        food_carried: row.food_carried,
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
      need: needKindFromRow(row.need, row.event_id),
      need_level: needLevelFromNullableRow(row.need_level, row.event_id),
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
          need: event.need,
          need_level: event.need_level,
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
          hunger_level: agent.needs.hunger,
          fatigue_level: agent.needs.fatigue,
          food_carried: agent.food_carried,
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
            hunger_level: agent.needs.hunger,
            fatigue_level: agent.needs.fatigue,
            food_carried: agent.food_carried,
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

/**
 * Проверяет, что роль подключения НЕ ИМЕЕТ доступа к каноническим таблицам (D5, m6 аудита I03).
 *
 * ## Зачем это в рантайме, если есть гранты и тесты
 *
 * Гранты доказывают, что роль `zona_api` бессильна. Они НЕ доказывают, что API подключился
 * именно ею. Одна опечатка в окружении — `PROJECTION_DATABASE_URL` со значением `DATABASE_URL` —
 * и observer-путь ходит под ролью worker-а: код тот же, тесты те же, D5 нарушен, и ни один
 * контроль этого не заметит. Именно так граница, выраженная правами, теряется на развёртывании.
 *
 * Проверка спрашивает у САМОЙ БАЗЫ, а не у конфигурации: `has_table_privilege` отвечает про
 * действующее подключение. Отсутствие таблицы — не отказ: схема проекции может жить отдельно от
 * канонической, и требовать наличия канонических таблиц значило бы навязать топологию.
 */
export const assertObserverRoleIsReadOnly = async (db: ProjectionDatabase): Promise<void> => {
  const rows = await sql<{ readonly table_name: string; readonly allowed: boolean | null }>`
    select t.table_name,
           case when to_regclass('public.' || t.table_name) is null then null
                else has_table_privilege(current_user, 'public.' || t.table_name, 'SELECT')
           end as allowed
      from (values ('world_events'), ('worlds'), ('agents'), ('command_results'),
                   ('scheduled_actions'), ('world_snapshots'), ('outbox')) as t(table_name)
  `.execute(db);

  const reachable = rows.rows.filter((row) => row.allowed === true).map((row) => row.table_name);
  if (reachable.length > 0) {
    const who = await sql<{ readonly current_user: string }>`select current_user`.execute(db);
    throw new Error(
      `projections: observer-путь подключён ролью "${who.rows[0]?.current_user ?? '?'}", у которой ` +
        `есть доступ к каноническим таблицам: ${reachable.join(', ')}. Это нарушение D5/OPS-02, и ` +
        'почти всегда причина одна: PROJECTION_DATABASE_URL совпал с DATABASE_URL. Наблюдатель ' +
        'обязан быть бессилен ПРАВАМИ, а не тем, что его код не пишет таких запросов.',
    );
  }
};

/**
 * Уровень нужды из колонки проекции. Неизвестное значение — ГРОМКИЙ сбой, а не подстановка
 * `normal`: строка, которую записал не этот код, означает рассинхронизацию схемы и кода, и
 * молчаливая подстановка показала бы зрителю спокойного агента вместо голодного.
 */
const needLevelFromRow = (value: string, agentId: string, need: string): NeedLevel => {
  if ((NEED_LEVELS as readonly string[]).includes(value)) return value as NeedLevel;
  throw new Error(
    `projection: у агента ${agentId} уровень нужды "${need}" равен ${JSON.stringify(value)}, ` +
      `а известны только ${NEED_LEVELS.join(', ')}`,
  );
};

const needLevelFromNullableRow = (value: string | null, eventId: string): NeedLevel | null =>
  value === null ? null : needLevelFromRow(value, eventId, 'событие ленты');

const needKindFromRow = (value: string | null, eventId: string): NeedKind | null => {
  if (value === null) return null;
  if ((NEED_KINDS as readonly string[]).includes(value)) return value as NeedKind;
  throw new Error(
    `projection: у события ${eventId} вид нужды равен ${JSON.stringify(value)}, ` +
      `а известны только ${NEED_KINDS.join(', ')}`,
  );
};
