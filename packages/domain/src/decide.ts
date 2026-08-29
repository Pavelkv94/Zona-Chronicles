/**
 * `decide(state, command, context) -> events | typed rejection` — первый slice (§11):
 * `journey.start` → `journey.started`. `journey.completed` и `plan.invalidated` уже описаны в
 * `@zona/contracts`, но их порождение требует scheduled action (I02A/I02B) и здесь не
 * реализуется (§5 плана итерации, "out of scope").
 *
 * `context` содержит только явные зависимости — мировое время, PRNG, версии правил и id factory
 * (ADR-003) — и ничего сверх этого: домен не читает `process`, часы или сеть напрямую (A6).
 *
 * Ожидаемые отказы — типизированный `DecideRejection` из замороженного перечисления
 * `CommandRejectionCode` (`@zona/contracts`), а не брошенное исключение: команда — обычный
 * вход, отказ по домену — обычный, ожидаемый результат (`09_EVENT_AND_COMMAND_CONTRACTS` §2).
 */
import {
  RUNTIME_ID_PREFIXES,
  isInstantError,
  parseCanonicalInstant,
  requireAddMinutes,
  type Command,
  type CommandRejectionCode,
  type Instant,
  type ItemKind,
  type NeedKind,
  type NeedLevel,
  type JourneyCompletedEvent,
  type JourneyStartedEvent,
  type AgentAteEvent,
  type AgentRestedEvent,
  type NeedThresholdCrossedEvent,
  type PlanInvalidatedEvent,
} from '@zona/contracts';
import { betterThan, needLevelAt, nextThresholdCrossing } from './needs.ts';
import type { Clock } from './ports/clock.ts';
import type { IdFactory } from './ports/id-factory.ts';
import type { RandomSource } from './ports/random-source.ts';
import type { Ruleset } from './ports/ruleset.ts';
import type { WorldState } from './state.ts';

/**
 * Виды предметов, которые можно съесть. СПИСОК, а не сравнение с литералом `'food'`.
 *
 * Разница появляется при добавлении второго вида: сравнение `kind !== 'food'` при единственном
 * известном виде сужается до `never`, и правило превращается в мёртвый код, который линтер
 * справедливо отвергает. Список остаётся живой проверкой при любом числе видов, и новый вид по
 * умолчанию НЕсъедобен — безопасное направление ошибки.
 */
const EDIBLE_ITEM_KINDS: readonly ItemKind[] = ['food'];

export interface DecideContext {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly ids: IdFactory;
  readonly ruleset: Ruleset;
}

export interface DecideRejection {
  readonly code: CommandRejectionCode;
  readonly message: string;
}

/**
 * Факт, ещё не помеченный операционным `recorded_at`: домен его не знает (SIM-01, комментарий
 * `world-event.ts` — "recorded_at… не участвует в доменной логике"). Слой, который проставляет
 * `recorded_at` при записи факта (реальный wall clock), — адаптер персистентности (I02A), вне
 * домена; здесь событие остаётся "черновиком" до этого шага.
 *
 * Явное перечисление вариантов, а не `Omit<WorldEvent, 'recorded_at'>`: встроенный `Omit`
 * применяется к `keyof (A|B|C)`, а не к каждому варианту union по отдельности, и «плющит»
 * дискриминированный union в `payload`, который перестаёт сужаться по `type`.
 */
export type DraftWorldEvent =
  | Omit<JourneyStartedEvent, 'recorded_at'>
  | Omit<JourneyCompletedEvent, 'recorded_at'>
  | Omit<PlanInvalidatedEvent, 'recorded_at'>
  | Omit<NeedThresholdCrossedEvent, 'recorded_at'>
  | Omit<AgentAteEvent, 'recorded_at'>
  | Omit<AgentRestedEvent, 'recorded_at'>;

export type DecideResult =
  | { readonly kind: 'accepted'; readonly events: readonly DraftWorldEvent[] }
  | { readonly kind: 'rejected'; readonly rejection: DecideRejection };

/**
 * Проверка optimistic concurrency, выполняемая ТОЛЬКО когда команда её запросила (ADR-011).
 *
 * Отсутствие `expected_world_version` — это не «версия ноль», а «проверять нечего»: так
 * помечают команду, выведенную из уже принятого факта мира. Сериализацию для неё обеспечивает
 * замок мира в адаптере персистентности, а не сравнение версий.
 */
function checkExpectedVersion(state: WorldState, command: Command): DecideResult | null {
  if (command.expected_world_version === undefined) return null;
  if (command.expected_world_version === state.worldVersion) return null;
  return rejected(
    'stale_world_version',
    `команда ожидала версию мира ${command.expected_world_version}, текущая версия ${state.worldVersion}`,
  );
}

function rejected(code: CommandRejectionCode, message: string): DecideResult {
  return { kind: 'rejected', rejection: { code, message } };
}

/**
 * Момент, инъектированный `Clock`/полученный из `addMinutes`, приводится к КАНОНИЧЕСКОЙ форме
 * (`…T18:20:00.000Z`) перед тем, как попасть в событие: `Clock.now()` обязан отдавать валидный
 * `Instant`, но не обязан отдавать канонический текст, а SIM-01/A3 требуют, чтобы один и тот же
 * момент давал один и тот же checksum независимо от смещения или числа знаков дробной части
 * источника (тот же довод, что в `world-event.ts`/`change request A4`).
 */
function toCanonicalIso(instant: Instant): string {
  const canonical = parseCanonicalInstant(instant.iso);
  if (isInstantError(canonical)) {
    throw new Error(`decide: момент из Clock/addMinutes невалиден: ${canonical.error}`);
  }
  return canonical.iso;
}

export function decide(state: WorldState, command: Command, context: DecideContext): DecideResult {
  switch (command.type) {
    case 'journey.start':
      return decideJourneyStart(state, command, context);
    case 'journey.complete':
      return decideJourneyComplete(state, command, context);
    case 'need.threshold.cross':
      return decideNeedThresholdCross(state, command, context);
    case 'agent.eat':
      return decideAgentEat(state, command, context);
    case 'agent.rest':
      return decideAgentRest(state, command, context);
    default:
      return assertNeverCommand(command);
  }
}

/**
 * Завершение пути (I02B).
 *
 * Идёт тем же путём, что внешняя команда, и это решение, а не удобство: у мира должен быть
 * ОДИН способ измениться. Отдельная ветка «домен для scheduled actions» дала бы второй, со
 * своими правилами и своими отказами, и расхождение между ними было бы невидимым.
 *
 * Отказы здесь — обычные доменные отказы, а не ошибки scheduler-а: due action мог устареть,
 * пока ждал своей очереди (агент уже завершил путь другим способом, маршрут изменился), и это
 * нормальный исход, который обязан быть записан, а не брошен.
 */
function decideJourneyComplete(
  state: WorldState,
  command: Extract<Command, { type: 'journey.complete' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined) {
    return rejected('actor_not_actionable', `актор ${command.actor_id} неизвестен миру`);
  }
  if (agent.status !== 'traveling' || agent.routeId !== command.payload.route_id) {
    return rejected(
      'precondition_failed',
      agent.status !== 'traveling'
        ? `актор ${command.actor_id} не в пути (статус "${agent.status}")`
        : `актор ${command.actor_id} идёт по маршруту ${String(agent.routeId)}, а не по ` +
            `${command.payload.route_id}`,
    );
  }

  const route = state.routes[command.payload.route_id];
  if (route === undefined) {
    return rejected('route_unavailable', `маршрут ${command.payload.route_id} неизвестен миру`);
  }

  const worldTime = context.clock.now();
  const versions = context.ruleset.versions;

  const event: Omit<JourneyCompletedEvent, 'recorded_at'> = {
    event_id: context.ids.next(RUNTIME_ID_PREFIXES.event),
    world_id: state.worldId,
    sequence: state.sequence + 1,
    world_time: toCanonicalIso(worldTime),
    type: 'journey.completed',
    schema_version: versions.schemaVersion,
    rules_version: versions.rulesVersion,
    content_version: versions.contentVersion,
    actor_ids: [command.actor_id],
    subject_ids: [],
    location_id: route.toLocationId,
    correlation_id: command.correlation_id,
    caused_by: command.caused_by_event_id === undefined ? [] : [command.caused_by_event_id],
    command_id: command.command_id,
    random_audit: null,
    payload: { route_id: route.id },
  };

  return { kind: 'accepted', events: [event] };
}

/**
 * Исчерпывающая обработка типов команд проверяется КОМПИЛЯТОРОМ (тот же приём, что в `evolve`):
 * новый тип команды без ветки здесь не сузится до `never`, и `pnpm typecheck` упадёт раньше,
 * чем код дойдёт до review.
 */
function assertNeverCommand(command: never): never {
  throw new Error(`decide: необработанный тип команды ${JSON.stringify(command)}`);
}

function decideJourneyStart(
  state: WorldState,
  command: Extract<Command, { type: 'journey.start' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined || agent.status !== 'idle') {
    return rejected(
      'actor_not_actionable',
      agent === undefined
        ? `актор ${command.actor_id} неизвестен миру`
        : `актор ${command.actor_id} уже в статусе "${agent.status}", не idle`,
    );
  }

  const route = state.routes[command.payload.route_id];
  if (route === undefined || route.fromLocationId !== agent.locationId) {
    return rejected(
      'route_unavailable',
      route === undefined
        ? `маршрут ${command.payload.route_id} неизвестен миру`
        : `маршрут ${command.payload.route_id} не начинается в текущей локации актора ` +
            `(${agent.locationId}, маршрут начинается в ${route.fromLocationId})`,
    );
  }

  const worldTime = context.clock.now();
  // `requireAddMinutes`, а не `addMinutes`: с M1 сдвиг возвращает `Instant | InstantError`, а
  // нецелое `travelMinutes` из контента обязано быть громким отказом, а не тихим округлением.
  // Обработать его здесь нечем — это дефект bundle-а, не отказ по доменному правилу.
  const expectedArrival = requireAddMinutes(
    worldTime,
    route.travelMinutes,
    `travelMinutes маршрута ${route.id}`,
  );
  const versions = context.ruleset.versions;

  const event: Omit<JourneyStartedEvent, 'recorded_at'> = {
    event_id: context.ids.next(RUNTIME_ID_PREFIXES.event),
    world_id: state.worldId,
    sequence: state.sequence + 1,
    world_time: toCanonicalIso(worldTime),
    type: 'journey.started',
    schema_version: versions.schemaVersion,
    rules_version: versions.rulesVersion,
    content_version: versions.contentVersion,
    actor_ids: [command.actor_id],
    subject_ids: [],
    location_id: agent.locationId,
    correlation_id: command.correlation_id,
    caused_by: [],
    command_id: command.command_id,
    random_audit: null,
    payload: {
      route_id: route.id,
      expected_arrival: toCanonicalIso(expectedArrival),
    },
  };

  return { kind: 'accepted', events: [event] };
}

/**
 * Пересечение порога нужды (I04).
 *
 * Команду формирует расписание, а не человек, и она проходит тем же путём, что `journey.complete`
 * — у мира один способ измениться.
 *
 * Уровень вычисляется ЗАНОВО и сверяется с ожиданием из payload. Это не перестраховка: действие
 * могло ждать своей очереди, пока агент ел, и тогда запланированное пересечение попросту не
 * состоялось. Без сверки мир опубликовал бы факт «проголодался» о сытом агенте, и опроверг бы
 * этот факт только собственным состоянием, которое летопись не читает.
 */
function decideNeedThresholdCross(
  state: WorldState,
  command: Extract<Command, { type: 'need.threshold.cross' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined) {
    return rejected('actor_not_actionable', `актор ${command.actor_id} неизвестен миру`);
  }

  const { need, to_level: toLevel } = command.payload;
  const config = context.ruleset.needs[need];
  const baseline = agent.needBaseline[need];
  const worldTime = context.clock.now();
  const at = toCanonicalIso(worldTime);

  const actual = needLevelAt(baseline, at, config);
  if (actual !== toLevel) {
    return rejected(
      'precondition_failed',
      `нужда "${need}" актора ${command.actor_id} на момент ${at} имеет уровень "${actual}", ` +
        `а действие планировалось на "${toLevel}"`,
    );
  }

  const fromLevel = betterThan(toLevel);
  if (fromLevel === null) {
    return rejected(
      'precondition_failed',
      `уровень "${toLevel}" нужды "${need}" не имеет предшествующего: пересечение в него ` +
        'невозможно, а факт о переходе был бы неверен',
    );
  }

  const next = nextThresholdCrossing(baseline, toLevel, config);
  const versions = context.ruleset.versions;

  const event: Omit<NeedThresholdCrossedEvent, 'recorded_at'> = {
    event_id: context.ids.next(RUNTIME_ID_PREFIXES.event),
    world_id: state.worldId,
    sequence: state.sequence + 1,
    world_time: at,
    type: 'need.threshold.crossed',
    schema_version: versions.schemaVersion,
    rules_version: versions.rulesVersion,
    content_version: versions.contentVersion,
    actor_ids: [command.actor_id],
    subject_ids: [],
    location_id: agent.locationId,
    correlation_id: command.correlation_id,
    caused_by: command.caused_by_event_id === undefined ? [] : [command.caused_by_event_id],
    command_id: command.command_id,
    random_audit: null,
    payload: {
      need,
      from_level: fromLevel,
      to_level: toLevel,
      next_threshold_at: next === null ? null : next.at,
    },
  };

  return { kind: 'accepted', events: [event] };
}

/**
 * Общая часть envelope события, порождённого командой. Собирается один раз: три ветки,
 * переписывающие одиннадцать полей вручную, разошлись бы на двенадцатом.
 */
function draftEnvelope(
  state: WorldState,
  command: Command,
  context: DecideContext,
  at: string,
  locationId: string,
  sequenceOffset: number,
): Omit<NeedThresholdCrossedEvent, 'recorded_at' | 'type' | 'payload'> {
  const versions = context.ruleset.versions;
  return {
    event_id: context.ids.next(RUNTIME_ID_PREFIXES.event),
    world_id: state.worldId,
    sequence: state.sequence + 1 + sequenceOffset,
    world_time: at,
    schema_version: versions.schemaVersion,
    rules_version: versions.rulesVersion,
    content_version: versions.contentVersion,
    actor_ids: [command.actor_id],
    subject_ids: [],
    location_id: locationId,
    correlation_id: command.correlation_id,
    caused_by: command.caused_by_event_id === undefined ? [] : [command.caused_by_event_id],
    command_id: command.command_id,
    random_audit: null,
  };
}

/**
 * Восстановление нужды: событие перехода в `normal` (I04).
 *
 * Восстановление выражается ТЕМ ЖЕ фактом, что ухудшение, и это решение. Отдельное событие
 * «стало лучше» означало бы два представления одного перехода, и потребителю ленты пришлось бы
 * уметь оба, а инвариант «уровень меняется ⇒ ровно одно событие» перестал бы быть проверяемым
 * одним запросом.
 */
function recoveryEvent(
  state: WorldState,
  command: Command,
  context: DecideContext,
  input: {
    readonly need: NeedKind;
    readonly fromLevel: NeedLevel;
    readonly at: string;
    readonly locationId: string;
    readonly nextAt: string | null;
  },
): Omit<NeedThresholdCrossedEvent, 'recorded_at'> {
  return {
    ...draftEnvelope(state, command, context, input.at, input.locationId, 1),
    type: 'need.threshold.crossed',
    payload: {
      need: input.need,
      from_level: input.fromLevel,
      to_level: 'normal',
      next_threshold_at: input.nextAt,
    },
  };
}

/**
 * Съесть предмет (I04).
 *
 * Отказы названы по причинам, а не сведены к одному «нельзя»: команда приходит от мира по
 * достигнутому порогу, и различие между «предмета нет», «предмет чужой» и «это не еда» — это
 * различие между дефектом планирования, гонкой и ошибкой контента.
 *
 * Проверки голода ЗДЕСЬ НЕТ намеренно. Есть можно и не будучи голодным; правило «когда есть» —
 * это политика планирования (`evolve`), а не предусловие действия. Предусловием сделать её
 * нельзя: съеденное на границе уровня действие отвергалось бы из-за одной минуты, и запас еды
 * оставался бы нетронутым у голодающего агента.
 */
function decideAgentEat(
  state: WorldState,
  command: Extract<Command, { type: 'agent.eat' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined) {
    return rejected('actor_not_actionable', `актор ${command.actor_id} неизвестен миру`);
  }

  const item = state.items[command.payload.item_id];
  if (item === undefined) {
    return rejected(
      'resource_unavailable',
      `предмета ${command.payload.item_id} в мире нет: он уже израсходован или не существовал`,
    );
  }
  if (item.ownerId !== command.actor_id) {
    return rejected(
      'resource_unavailable',
      `предмет ${item.id} принадлежит ${item.ownerId}, а не ${command.actor_id}`,
    );
  }
  if (!EDIBLE_ITEM_KINDS.includes(item.kind)) {
    return rejected('precondition_failed', `предмет ${item.id} не еда (вид "${item.kind}")`);
  }

  const at = toCanonicalIso(context.clock.now());
  const config = context.ruleset.needs.hunger;
  const fromLevel = needLevelAt(agent.needBaseline.hunger, at, config);
  // Следующий порог отсчитывается от МОМЕНТА ЕДЫ: голод обнулён, и всё, что было до, к нему
  // отношения не имеет.
  const next = nextThresholdCrossing(at, 'normal', config);

  const ate: Omit<AgentAteEvent, 'recorded_at'> = {
    ...draftEnvelope(state, command, context, at, agent.locationId, 0),
    type: 'agent.ate',
    payload: { item_id: item.id },
  };

  // Перехода может и не быть: сытый агент, съевший ещё одну банку, ничего не пересекает, и
  // факт о переходе был бы неверен.
  if (fromLevel === 'normal') {
    return { kind: 'accepted', events: [ate] };
  }

  return {
    kind: 'accepted',
    events: [
      ate,
      recoveryEvent(state, command, context, {
        need: 'hunger',
        fromLevel,
        at,
        locationId: agent.locationId,
        nextAt: next === null ? null : next.at,
      }),
    ],
  };
}

/**
 * Отдохнуть (I04).
 *
 * Отдых мгновенен, и это НАЗВАННОЕ упрощение, а не модель: длительность сна и его прерывание —
 * правила тела, то есть I07. Здесь важно другое — что усталость снимается фактом, записанным в
 * журнал, а не молчаливым обнулением поля.
 *
 * В пути отдыхать нельзя: агент, отдыхающий на маршруте, — это уже сцена с местом и временем,
 * а сцен в этой итерации нет.
 */
function decideAgentRest(
  state: WorldState,
  command: Extract<Command, { type: 'agent.rest' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined) {
    return rejected('actor_not_actionable', `актор ${command.actor_id} неизвестен миру`);
  }
  if (agent.status !== 'idle') {
    return rejected(
      'precondition_failed',
      `актор ${command.actor_id} в статусе "${agent.status}": отдыхать в пути нельзя`,
    );
  }

  const at = toCanonicalIso(context.clock.now());
  const config = context.ruleset.needs.fatigue;
  const fromLevel = needLevelAt(agent.needBaseline.fatigue, at, config);
  const next = nextThresholdCrossing(at, 'normal', config);

  const rested: Omit<AgentRestedEvent, 'recorded_at'> = {
    ...draftEnvelope(state, command, context, at, agent.locationId, 0),
    type: 'agent.rested',
    payload: {},
  };

  if (fromLevel === 'normal') {
    return { kind: 'accepted', events: [rested] };
  }

  return {
    kind: 'accepted',
    events: [
      rested,
      recoveryEvent(state, command, context, {
        need: 'fatigue',
        fromLevel,
        at,
        locationId: agent.locationId,
        nextAt: next === null ? null : next.at,
      }),
    ],
  };
}
