/**
 * Чтение и запись канонического состояния мира.
 *
 * Репозиторий переводит между реляционными строками и `WorldState` домена и НЕ содержит правил:
 * ни одного `if` о том, можно ли выйти на маршрут. Это граница ADR-003 — императивная оболочка
 * вокруг чистого ядра, а не второе место, где живут правила.
 */
import { requireChecksum, type WorldEvent } from '@zona/contracts';
import type {
  AgentState,
  RouteDefinition,
  RulesetVersions,
  ScheduledAction,
  WorldState,
} from '@zona/domain';
import { requireSafeInteger, type DatabaseConnection } from './database.ts';

export interface WorldContent {
  readonly locations: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  }[];
  /** Имя агента — представление, а не доменное состояние: `WorldState` его не содержит. */
  readonly agentNames: Readonly<Record<string, string>>;
}

export interface WorldInitialization {
  readonly seed: number;
  readonly state: WorldState;
  readonly versions: RulesetVersions;
  readonly content: WorldContent;
  /** Операционная отметка создания; по умолчанию — реальные часы этого процесса. */
  readonly createdAt?: Date;
}

export interface WorldMeta {
  readonly worldId: string;
  readonly seed: number;
  readonly versions: RulesetVersions;
}

/**
 * Записывает мир, ещё не имеющий событий. Идемпотентности здесь нет намеренно: повторная
 * инициализация существующего мира — не «повтор команды», а попытка перезаписать историю,
 * и она обязана падать на первичном ключе, а не тихо проходить.
 */
export const initializeWorld = async (
  db: DatabaseConnection,
  init: WorldInitialization,
): Promise<void> => {
  const createdAt = init.createdAt ?? new Date();
  const { state, versions, content } = init;

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('worlds')
      .values({
        world_id: state.worldId,
        seed: init.seed,
        version: state.worldVersion,
        last_sequence: state.sequence,
        world_time: state.worldTime,
        rules_version: versions.rulesVersion,
        content_version: versions.contentVersion,
        schema_version: versions.schemaVersion,
        created_at: createdAt,
      })
      .execute();

    if (content.locations.length > 0) {
      await trx
        .insertInto('locations')
        .values(
          content.locations.map((location) => ({
            world_id: state.worldId,
            location_id: location.id,
            name: location.name,
            description: location.description,
          })),
        )
        .execute();
    }

    const routes = Object.values(state.routes);
    if (routes.length > 0) {
      await trx
        .insertInto('routes')
        .values(
          routes.map((route) => ({
            world_id: state.worldId,
            route_id: route.id,
            from_location_id: route.fromLocationId,
            to_location_id: route.toLocationId,
            travel_minutes: route.travelMinutes,
          })),
        )
        .execute();
    }

    const agents = Object.values(state.agents);
    if (agents.length > 0) {
      await trx
        .insertInto('agents')
        .values(
          agents.map((agent) => ({
            world_id: state.worldId,
            agent_id: agent.id,
            name: content.agentNames[agent.id] ?? agent.id,
            location_id: agent.locationId,
            status: agent.status,
            route_id: agent.routeId,
          })),
        )
        .execute();
    }
  });
};

/** Читает канонический `WorldState`. `null` — мира с таким id нет. */
export const loadWorldState = async (
  db: DatabaseConnection,
  worldId: string,
): Promise<WorldState | null> => {
  const world = await db
    .selectFrom('worlds')
    .selectAll()
    .where('world_id', '=', worldId)
    .executeTakeFirst();
  if (world === undefined) return null;

  const [agentRows, routeRows, actionRows] = await Promise.all([
    db
      .selectFrom('agents')
      .selectAll()
      .where('world_id', '=', worldId)
      .orderBy('agent_id')
      .execute(),
    db
      .selectFrom('routes')
      .selectAll()
      .where('world_id', '=', worldId)
      .orderBy('route_id')
      .execute(),
    // Каноническим является только НЕЗАВЕРШЁННОЕ расписание: выполненные строки остаются в
    // таблице как история обработки (ACCEPTANCE C2) и в состояние мира не входят.
    db
      .selectFrom('scheduled_actions')
      .selectAll()
      .where('world_id', '=', worldId)
      .where('completed_at', 'is', null)
      .orderBy('action_id')
      .execute(),
  ]);

  const agents: Record<string, AgentState> = {};
  for (const row of agentRows) {
    agents[row.agent_id] = {
      id: row.agent_id,
      locationId: row.location_id,
      status: row.status,
      routeId: row.route_id,
    };
  }

  const routes: Record<string, RouteDefinition> = {};
  for (const row of routeRows) {
    routes[row.route_id] = {
      id: row.route_id,
      fromLocationId: row.from_location_id,
      toLocationId: row.to_location_id,
      travelMinutes: row.travel_minutes,
    };
  }

  const scheduledActions: Record<string, ScheduledAction> = {};
  for (const row of actionRows) {
    scheduledActions[row.action_id] = {
      id: row.action_id,
      kind: row.kind,
      dueAt: row.due_at,
      priority: row.priority,
      entityId: row.entity_id,
      routeId: row.route_id,
    };
  }

  return {
    worldId: world.world_id,
    worldVersion: requireSafeInteger(world.version, `worlds.version(${worldId})`),
    worldTime: world.world_time,
    sequence: requireSafeInteger(world.last_sequence, `worlds.last_sequence(${worldId})`),
    agents,
    routes,
    scheduledActions,
  };
};

/** Читает seed и версии bundle-ов мира — то, чего нет в `WorldState`, но требует `decide`. */
export const loadWorldMeta = async (
  db: DatabaseConnection,
  worldId: string,
): Promise<WorldMeta | null> => {
  const world = await db
    .selectFrom('worlds')
    .select(['world_id', 'seed', 'rules_version', 'content_version', 'schema_version'])
    .where('world_id', '=', worldId)
    .executeTakeFirst();
  if (world === undefined) return null;
  return {
    worldId: world.world_id,
    seed: requireSafeInteger(world.seed, `worlds.seed(${worldId})`),
    versions: {
      schemaVersion: world.schema_version,
      rulesVersion: world.rules_version,
      contentVersion: world.content_version,
    },
  };
};

/**
 * Читает канонический журнал мира и ПРОВЕРЯЕТ каждое событие по его checksum (M-3).
 *
 * Событие восстанавливается из строки и сверяется с checksum, снятым до записи. Расхождение —
 * громкий сбой, а не тихо отличающийся факт: журнал невосполним, и молча «почти то же самое»
 * событие хуже отсутствующего. Именно эта функция станет входом replay в I02B, поэтому
 * проверка живёт здесь, а не в тесте.
 */
export const loadWorldEvents = async (
  db: DatabaseConnection,
  worldId: string,
): Promise<readonly WorldEvent[]> => {
  const rows = await db
    .selectFrom('world_events')
    .selectAll()
    .where('world_id', '=', worldId)
    .orderBy('sequence')
    .execute();

  return rows.map((row) => {
    const event = {
      event_id: row.event_id,
      world_id: row.world_id,
      sequence: requireSafeInteger(row.sequence, `world_events.sequence(${row.event_id})`),
      world_time: row.world_time,
      type: row.type,
      schema_version: row.schema_version,
      rules_version: row.rules_version,
      content_version: row.content_version,
      actor_ids: row.actor_ids,
      subject_ids: row.subject_ids,
      location_id: row.location_id,
      correlation_id: row.correlation_id,
      caused_by: row.caused_by,
      command_id: row.command_id,
      random_audit: row.random_audit ?? null,
      payload: row.payload,
      recorded_at: row.recorded_at.toISOString(),
    } as WorldEvent;

    const actual = requireChecksum(event, `event(${row.event_id})`);
    if (actual !== row.event_checksum) {
      throw new Error(
        `persistence: событие ${row.event_id} прочитано из БД в форме, не совпадающей с ` +
          `checksum, снятым при записи (записано ${row.event_checksum}, прочитано ${actual}). ` +
          'Журнал невосполним — расхождение обязано быть сбоем, а не тихо другим фактом.',
      );
    }
    return event;
  });
};
