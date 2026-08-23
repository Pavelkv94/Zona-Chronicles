/**
 * Чтение и запись канонического состояния мира.
 *
 * Репозиторий переводит между реляционными строками и `WorldState` домена и НЕ содержит правил:
 * ни одного `if` о том, можно ли выйти на маршрут. Это граница ADR-003 — императивная оболочка
 * вокруг чистого ядра, а не второе место, где живут правила.
 */
import {
  decodeWorldEvent,
  isValidationFailure,
  requireCanonical,
  requireChecksum,
  type WorldEvent,
} from '@zona/contracts';
import { sql } from 'kysely';
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
  /**
   * Позиции потоков PRNG на момент создания мира (M4).
   *
   * ОБЯЗАТЕЛЬНОЕ поле, и это прямое следствие B1 (второй раунд верификации). Пока оно было
   * необязательным со значением `{}` по умолчанию, писатель, забывший его указать, молча
   * получал мир с неверными позициями — а генезис розыгрыши ДЕЛАЕТ, распределяя агентов по
   * локациям. Ровно этот капкан сработал на уровне схемы (`default '{}'` в миграции 0009) и
   * стоил blocker-а. Мир без единого розыгрыша объявляет `{}` явно.
   */
  readonly prngStreamPositions: Readonly<Record<string, number>>;
  /** Операционная отметка создания; по умолчанию — реальные часы этого процесса. */
  readonly createdAt?: Date;
}

export interface WorldMeta {
  readonly worldId: string;
  readonly seed: number;
  readonly versions: RulesetVersions;
  /** Позиции потоков PRNG мира — то, с чего продолжает источник случайности команды (M4). */
  readonly prngStreamPositions: Readonly<Record<string, number>>;
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
        prng_stream_positions: requireCanonical(
          init.prngStreamPositions,
          `worlds.prng_stream_positions(${state.worldId})`,
        ),
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

/**
 * Читает канонический `WorldState`. `null` — мира с таким id нет.
 *
 * ## Все четыре чтения — в ОДНОЙ транзакции (BLOCKER 2 первого раунда I02B, D14 итерации I03)
 *
 * Под `read committed` четыре независимых запроса могут вернуть состояние, которого в мире не
 * было: `agents` уже содержит эффект события N+1, а `worlds.last_sequence` — ещё нет. Ревьюер
 * воспроизвёл 9 несвязных чтений из 454 при работающем worker-е. Долг был принят осознанно и
 * записан в I03 требованием: проекции читают то же состояние, и правило «любое чтение,
 * становящееся артефактом, выполняется в одной транзакции» обязано действовать и здесь.
 *
 * Уровень изоляции здесь — `repeatable read`, а НЕ канонический `read committed`, и это не
 * вольность. Первая редакция правки открывала транзакцию с каноническим уровнем и дефект не
 * чинила: в `read committed` PostgreSQL берёт новый снимок на КАЖДЫЙ ОПЕРАТОР, поэтому четыре
 * запроса внутри одной транзакции видят четыре разных момента мира ровно так же, как без неё.
 * Поймано собственным тестом (`world-state-consistency.integration.test.ts`), а не рассуждением:
 * он показал `worldVersion 4` при пяти идущих путях.
 *
 * ADR-010 §10.1 фиксирует `read committed` для КАНОНИЧЕСКИХ ТРАНЗАКЦИЙ — там от уровня зависит
 * наблюдаемая семантика отказа (`stale_world_version` против брошенного `40001`). Здесь запись не
 * ведётся вовсе, отказ конкуренции невозможен, и `repeatable read` меняет ровно одно: четыре
 * запроса видят один момент. Профиль выполнения от этого не меняется — в нём записан уровень
 * канонической транзакции.
 *
 * Если вызывающий УЖЕ в транзакции (так делает `executeCommand`), своя не открывается: команда
 * держит замок строки мира и читает то, что сама же изменит; вложенная транзакция означала бы
 * savepoint — лишний и меняющий семантику отката. Признак берётся у самого соединения
 * (`isTransaction`), а не передаётся флагом: флаг однажды забыли бы выставить, и согласованность
 * исчезла бы молча.
 */
export const loadWorldState = async (
  db: DatabaseConnection,
  worldId: string,
): Promise<WorldState | null> =>
  db.isTransaction
    ? readWorldState(db, worldId)
    : db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => readWorldState(trx, worldId));

const readWorldState = async (
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
    .select([
      'world_id',
      'seed',
      'rules_version',
      'content_version',
      'schema_version',
      'prng_stream_positions',
    ])
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
    prngStreamPositions: world.prng_stream_positions as Readonly<Record<string, number>>,
  };
};

/**
 * Миры, у которых позиции PRNG пусты, вместе с их `seed` (B1, второй раунд верификации I02B).
 *
 * Нужна ровно одному потребителю — починке после миграции 0009, которая объявила позиции
 * пустыми у миров прежней поставки, хотя генезис делает по розыгрышу на агента. Миграция 0010
 * восстанавливает то, что можно восстановить из снимка; миры БЕЗ снимка чинить чистым SQL
 * нельзя — их позиции детерминированная функция `seed`, а `statements` миграции по контракту не
 * имеет доступа к PRNG.
 *
 * Пустая карта — надёжный признак «мир прежней поставки»: `world init` после 0009 всегда пишет
 * генезисные позиции, а они непусты, пока в контенте есть хотя бы один агент. Мир без агентов
 * `seedWorld` создать не даёт (`seedAgents` требует локаций, а `PROTOTYPE_WORLD` — агентов).
 */
export const loadWorldsWithEmptyPrngPositions = async (
  db: DatabaseConnection,
): Promise<readonly { readonly worldId: string; readonly seed: number }[]> => {
  const rows = await db
    .selectFrom('worlds')
    .select(['world_id', 'seed'])
    .where(sql<boolean>`prng_stream_positions = '{}'::jsonb`)
    .execute();
  return rows.map((row) => ({
    worldId: row.world_id,
    seed: requireSafeInteger(row.seed, `worlds.seed(${row.world_id})`),
  }));
};

/**
 * Записывает позиции PRNG мира. Отдельная от `executeCommand` операция и только для починки
 * (B1): обычный путь двигает позиции ВНУТРИ транзакции команды, вместе с `last_sequence`, и
 * подменять его отдельной записью нельзя — она разошлась бы с журналом.
 *
 * Условие `prng_stream_positions = '{}'` в WHERE, а не проверка в коде: между чтением списка и
 * этой записью мир мог получить настоящие позиции, и затирать их починкой нельзя. Возвращает,
 * произошла ли запись.
 */
export const repairWorldPrngPositions = async (
  db: DatabaseConnection,
  worldId: string,
  positions: Readonly<Record<string, number>>,
): Promise<boolean> => {
  const result = await db
    .updateTable('worlds')
    .set({
      prng_stream_positions: requireCanonical(
        positions,
        `worlds.prng_stream_positions(${worldId})`,
      ),
    })
    .where('world_id', '=', worldId)
    .where(sql<boolean>`prng_stream_positions = '{}'::jsonb`)
    .executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
};

/**
 * Статический контент мира: имена и описания локаций, имена агентов (I03).
 *
 * `loadWorldState` их не отдаёт намеренно — домену они не нужны, а `WorldState` описывает то, что
 * меняется. Проекции они нужны: карта без названий нечитаема. Отдельная функция, а не расширение
 * `WorldState`, чтобы неизменяемое не путешествовало через каждый `evolve`.
 */
export interface WorldContentSnapshot {
  readonly locations: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  }[];
  readonly agentNames: Readonly<Record<string, string>>;
}

export const loadWorldContent = async (
  db: DatabaseConnection,
  worldId: string,
): Promise<WorldContentSnapshot> => {
  const [locations, agents] = await Promise.all([
    db
      .selectFrom('locations')
      .select(['location_id', 'name', 'description'])
      .where('world_id', '=', worldId)
      .orderBy('location_id')
      .execute(),
    db
      .selectFrom('agents')
      .select(['agent_id', 'name'])
      .where('world_id', '=', worldId)
      .orderBy('agent_id')
      .execute(),
  ]);

  return {
    locations: locations.map((row) => ({
      id: row.location_id,
      name: row.name,
      description: row.description,
    })),
    agentNames: Object.fromEntries(agents.map((row) => [row.agent_id, row.name])),
  };
};

/**
 * События из outbox строго после `afterSequence`, по возрастанию (I03, сборка проекции).
 *
 * Читается ИМЕННО outbox, а не `world_events`: outbox существует ровно для доставки фактов
 * подписчикам, и строка в нём появляется в той же транзакции, что событие, но ПОСЛЕ состояния
 * (`command-handler.ts`, инвариант 3 PLAN §7 I02A). Подписчик, читающий журнал напрямую, мог бы
 * увидеть событие раньше, чем состояние, которое оно объясняет.
 *
 * `published_at` НЕ трогается. У проекции свой курсор (`projection_state.last_event_sequence`), и
 * отметка «доставлено» в общей таблице означала бы, что первый же подписчик закрывает событие для
 * всех остальных. Подписчиков будет больше одного (лента, карта, летопись I16), и каждый обязан
 * вести свою позицию.
 *
 * Checksum события ПРОВЕРЯЕТСЯ, как и в `loadWorldEvents`: строка outbox хранит `jsonb`, который
 * не сохраняет канонический порядок ключей, и точность обратного чтения обязана быть проверяемой.
 */
export const loadOutboxEventsAfter = async (
  db: DatabaseConnection,
  worldId: string,
  afterSequence: number,
  limit: number,
): Promise<readonly WorldEvent[]> => {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(
      `persistence: limit обязан быть положительным целым, получено ${String(limit)}`,
    );
  }
  const rows = await db
    .selectFrom('outbox')
    .select(['event_id', 'sequence', 'payload'])
    .where('world_id', '=', worldId)
    .where('sequence', '>', String(afterSequence))
    .orderBy('sequence')
    .limit(limit)
    .execute();

  return rows.map((row) => {
    const decoded = decodeWorldEvent(row.payload);
    if (isValidationFailure(decoded)) {
      throw new Error(
        `persistence: строка outbox события ${row.event_id} не является валидным событием: ` +
          decoded.errors.map((issue) => `${issue.path} ${issue.message}`).join('; '),
      );
    }
    return decoded.value;
  });
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
