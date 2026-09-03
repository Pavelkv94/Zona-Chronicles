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
  type GoalChosenEvent,
  type GoalKind,
  type PlanPreconditionType,
  type NeedThresholdCrossedEvent,
  type PlanInvalidatedEvent,
  type RestStartedEvent,
  type RiskObservedEvent,
} from '@zona/contracts';
import { chooseGoal, chooseRoute, type GoalSituation, type TravelOption } from './goals.ts';
import type { AgentState } from './state.ts';
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
  | Omit<AgentRestedEvent, 'recorded_at'>
  | Omit<RestStartedEvent, 'recorded_at'>
  | Omit<GoalChosenEvent, 'recorded_at'>
  | Omit<RiskObservedEvent, 'recorded_at'>;

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
    case 'rest.complete':
      return decideRestComplete(state, command, context);
    case 'agent.decide':
      return decideAgentDecide(state, command, context);
    case 'agent.travel':
      return decideAgentTravel(state, command, context);
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

  /**
   * Пройденная дорога СТАНОВИТСЯ ИЗВЕСТНОЙ (I06-B).
   *
   * Здесь канонический риск читается — и это законный путь из мира в знание: агент только что
   * прошёл по этой дороге своими ногами. Утёк, которого итерация не допускает, — это чтение
   * канона при ВЫБОРЕ дороги, а не при её прохождении.
   *
   * Факт не повторяется: узнать уже известное нечего, и лента, повторяющая «узнал то же самое»
   * на каждом проходе, перестала бы быть перечнем произошедшего.
   */
  const alreadyKnown = agent.knownRoutes[route.id] !== undefined;
  if (alreadyKnown) return { kind: 'accepted', events: [event] };

  const observed: Omit<RiskObservedEvent, 'recorded_at'> = {
    ...draftEnvelope(state, command, context, event.world_time, route.toLocationId, 1),
    type: 'risk.observed',
    payload: { route_id: route.id, risk: route.risk },
  };

  return { kind: 'accepted', events: [event, observed] };
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

  const interrupt = emergencyInterrupt(state, command, context, agent, need, toLevel);
  return { kind: 'accepted', events: interrupt === null ? [event] : [event, interrupt] };
}

/**
 * Emergency interrupt (§6): нужда дошла до предела и сорвала чужой план.
 *
 * Условий два, и второе — то, ради которого правило вообще формулируется отдельно.
 *
 * Первое: агент ЗАНЯТ занятием, которое можно прервать. Сегодня это отдых; путь сюда не входит,
 * потому что маршрут выбирает оператор, а не агент, и прерывать чужое намерение мир не вправе.
 *
 * Второе: **прерывает та нужда, которую план НЕ лечит.** Усталость, дошедшая до предела во время
 * отдыха, — это не чрезвычайное происшествие, а ровно то, чем агент занят; прерывать отдых из-за
 * усталости значило бы поднимать спящего, чтобы отправить его спать. Голод во время отдыха —
 * другое дело: план его не лечит и не вылечит.
 */
function emergencyInterrupt(
  state: WorldState,
  command: Command,
  context: DecideContext,
  agent: AgentState,
  need: NeedKind,
  toLevel: NeedLevel,
): Omit<PlanInvalidatedEvent, 'recorded_at'> | null {
  if (toLevel !== 'critical') return null;
  if (agent.status !== 'resting') return null;
  if (GOAL_TREATS_NEED[agent.goal] === need) return null;
  return planFailure(state, command, context, agent, 'agent.not_in_emergency', 1);
}

/**
 * Какую нужду лечит цель. Таблица, а не сравнение с литералом: новая цель обязана назвать свою
 * нужду явно, иначе она молча начнёт прерываться любым пределом.
 */
const GOAL_TREATS_NEED = {
  idle: null,
  eat: 'hunger',
  rest: 'fatigue',
  // Уход лечит не нужду, а место: прервать его пределом голода — законно.
  flee: null,
} as const satisfies Readonly<Record<GoalKind, NeedKind | null>>;

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
 * Срыв плана (I05-C): предусловие шага не выполнено, и агент обязан выбрать заново.
 *
 * Это НЕ отказ. Разница в том, кто подал команду, и мир различает их по СОСТОЯНИЮ, а не по
 * происхождению: у агента, чей шаг сорвался, есть план — цель и её тождество. Внешнее намерение
 * оператора плана за собой не имеет, и для него невыполненное предусловие остаётся обычным
 * доменным отказом.
 *
 * Различие не косметическое. Отказ помечает действие конечным и на этом всё: агент остаётся с
 * целью, которую некому исполнить, до следующего факта, меняющего набор кандидатов. Событие
 * снимает цель, освобождает агента и назначает ему новое решение — то есть чинит мир, а не
 * сообщает о поломке.
 */
function planFailure(
  state: WorldState,
  command: Command,
  context: DecideContext,
  agent: AgentState,
  precondition: PlanPreconditionType,
  sequenceOffset = 0,
): Omit<PlanInvalidatedEvent, 'recorded_at'> | null {
  if (agent.planId === null) return null;
  return {
    ...draftEnvelope(
      state,
      command,
      context,
      toCanonicalIso(context.clock.now()),
      agent.locationId,
      sequenceOffset,
    ),
    type: 'plan.invalidated',
    payload: { plan_id: agent.planId, precondition_type: precondition },
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
  const unavailable =
    item === undefined
      ? `предмета ${command.payload.item_id} в мире нет: он уже израсходован или не существовал`
      : item.ownerId !== command.actor_id
        ? `предмет ${item.id} принадлежит ${item.ownerId}, а не ${command.actor_id}`
        : null;
  if (unavailable !== null) {
    const failure = planFailure(state, command, context, agent, 'item.available_to_actor');
    if (failure !== null) return { kind: 'accepted', events: [failure] };
    return rejected('resource_unavailable', unavailable);
  }
  if (item === undefined) {
    // Недостижимо: `unavailable` уже вернул бы результат. Ветка существует ради сужения типа —
    // молчаливое приведение здесь означало бы утверждение о значении, которого компилятор не
    // проверяет.
    throw new Error('decide: предмет исчез между проверкой и использованием');
  }
  if (!EDIBLE_ITEM_KINDS.includes(item.kind)) {
    const failure = planFailure(state, command, context, agent, 'item.available_to_actor');
    if (failure !== null) return { kind: 'accepted', events: [failure] };
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
 * Лечь отдыхать (I04 → I05).
 *
 * В I04 отдых был мгновенным, и это было названо упрощением. Здесь упрощение снято: команда
 * НАЧИНАЕТ отдых, а снимает усталость отдельный факт `agent.rested`, до которого надо дожить.
 * Форма та же, что у пути, и по той же причине: занятость агента обязана быть состоянием мира,
 * иначе её нечем прервать и незачем оценивать при выборе цели.
 *
 * В пути отдыхать нельзя, и отдыхать во время отдыха тоже: оба случая — попытка начать второе
 * занятие, не закончив первое.
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
    const failure = planFailure(state, command, context, agent, 'agent.is_idle');
    if (failure !== null) return { kind: 'accepted', events: [failure] };
    return rejected(
      'precondition_failed',
      `актор ${command.actor_id} в статусе "${agent.status}": начать отдых можно только свободному`,
    );
  }

  const worldTime = context.clock.now();
  const at = toCanonicalIso(worldTime);
  const expectedEnd = requireAddMinutes(
    worldTime,
    context.ruleset.restMinutes,
    'restMinutes ruleset',
  );

  const started: Omit<RestStartedEvent, 'recorded_at'> = {
    ...draftEnvelope(state, command, context, at, agent.locationId, 0),
    type: 'rest.started',
    payload: { expected_end: toCanonicalIso(expectedEnd) },
  };

  return { kind: 'accepted', events: [started] };
}

/**
 * Отдых закончился (I05).
 *
 * Команду формирует расписание. Отказ здесь — нормальный исход, а не сбой: отдых мог быть
 * прерван, пока действие ждало очереди, и тогда завершать нечего.
 */
function decideRestComplete(
  state: WorldState,
  command: Extract<Command, { type: 'rest.complete' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined) {
    return rejected('actor_not_actionable', `актор ${command.actor_id} неизвестен миру`);
  }
  if (agent.status !== 'resting') {
    return rejected(
      'precondition_failed',
      `актор ${command.actor_id} не отдыхает (статус "${agent.status}"): завершать нечего`,
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

/**
 * Выбор цели (I05, §6).
 *
 * Здесь собирается СИТУАЦИЯ — то, что мир знает об агенте в момент решения, — и передаётся в
 * чистую `chooseGoal`. Разделение не косметическое: арифметика выбора проверяется свойствами на
 * произвольных входах, а сборка ситуации — тем, что она читает состояние, а не выдумывает его.
 *
 * ## Почему решение принимается ВСЕГДА, даже когда цель не изменилась
 *
 * §4.4 плана итерации требовал обратного: публиковать `goal.chosen` только при смене цели, а
 * подтверждение прежней цели отвергать названной причиной, чтобы действие ушло из очереди.
 * Построение показало, что так нельзя, и причина не вкусовая.
 *
 * Отвергнутое запланированное действие остаётся в КАНОНИЧЕСКОМ состоянии навсегда: у отказа нет
 * события, а расписание выводится только из событий. Операционно оно помечено `failed_at` и в
 * очередь не возвращается, но из состояния мира не исчезает. При этом решение обязано снимать
 * ждущие решения того же агента — иначе два факта одного такта дают два решения, и второе
 * принимается по положению, которое первое уже учло. Снять же строку, у которой уже есть
 * конечный исход, база не даёт (`scheduled_actions_single_outcome`), а прочитать её как
 * отсутствующую нельзя: replay о `failed_at` не знает и оставил бы действие на месте —
 * состояние из базы и состояние из журнала разошлись бы молча.
 *
 * Поэтому решение — это ФАКТ, и оно записывается всегда. Заодно оказалось, что так честнее:
 * разбор решения, оставшегося праздным, — единственное место, где видно, ПОЧЕМУ голодающий
 * агент ничего не предпринял. При отказе это объяснение жило бы в тексте отказа, то есть нигде.
 */
function decideAgentDecide(
  state: WorldState,
  command: Extract<Command, { type: 'agent.decide' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined) {
    return rejected('actor_not_actionable', `актор ${command.actor_id} неизвестен миру`);
  }

  const at = toCanonicalIso(context.clock.now());
  const needs = context.ruleset.needs;
  const situation: GoalSituation = {
    currentGoal: agent.goal,
    // Ключи перечислены явно, а не собраны циклом по `NEED_KINDS`: `satisfies` требует ключ на
    // каждый вид нужды, и новый вид не соберётся молча с отсутствующим уровнем.
    needLevels: {
      hunger: needLevelAt(agent.needBaseline.hunger, at, needs.hunger),
      fatigue: needLevelAt(agent.needBaseline.fatigue, at, needs.fatigue),
    } satisfies Readonly<Record<NeedKind, NeedLevel>>,
    hasFood: hasEdibleItem(state, command.actor_id),
    isIdle: agent.status === 'idle',
    restMinutes: context.ruleset.restMinutes,
    locationRisk: state.locations[agent.locationId]?.risk ?? 0,
    travelOptions: travelOptionsFor(state, agent),
  };

  const decision = chooseGoal(situation, context.ruleset.goalWeights, agent.caution);

  const chosen: Omit<GoalChosenEvent, 'recorded_at'> = {
    ...draftEnvelope(state, command, context, at, agent.locationId, 0),
    type: 'goal.chosen',
    payload: { goal: decision.goal, previous_goal: agent.goal, trace: decision.trace },
  };

  return { kind: 'accepted', events: [chosen] };
}

/** Есть ли у агента съедобное. Исполнимость цели «поесть» — свойство мира, а не оценки. */
function hasEdibleItem(state: WorldState, agentId: string): boolean {
  return Object.values(state.items).some(
    (item) => item.ownerId === agentId && EDIBLE_ITEM_KINDS.includes(item.kind),
  );
}

/**
 * Дороги отсюда ГЛАЗАМИ АГЕНТА (I06-C).
 *
 * Единственное место, где субъективность собирается, и потому единственное, где её можно
 * нарушить. Канонический риск дороги сюда не попадает: берётся `knownRoutes`, а незнание
 * остаётся незнанием (`null`), а не превращается в ноль.
 *
 * Читать `route.risk` здесь — это и есть тот утёк, который итерация объявила STOP-условием.
 * Проверяется свойством, а не взглядом: изменение канона неизвестных дорог не меняет выбора.
 */
function travelOptionsFor(state: WorldState, agent: AgentState): readonly TravelOption[] {
  return Object.values(state.routes)
    .filter((route) => route.fromLocationId === agent.locationId)
    .map((route) => ({
      routeId: route.id,
      travelMinutes: route.travelMinutes,
      perceivedRisk: agent.knownRoutes[route.id]?.risk ?? null,
    }))
    .sort((a, b) => (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0));
}

/**
 * Уйти отсюда (I06-C): дорога выбирается ЗДЕСЬ, в момент ухода.
 *
 * Не в момент решения и не расписанием — по самому свежему знанию агента. Между «решил уйти» и
 * «пошёл» он мог узнать больше; выбор, сделанный заранее, был бы выбором по устаревшей карте.
 *
 * Отказ здесь — нормальный исход: агент мог оказаться занят, а дорога — исчезнуть. Если у него
 * при этом есть план, отказ становится его срывом (I05-C), и агент возвращается к решению.
 */
function decideAgentTravel(
  state: WorldState,
  command: Extract<Command, { type: 'agent.travel' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined) {
    return rejected('actor_not_actionable', `актор ${command.actor_id} неизвестен миру`);
  }
  if (agent.status !== 'idle') {
    const failure = planFailure(state, command, context, agent, 'agent.is_idle');
    if (failure !== null) return { kind: 'accepted', events: [failure] };
    return rejected(
      'precondition_failed',
      `актор ${command.actor_id} в статусе "${agent.status}": выйти в путь можно только свободному`,
    );
  }

  const chosen = chooseRoute(
    travelOptionsFor(state, agent),
    context.ruleset.goalWeights,
    agent.caution,
  );
  if (chosen === null) {
    const failure = planFailure(state, command, context, agent, 'route.available_from_location');
    if (failure !== null) return { kind: 'accepted', events: [failure] };
    return rejected('route_unavailable', `из локации ${agent.locationId} не ведёт ни одна дорога`);
  }

  const route = state.routes[chosen.routeId];
  if (route === undefined) {
    throw new Error(`decide: выбранная дорога ${chosen.routeId} исчезла между отбором и выходом`);
  }

  const worldTime = context.clock.now();
  const expectedArrival = requireAddMinutes(
    worldTime,
    route.travelMinutes,
    `travelMinutes маршрута ${route.id}`,
  );

  const started: Omit<JourneyStartedEvent, 'recorded_at'> = {
    ...draftEnvelope(state, command, context, toCanonicalIso(worldTime), agent.locationId, 0),
    type: 'journey.started',
    payload: { route_id: route.id, expected_arrival: toCanonicalIso(expectedArrival) },
  };

  return { kind: 'accepted', events: [started] };
}
