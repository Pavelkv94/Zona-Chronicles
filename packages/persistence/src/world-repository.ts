/**
 * Чтение и запись канонического состояния мира.
 *
 * Репозиторий переводит между реляционными строками и `WorldState` домена и НЕ содержит правил:
 * ни одного `if` о том, можно ли выйти на маршрут. Это граница ADR-003 — императивная оболочка
 * вокруг чистого ядра, а не второе место, где живут правила.
 */
import {
  ITEM_KINDS,
  NEED_KINDS,
  NEED_LEVELS,
  compareByCodePoint,
  decodeWorldEvent,
  isValidationFailure,
  requireCanonical,
  requireChecksum,
  type ItemKind,
  type NeedKind,
  type NeedLevel,
  type WorldEvent,
} from '@zona/contracts';
import { sql } from 'kysely';
import type {
  AgentState,
  ItemState,
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

  /**
   * Работает и внутри чужой транзакции, и сам по себе — тот же приём, что у `loadWorldState`.
   *
   * Понадобилось в I03 (M4 независимого аудита): `world init` стал создавать мир, профиль и
   * генезисный снимок ОДНОЙ транзакцией, а Kysely не поддерживает вложенные — попытка дала
   * `calling the transaction method for a Transaction is not supported`, и `world init` перестал
   * работать вовсе. Поймано acceptance-тестом атомарности по его собственной защите от
   * бессмысленного прогона: «ни один прогон не довёл создание до конца».
   *
   * Своя транзакция сохранена для прямых вызовов (тесты, будущие пути): создание мира атомарно
   * само по себе, а не только когда его кто-то обернул.
   */
  const write = async (trx: DatabaseConnection): Promise<void> => {
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
            hunger_baseline: agent.needBaseline.hunger,
            fatigue_baseline: agent.needBaseline.fatigue,
            goal: agent.goal,
            plan_id: agent.planId,
          })),
        )
        .execute();
    }

    const items = Object.values(state.items);
    if (items.length > 0) {
      await trx
        .insertInto('items')
        .values(
          items.map((item) => ({
            world_id: state.worldId,
            item_id: item.id,
            kind: item.kind,
            owner_id: item.ownerId,
          })),
        )
        .execute();
    }

    /**
     * Расписание генезиса записывается ВМЕСТЕ с миром (I04).
     *
     * До I04 свежий мир расписания не имел, и этой ветки не было — она бы ничего не делала.
     * Нужды его завели: первое пересечение порога планируется при создании мира, потому что
     * событий у него ещё нет. Без записи оно осталось бы только в снимке, и мир никогда не
     * проголодался бы — при этом `world replay` честно закричал бы о расхождении checksum,
     * обвиняя детерминизм в том, что сделала забытая вставка. Так дефект и был найден.
     */
    const scheduled = Object.values(state.scheduledActions);
    if (scheduled.length > 0) {
      await trx
        .insertInto('scheduled_actions')
        .values(
          scheduled.map((action) => ({
            world_id: state.worldId,
            action_id: action.id,
            kind: action.kind,
            due_at: action.dueAt,
            priority: action.priority,
            entity_id: action.entityId,
            route_id: action.kind === 'journey.complete' ? action.routeId : null,
            need: action.kind === 'need.threshold' ? action.need : null,
            to_level: action.kind === 'need.threshold' ? action.toLevel : null,
            lease_owner: null,
            lease_until: null,
            completed_at: null,
          })),
        )
        .execute();
    }
  };

  if (db.isTransaction) {
    await write(db);
    return;
  }
  await db.transaction().execute(async (trx) => {
    await write(trx);
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

  const [agentRows, routeRows, itemRows, actionRows] = await Promise.all([
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
    db.selectFrom('items').selectAll().where('world_id', '=', worldId).orderBy('item_id').execute(),
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
      needBaseline: { hunger: row.hunger_baseline, fatigue: row.fatigue_baseline },
      goal: row.goal,
      planId: row.plan_id,
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

  const items: Record<string, ItemState> = {};
  for (const row of itemRows) {
    items[row.item_id] = {
      id: row.item_id,
      kind: itemKindFromRow(row.kind, row.item_id),
      ownerId: row.owner_id,
    };
  }

  const scheduledActions: Record<string, ScheduledAction> = {};
  for (const row of actionRows) {
    scheduledActions[row.action_id] = scheduledActionFromRow(row);
  }

  return {
    worldId: world.world_id,
    worldVersion: requireSafeInteger(world.version, `worlds.version(${worldId})`),
    worldTime: world.world_time,
    sequence: requireSafeInteger(world.last_sequence, `worlds.last_sequence(${worldId})`),
    agents,
    routes,
    items,
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
  /**
   * Маршруты мира. Добавлены в I03 (M3 независимого аудита) ради ПРАВ, а не ради удобства.
   *
   * Сборщику проекции нужна карта, и раньше он брал маршруты из `loadWorldState` — а тот читает
   * `worlds`, `agents` и `scheduled_actions`, то есть требует прав почти на весь канон. Из-за
   * этого builder ходил под ролью worker-а (INSERT/UPDATE на всё), и матрица least privilege
   * существовала, но никем не исполнялась. Маршруты — такая же статическая часть мира, как
   * локации; читая их отсюда, сборщик обходится SELECT-ом на четыре таблицы.
   */
  readonly routes: readonly {
    readonly id: string;
    readonly fromLocationId: string;
    readonly toLocationId: string;
    readonly travelMinutes: number;
  }[];
  readonly agentNames: Readonly<Record<string, string>>;
}

/**
 * Все три чтения — в ОДНОЙ транзакции (m9 независимого аудита I03, то же правило, что D14).
 *
 * D14 сформулирован без исключений: «чтение, становящееся артефактом, выполняется в одной
 * транзакции». Карта проекции — именно такой артефакт, а собиралась она тремя независимыми
 * запросами. Сегодня гонка теоретическая: локации, маршруты и имена агентов после `world init`
 * не меняются. Но «сегодня не меняется» — это свойство МИРА С ОДНОЙ МЕХАНИКОЙ, а не гарантия
 * кода: I04 приносит предметы и нужды, и первое же изменение состава агентов сделало бы карту
 * склеенной из двух моментов. Исключение, оставленное потому что «пока не стреляет», перестаёт
 * быть заметным ровно тогда, когда начинает.
 *
 * Уровень изоляции тот же, что у `loadWorldState`, и по той же причине: под `read committed`
 * PostgreSQL берёт новый снимок на КАЖДЫЙ оператор, поэтому транзакция без `repeatable read`
 * ничего бы не изменила.
 */
export const loadWorldContent = async (
  db: DatabaseConnection,
  worldId: string,
): Promise<WorldContentSnapshot> =>
  db.isTransaction
    ? await readWorldContent(db, worldId)
    : await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => await readWorldContent(trx, worldId));

const readWorldContent = async (
  db: DatabaseConnection,
  worldId: string,
): Promise<WorldContentSnapshot> => {
  const [locations, routes, agents] = await Promise.all([
    db
      .selectFrom('locations')
      .select(['location_id', 'name', 'description'])
      .where('world_id', '=', worldId)
      .orderBy('location_id')
      .execute(),
    db
      .selectFrom('routes')
      .select(['route_id', 'from_location_id', 'to_location_id', 'travel_minutes'])
      .where('world_id', '=', worldId)
      .orderBy('route_id')
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
    routes: routes.map((row) => ({
      id: row.route_id,
      fromLocationId: row.from_location_id,
      toLocationId: row.to_location_id,
      travelMinutes: requireSafeInteger(
        row.travel_minutes,
        `routes.travel_minutes(${row.route_id})`,
      ),
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
 * Checksum события ПРОВЕРЯЕТСЯ — сверкой с журналом, а не с собственной колонкой.
 *
 * До M2 независимого архитектурного аудита I03 эта строка докстринга была НЕПРАВДОЙ: выполнялся
 * только `decodeWorldEvent(payload)`, то есть проверка ФОРМЫ, а не тождества факту, и колонки
 * checksum в `outbox` нет вовсе. Между тем это ЕДИНСТВЕННЫЙ вход проекции: расхождение здесь
 * означает, что экран показывает не то, что произошло, и узнать об этом неоткуда. ADR-010 §10.2
 * обосновывает выбор `jsonb` для payload именно наличием сверки — без неё обоснование повисало.
 *
 * Колонка checksum в `outbox` НЕ добавлена намеренно. Она хранила бы вторую копию значения,
 * которое уже есть в `world_events`, — и сверка двух копий одной записи ничего не доказывает,
 * если обе испортились вместе. `world_events` append-only и защищён грантами (`INSERT` без
 * `UPDATE`/`DELETE` ни у кого), поэтому именно он — сторона, с которой сверяются, а не ещё одна
 * равноправная копия. Цена — join на каждую пачку; она мала и платится однократно за событие.
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
    .innerJoin('world_events', (join) =>
      join
        .onRef('world_events.event_id', '=', 'outbox.event_id')
        .onRef('world_events.world_id', '=', 'outbox.world_id'),
    )
    .select(['outbox.event_id', 'outbox.sequence', 'outbox.payload', 'world_events.event_checksum'])
    .where('outbox.world_id', '=', worldId)
    .where('outbox.sequence', '>', String(afterSequence))
    .orderBy('outbox.sequence')
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

    // Форма валидна — это ещё не значит, что факт тот же. Сверяем с checksum, снятым при записи
    // в журнал: изменённое поле события даёт другой checksum, и проекция обязана остановиться,
    // а не собрать картину чужого мира.
    const actual = requireChecksum(decoded.value, `outbox(${row.event_id})`);
    if (actual !== row.event_checksum) {
      throw new Error(
        `persistence: строка outbox события ${row.event_id} разошлась с журналом ` +
          `(в журнале ${row.event_checksum}, в outbox ${actual}). Проекция собирается ТОЛЬКО из ` +
          'фактов журнала; расхождение обязано быть сбоем, а не тихо другим фактом на экране.',
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

/**
 * Строка расписания → действие домена, с разбором по виду.
 *
 * Проверка `check` в схеме уже запрещает строку, у которой поля не соответствуют виду (миграция
 * 0014). Здесь она повторена не из недоверия к базе, а потому что колонки объявлены nullable для
 * ВСЕХ строк: без явного отказа `route_id` пришлось бы приводить к строке утверждением, и
 * рассинхронизация схемы с кодом дала бы действие с `undefined` вместо маршрута — то есть тихую
 * порчу канонического состояния вместо названной ошибки.
 */
const scheduledActionFromRow = (row: {
  readonly action_id: string;
  readonly kind:
    | 'journey.complete'
    | 'need.threshold'
    | 'agent.eat'
    | 'rest.complete'
    | 'agent.decide'
    | 'agent.rest';
  readonly due_at: string;
  readonly priority: number;
  readonly entity_id: string;
  readonly route_id: string | null;
  readonly need: string | null;
  readonly to_level: string | null;
  readonly item_id: string | null;
}): ScheduledAction => {
  const base = {
    id: row.action_id,
    dueAt: row.due_at,
    priority: row.priority,
    entityId: row.entity_id,
  };

  if (row.kind === 'journey.complete') {
    if (row.route_id === null) {
      throw new Error(`scheduled_actions.${row.action_id}: завершение пути без маршрута`);
    }
    return { ...base, kind: 'journey.complete', routeId: row.route_id };
  }

  if (row.kind === 'rest.complete') {
    return { ...base, kind: 'rest.complete' };
  }

  if (row.kind === 'agent.decide') {
    return { ...base, kind: 'agent.decide' };
  }

  if (row.kind === 'agent.rest') {
    return { ...base, kind: 'agent.rest' };
  }

  if (row.kind === 'agent.eat') {
    if (row.item_id === null) {
      throw new Error(`scheduled_actions.${row.action_id}: приём пищи без предмета`);
    }
    return { ...base, kind: 'agent.eat', itemId: row.item_id };
  }

  if (row.need === null || row.to_level === null) {
    throw new Error(`scheduled_actions.${row.action_id}: пересечение порога без нужды или уровня`);
  }
  if (!(NEED_KINDS as readonly string[]).includes(row.need)) {
    throw new Error(
      `scheduled_actions.${row.action_id}: неизвестный вид нужды ${JSON.stringify(row.need)}`,
    );
  }
  if (!(NEED_LEVELS as readonly string[]).includes(row.to_level)) {
    throw new Error(
      `scheduled_actions.${row.action_id}: неизвестный уровень ${JSON.stringify(row.to_level)}`,
    );
  }
  return {
    ...base,
    kind: 'need.threshold',
    need: row.need as NeedKind,
    toLevel: row.to_level as NeedLevel,
  };
};

/**
 * «Который час в мире» для того, кто собирается его изменить (I04, миграция 0015).
 *
 * Возвращает отметку горизонта, если шаг мира уже был, иначе текущее мировое время. Второе —
 * честное умолчание, а не догадка: у мира без единого шага горизонт не отличается от времени
 * последнего события.
 */
export const loadObservedWorldTime = async (
  db: DatabaseConnection,
  worldId: string,
): Promise<string | null> => {
  const row = await db
    .selectFrom('worlds')
    .select(['world_time', 'observed_world_time'])
    .where('world_id', '=', worldId)
    .executeTakeFirst();
  if (row === undefined) return null;
  const observed = row.observed_world_time;
  if (observed === null || observed === '') return row.world_time;
  return compareByCodePoint(observed, row.world_time) < 0 ? row.world_time : observed;
};

/** Вид предмета из строки. Неизвестный вид — громкий сбой, а не молчаливое «наверное, еда». */
const itemKindFromRow = (value: string, itemId: string): ItemKind => {
  if ((ITEM_KINDS as readonly string[]).includes(value)) return value as ItemKind;
  throw new Error(
    `items.${itemId}: неизвестный вид ${JSON.stringify(value)}; известны ${ITEM_KINDS.join(', ')}`,
  );
};
