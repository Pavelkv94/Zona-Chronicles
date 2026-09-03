/**
 * `evolve(state, event) -> state` (A8).
 *
 * Исчерпывающая обработка типов событий проверяется КОМПИЛЯТОРОМ, а не тестом:
 * `assertNeverWorldEvent` из `@zona/contracts` принимает только `never`. Если добавить тип
 * события без ветки здесь, `event` в последней ветке `switch` не сузится до `never`, и вызов
 * `assertNeverWorldEvent(event)` перестанет компилироваться — `pnpm typecheck` упадёт с
 * `error TS2345` раньше, чем код дойдёт до review (точный вывод пробы — в handoff задачи).
 *
 * `event.recorded_at` нигде не читается: это операционный wall clock, не участвующий в
 * доменной логике и replay (§3 контракта, комментарий `world-event.ts`).
 */
import { type WorldEvent, assertNeverWorldEvent } from '@zona/contracts';
import {
  SCHEDULED_ACTION_PRIORITY,
  agentDecideActionId,
  agentEatActionId,
  agentRestActionId,
  agentTravelActionId,
  isAgentFree,
  needThresholdActionId,
  planIdFor,
  type AgentDecideAction,
  type AgentEatAction,
  type AgentRestAction,
  type AgentTravelAction,
  type ItemState,
  type NeedThresholdAction,
  type RestCompleteAction,
  type ScheduledAction,
  type WorldState,
} from './state.ts';

export function evolve(state: WorldState, event: WorldEvent): WorldState {
  const bumped: WorldState = {
    ...state,
    // I01 упрощение: одна команда этого slice порождает ровно одно событие, поэтому один
    // применённый event == один шаг optimistic-concurrency версии мира. Настоящая семантика
    // "одна transaction/batch команды -> одно приращение world_version" (§5) — за пределами
    // домена (I02A, транзакционная граница персистентности), где batch с несколькими событиями
    // впервые появится.
    worldVersion: state.worldVersion + 1,
    worldTime: event.world_time,
    sequence: event.sequence,
  };

  switch (event.type) {
    case 'journey.started':
      return applyJourneyStarted(bumped, event);
    case 'journey.completed':
      return applyJourneyCompleted(bumped, event);
    case 'need.threshold.crossed':
      return applyNeedThresholdCrossed(bumped, event);
    case 'agent.ate':
      return applyAgentAte(bumped, event);
    case 'agent.rested':
      return applyAgentRested(bumped, event);
    case 'rest.started':
      return applyRestStarted(bumped, event);
    case 'goal.chosen':
      return applyGoalChosen(bumped, event);
    case 'risk.observed':
      return applyRiskObserved(bumped, event);
    case 'plan.invalidated':
      return applyPlanInvalidated(bumped, event);
    default:
      return assertNeverWorldEvent(event);
  }
}

function requireSingleActorId(event: { readonly actor_ids: readonly string[] }): string {
  const [actorId, ...rest] = event.actor_ids;
  if (actorId === undefined || rest.length > 0) {
    throw new Error(
      `evolve: ожидался ровно один actor_id, получено ${event.actor_ids.length} ` +
        `(${JSON.stringify(event.actor_ids)})`,
    );
  }
  return actorId;
}

function applyJourneyStarted(
  state: WorldState,
  event: Extract<WorldEvent, { type: 'journey.started' }>,
): WorldState {
  const actorId = requireSingleActorId(event);
  const agent = state.agents[actorId];
  if (agent === undefined) {
    // Событие уже принято и записано; отсутствие актора здесь — нарушение причинности
    // (`decide` не мог породить это событие для несуществующего актора), а не ожидаемый
    // доменный отказ. Громкий сбой вместо тихой порчи состояния.
    throw new Error(`evolve: journey.started ссылается на неизвестного актора ${actorId}`);
  }
  // Начатый путь ОБЯЗАН завершиться, и это доменное знание, а не операционная деталь: поэтому
  // расписание выводится здесь, из события, а не наполняется адаптером персистентности. Тогда
  // пересимуляция журнала восстанавливает его бесплатно (см. `ScheduledAction` в `state.ts`).
  const action: ScheduledAction = {
    id: event.event_id,
    kind: 'journey.complete',
    dueAt: event.payload.expected_arrival,
    priority: SCHEDULED_ACTION_PRIORITY['journey.complete'],
    entityId: actorId,
    routeId: event.payload.route_id,
  };

  // Исполненный шаг «уйти» снимается по признаку действия — как приём пищи и укладывание: у
  // агента не бывает двух ждущих выходов. У пути, начатого оператором, снимать нечего.
  const remaining: Record<string, ScheduledAction> = {};
  for (const [id, other] of Object.entries(state.scheduledActions)) {
    if (other.kind === 'agent.travel' && other.entityId === actorId) continue;
    remaining[id] = other;
  }
  remaining[action.id] = action;

  return {
    ...state,
    agents: {
      ...state.agents,
      [actorId]: { ...agent, status: 'traveling', routeId: event.payload.route_id },
    },
    scheduledActions: remaining,
  };
}

function applyJourneyCompleted(
  state: WorldState,
  event: Extract<WorldEvent, { type: 'journey.completed' }>,
): WorldState {
  const actorId = requireSingleActorId(event);
  const agent = state.agents[actorId];
  if (agent === undefined) {
    throw new Error(`evolve: journey.completed ссылается на неизвестного актора ${actorId}`);
  }
  const route = state.routes[event.payload.route_id];
  if (route === undefined) {
    throw new Error(
      `evolve: journey.completed ссылается на неизвестный маршрут ${event.payload.route_id}`,
    );
  }
  // Выполненное действие уходит из расписания — снимается ПО ID ПРИЧИНЫ, а не по совпадению
  // полей (M7 независимого архитектурного аудита I02B).
  //
  // Прежняя редакция фильтровала по паре `(entityId, routeId)`, и это работало ровно потому,
  // что механика одна: `decide` не даёт агенту начать второй путь. Как только появится вторая
  // механика, планирующая для той же пары — патруль, повторный проход, «прибыть и отдохнуть»,
  // — `journey.completed` снял бы ЧУЖОЕ действие, и расписание разошлось бы с журналом молча.
  // Заметно это стало бы только при `world replay`, то есть сильно позже причины.
  //
  // `caused_by` события завершения содержит `event_id` события-начала, а `id` действия равен
  // именно ему (см. `ScheduledAction` в `state.ts`) — связь прямая и не зависит от того,
  // сколько механик планируют для одной сущности.
  const causedByIds = new Set(event.caused_by);
  const remaining = Object.fromEntries(
    Object.entries(state.scheduledActions).filter(([id, action]) => {
      if (causedByIds.has(id)) return false;
      // Совместимость с событиями, записанными до M7: у них `caused_by` пуст, и единственный
      // доступный признак — пара «актор + маршрут». Журнал невосполним, поэтому старые факты
      // обязаны продолжать применяться так, как их записали.
      return !(
        causedByIds.size === 0 &&
        action.kind === 'journey.complete' &&
        action.entityId === actorId &&
        action.routeId === route.id
      );
    }),
  );

  return withDecisionScheduled(
    {
      ...state,
      agents: {
        ...state.agents,
        [actorId]: {
          ...agent,
          status: 'idle',
          routeId: null,
          locationId: route.toLocationId,
          // Дошёл — значит, ушёл: цель «уйти» достигнута прибытием и снимается, как всякая
          // достигнутая цель. У пути, начатого оператором, цель и так праздная, и снятие
          // ничего не меняет.
          goal: 'idle',
          planId: null,
        },
      },
      scheduledActions: remaining,
    },
    actorId,
    event,
  );
}

/**
 * Пересечение порога нужды (I04).
 *
 * Момент отсчёта нужды НЕ меняется: агент не поел, он просто дольше не ел. Меняется расписание —
 * выполненное пересечение уходит, следующее появляется, если оно есть.
 *
 * Следующий момент берётся ИЗ СОБЫТИЯ, а не вычисляется здесь, и это не лень: `evolve` — чистая
 * функция от журнала, у неё нет доступа к коэффициентам ruleset (ADR-003), а вычислять их
 * вторым способом означало бы завести второй источник правды, способный разойтись с журналом
 * молча. Тот же приём и то же основание, что у `expected_arrival` в `journey.started`.
 *
 * Ждущее действие снимается по КЛЮЧУ, восстановленному из самого события: ключ содержит агента,
 * нужду и момент срабатывания, а момент срабатывания — это `world_time` факта. Совпадений тут
 * быть не может: два разных пересечения одной нужды одного агента в один и тот же момент — это
 * одно и то же пересечение.
 */
function applyNeedThresholdCrossed(
  state: WorldState,
  event: Extract<WorldEvent, { type: 'need.threshold.crossed' }>,
): WorldState {
  const actorId = requireSingleActorId(event);
  const agent = state.agents[actorId];
  if (agent === undefined) {
    throw new Error(`evolve: need.threshold.crossed ссылается на неизвестного актора ${actorId}`);
  }

  const { need, next_threshold_at: nextAt, to_level: toLevel } = event.payload;
  const firedId = needThresholdActionId(actorId, need, event.world_time);

  /**
   * Снимается НЕ только сработавшее пересечение, но и любое другое ждущее по этой же нужде.
   *
   * Инвариант, который здесь поддерживается: у агента по одной нужде не больше одного ждущего
   * пересечения. Он нужен обоим направлениям перехода. При ухудшении лишних действий и не
   * бывает; при восстановлении — бывают всегда: агент, отдохнувший на уровне `warning`, оставил
   * бы ждать пересечение в `critical`, посчитанное от СТАРОГО момента отсчёта. Оно сработало бы
   * позже, `decide` отверг бы его как устаревшее, и мир записал бы отказ на действие, которое
   * никто не планировал исполнять.
   *
   * Это не «совпадение полей» из M7: там пара «агент + маршрут» была эвристикой, верной лишь
   * пока механика одна. Здесь снимается ровно то, что заменяется, и заменяется ровно то, что
   * снято, — инвариант проверяется тестом, а не подразумевается.
   */
  const remaining: Record<string, ScheduledAction> = {};
  for (const [id, action] of Object.entries(state.scheduledActions)) {
    if (id === firedId) continue;
    if (action.kind === 'need.threshold' && action.entityId === actorId && action.need === need) {
      continue;
    }
    remaining[id] = action;
  }

  if (nextAt !== null) {
    const next: NeedThresholdAction = {
      id: needThresholdActionId(actorId, need, nextAt),
      kind: 'need.threshold',
      dueAt: nextAt,
      priority: SCHEDULED_ACTION_PRIORITY['need.threshold'],
      entityId: actorId,
      need,
      toLevel: nextLevelAfter(toLevel),
    };
    remaining[next.id] = next;
  }

  // Изменившаяся нужда — повод принять решение, и повод возникает у ЛЮБОГО перехода, включая
  // восстановление: агент, переставший быть голодным, мог до этого выбрать «поесть» и теперь
  // свободен для другого. Решение планируется только свободному — занятый доводит начатое до
  // конца, а прерывание плана по чрезвычайной нужде вводится вместе со своим событием
  // `plan.invalidated` (следующий срез).
  return withDecisionScheduled({ ...state, scheduledActions: remaining }, actorId, event);
}

/**
 * Уровень, до которого дорастёт нужда к следующему порогу.
 *
 * Живёт здесь, а не в `needs.ts`, потому что это прочтение ЖУРНАЛА, а не правило: цепочка
 * порогов строго последовательна, поэтому следующий уровень известен из достигнутого. Событие с
 * непустым `next_threshold_at` при крайнем уровне — противоречие внутри самого факта, и оно
 * обязано быть громким: молча оно дало бы действие, которое `decide` затем вечно отвергает.
 */
function nextLevelAfter(level: 'normal' | 'warning' | 'critical'): 'warning' | 'critical' {
  if (level === 'normal') return 'warning';
  if (level === 'warning') return 'critical';
  throw new Error(
    'evolve: need.threshold.crossed достиг крайнего уровня, но обещает следующий порог',
  );
}

/**
 * Съеденный предмет исчезает из мира (I04).
 *
 * Сток выражен УДАЛЕНИЕМ из состояния, а не флагом «съеден»: предмет, помеченный съеденным, всё
 * ещё существует и всё ещё может быть выбран вторым действием. Свойство «нельзя потратить
 * дважды» тогда держалось бы на дисциплине каждого потребителя, а не на форме состояния.
 *
 * Момент отсчёта голода переставляется на время события — с этого мгновения голод считается
 * заново.
 */
function applyAgentAte(
  state: WorldState,
  event: Extract<WorldEvent, { type: 'agent.ate' }>,
): WorldState {
  const actorId = requireSingleActorId(event);
  const agent = state.agents[actorId];
  if (agent === undefined) {
    throw new Error(`evolve: agent.ate ссылается на неизвестного актора ${actorId}`);
  }
  const item = state.items[event.payload.item_id];
  if (item === undefined) {
    // Событие уже записано; отсутствие предмета здесь означает, что тот же предмет съеден
    // дважды, — нарушение причинности, а не ожидаемый исход. Громкий сбой вместо тихой порчи.
    throw new Error(
      `evolve: agent.ate ссылается на несуществующий предмет ${event.payload.item_id}`,
    );
  }

  const remainingItems: Record<string, ItemState> = {};
  for (const [id, other] of Object.entries(state.items)) {
    if (id === item.id) continue;
    remainingItems[id] = other;
  }

  // Выполненный шаг уходит из расписания. Снимается он по ПРИЗНАКУ ДЕЙСТВИЯ — тот же агент,
  // тот же предмет, — а не по восстановленному ключу: ключ выводится из `event_id` факта,
  // назначившего шаг, а команда, выведенная из расписания, id своей причины не несёт (см.
  // `commandFor` в scheduler-е). Совпадений здесь быть не может: съесть один предмет дважды
  // нельзя, и второго ждущего действия с этим предметом не существует.
  const remainingActions: Record<string, ScheduledAction> = {};
  for (const [id, action] of Object.entries(state.scheduledActions)) {
    if (action.kind === 'agent.eat' && action.entityId === actorId && action.itemId === item.id) {
      continue;
    }
    remainingActions[id] = action;
  }

  return withDecisionScheduled(
    {
      ...state,
      items: remainingItems,
      scheduledActions: remainingActions,
      agents: {
        ...state.agents,
        [actorId]: {
          ...agent,
          // Цель достигнута и потому снята: агент не «передумал», он доел. Держать цель дальше
          // значило бы утверждать намерение, которого у него больше нет, и новое решение
          // считалось бы сменой цели там, где менять нечего.
          goal: 'idle',
          planId: null,
          needBaseline: { ...agent.needBaseline, hunger: event.world_time },
        },
      },
    },
    actorId,
    event,
  );
}

/**
 * Агент лёг отдыхать: становится занят, и завершение отдыха попадает в расписание (I05).
 *
 * Момент конца берётся ИЗ СОБЫТИЯ по тому же основанию, что `expected_arrival` у пути: `evolve`
 * не знает коэффициентов ruleset, а второй способ его вычислить стал бы вторым источником правды.
 */
function applyRestStarted(
  state: WorldState,
  event: Extract<WorldEvent, { type: 'rest.started' }>,
): WorldState {
  const actorId = requireSingleActorId(event);
  const agent = state.agents[actorId];
  if (agent === undefined) {
    throw new Error(`evolve: rest.started ссылается на неизвестного актора ${actorId}`);
  }
  const action: RestCompleteAction = {
    id: event.event_id,
    kind: 'rest.complete',
    dueAt: event.payload.expected_end,
    priority: SCHEDULED_ACTION_PRIORITY['rest.complete'],
    entityId: actorId,
  };
  // Шаг «лечь отдыхать» исполнен и уходит: он снимается по признаку действия, как и приём
  // пищи, — у агента не бывает двух ждущих укладываний.
  const remaining: Record<string, ScheduledAction> = {};
  for (const [id, other] of Object.entries(state.scheduledActions)) {
    if (other.kind === 'agent.rest' && other.entityId === actorId) continue;
    remaining[id] = other;
  }
  remaining[action.id] = action;
  return {
    ...state,
    agents: { ...state.agents, [actorId]: { ...agent, status: 'resting' } },
    scheduledActions: remaining,
  };
}

/**
 * Отдых закончился: агент свободен, усталость отсчитывается заново (I05).
 *
 * Выполненное действие снимается по `caused_by` — тем же способом, что у завершения пути (M7):
 * связь идёт от факта к его причине, а не от совпадения полей.
 */
function applyAgentRested(
  state: WorldState,
  event: Extract<WorldEvent, { type: 'agent.rested' }>,
): WorldState {
  const actorId = requireSingleActorId(event);
  const agent = state.agents[actorId];
  if (agent === undefined) {
    throw new Error(`evolve: agent.rested ссылается на неизвестного актора ${actorId}`);
  }

  const causedByIds = new Set(event.caused_by);
  const remaining: Record<string, ScheduledAction> = {};
  for (const [id, action] of Object.entries(state.scheduledActions)) {
    if (causedByIds.has(id)) continue;
    remaining[id] = action;
  }

  return withDecisionScheduled(
    {
      ...state,
      scheduledActions: remaining,
      agents: {
        ...state.agents,
        [actorId]: {
          ...agent,
          status: 'idle',
          // Цель достигнута — см. тот же довод у `agent.ate`.
          goal: 'idle',
          planId: null,
          needBaseline: { ...agent.needBaseline, fatigue: event.world_time },
        },
      },
    },
    actorId,
    event,
  );
}

/**
 * Агент выбрал цель — и цель немедленно превращается в ШАГ (I05, §6).
 *
 * Шаг ставится здесь, а не исполняется на месте, по общему правилу: у мира один способ
 * измениться, и он проходит через `decide`. План этого среза длиной ровно в один шаг, потому
 * что шагов длиннее пока не из чего строить: «дойти до еды» требует источника предметов (I08),
 * «помочь» — отношений (I09). Обещать план на 3–6 шагов и наполнять его пустыми звеньями было
 * бы хуже, чем честно поставить один.
 *
 * Ждущие решения того же агента снимаются ВСЕ. Инвариант: у агента не больше одного ждущего
 * решения. Он нужен потому, что решение, назначенное по факту, могло быть назначено дважды —
 * двумя фактами одного момента, — и второе принималось бы по ситуации, которую первое уже
 * учло. Тот же приём и то же основание, что у пересечений порога.
 */
function applyGoalChosen(
  state: WorldState,
  event: Extract<WorldEvent, { type: 'goal.chosen' }>,
): WorldState {
  const actorId = requireSingleActorId(event);
  const agent = state.agents[actorId];
  if (agent === undefined) {
    throw new Error(`evolve: goal.chosen ссылается на неизвестного актора ${actorId}`);
  }

  const remaining: Record<string, ScheduledAction> = {};
  for (const [id, action] of Object.entries(state.scheduledActions)) {
    if (action.kind === 'agent.decide' && action.entityId === actorId) continue;
    remaining[id] = action;
  }

  const step = stepFor(state, actorId, event);
  if (step !== null) remaining[step.id] = step;

  return {
    ...state,
    agents: {
      ...state.agents,
      [actorId]: {
        ...agent,
        goal: event.payload.goal,
        // У праздности плана нет: «ничего не делать» не срывается и тождества не требует.
        planId:
          event.payload.goal === 'idle'
            ? null
            : planIdFor(actorId, event.payload.goal, event.sequence),
      },
    },
    scheduledActions: remaining,
  };
}

/**
 * План сорвался: агент свободен и обязан выбрать заново (I05-C, §6).
 *
 * Ветка существовала с I01 пустой — envelope события был заморожен раньше, чем появился хоть
 * один его производитель. Здесь она наконец что-то делает.
 *
 * Снимается ВСЁ, что держало агента в сорванном плане: цель, её тождество, занятость и ждущие
 * шаги. Оставить хоть что-то одно значило бы получить агента, который свободен по одному полю и
 * занят по другому, — и разойтись эти поля могли бы только молча.
 *
 * Момент отсчёта усталости при прерванном отдыхе НЕ сдвигается: отдых не состоялся, и снимать за
 * него усталость было бы платой за работу, которой не было.
 */
function applyPlanInvalidated(
  state: WorldState,
  event: Extract<WorldEvent, { type: 'plan.invalidated' }>,
): WorldState {
  const actorId = requireSingleActorId(event);
  const agent = state.agents[actorId];
  if (agent === undefined) {
    throw new Error(`evolve: plan.invalidated ссылается на неизвестного актора ${actorId}`);
  }

  const remaining: Record<string, ScheduledAction> = {};
  for (const [id, action] of Object.entries(state.scheduledActions)) {
    if (action.entityId === actorId && ABANDONED_ON_PLAN_FAILURE.includes(action.kind)) continue;
    remaining[id] = action;
  }

  return withDecisionScheduled(
    {
      ...state,
      scheduledActions: remaining,
      agents: {
        ...state.agents,
        [actorId]: {
          ...agent,
          goal: 'idle',
          planId: null,
          // Путь сорванным планом не отменяется: маршрут выбирает оператор, а не агент.
          status: agent.status === 'resting' ? 'idle' : agent.status,
        },
      },
    },
    actorId,
    event,
  );
}

/**
 * Что снимается вместе с сорванным планом.
 *
 * Завершение пути сюда не входит: путь не является целью этого среза, и снять его завершение
 * значило бы оставить агента в пути навсегда — начатый путь обязан завершиться.
 */
const ABANDONED_ON_PLAN_FAILURE: readonly ScheduledAction['kind'][] = [
  'agent.eat',
  'agent.rest',
  'agent.travel',
  'rest.complete',
  'agent.decide',
];

/**
 * Первый (и пока единственный) шаг выбранной цели.
 *
 * `idle` шага не имеет — это и есть его смысл: агент ничего не делает и ждёт следующего факта.
 * Пустой план здесь законный исход, а не пропущенная ветка (§4.3 плана итерации).
 */
function stepFor(
  state: WorldState,
  actorId: string,
  event: Extract<WorldEvent, { type: 'goal.chosen' }>,
): AgentEatAction | AgentRestAction | AgentTravelAction | null {
  if (event.payload.goal === 'flee') {
    return {
      id: agentTravelActionId(event.event_id),
      kind: 'agent.travel',
      dueAt: event.world_time,
      priority: SCHEDULED_ACTION_PRIORITY['agent.travel'],
      entityId: actorId,
    };
  }
  if (event.payload.goal === 'rest') {
    return {
      id: agentRestActionId(event.event_id),
      kind: 'agent.rest',
      dueAt: event.world_time,
      priority: SCHEDULED_ACTION_PRIORITY['agent.rest'],
      entityId: actorId,
    };
  }
  if (event.payload.goal !== 'eat') return null;

  /**
   * Предмет выбирается ДЕТЕРМИНИРОВАННО — первый по возрастанию id среди съедобного, что есть
   * у агента. Любой другой выбор («самый свежий», «случайный») потребовал бы либо данных,
   * которых у предмета нет, либо розыгрыша, а розыгрыш в `evolve` запрещён: она применяет
   * записанные факты, а не бросает кости заново (см. заголовок `replay.ts`).
   */
  const food = Object.values(state.items)
    .filter((item) => item.ownerId === actorId && item.kind === 'food')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chosen = food[0];
  if (chosen === undefined) {
    // Исполнимость проверена при отборе кандидатов (`goals.ts`), поэтому сюда попасть нельзя.
    // Отказ громкий: молчаливое «шага не будет» оставило бы агента с целью, которую никто не
    // исполнит, и он замер бы навсегда — то есть ровно тем способом, от которого §4.3 плана
    // защищает отбор.
    throw new Error(
      `evolve: goal.chosen выбрал "eat" для ${actorId}, но съедобного у него нет: ` +
        'исполнимость цели проверяется при отборе кандидатов и разойтись с состоянием не может',
    );
  }
  return {
    id: agentEatActionId(event.event_id),
    kind: 'agent.eat',
    dueAt: event.world_time,
    priority: SCHEDULED_ACTION_PRIORITY['agent.eat'],
    entityId: actorId,
    itemId: chosen.id,
  };
}

/**
 * Назначить агенту решение, если факт оставил его СВОБОДНЫМ (§4.2 плана I05).
 *
 * Периодического опроса в мире нет: агент решает, когда для него что-то изменилось. Триггером
 * всегда является факт — прибытие, приём пищи, конец отдыха, переход нужды, — и между фактами
 * решений не происходит, потому что решать не о чем. «Каждые N минут пересчитать цели» — это
 * pulse под другим именем, со всей ценой, из-за которой §5 спецификации переписывался в I04.
 *
 * `goal.chosen` в список триггеров НЕ входит, и это не забывчивость: решение, порождающее новое
 * решение, дало бы мир, крутящийся на месте. Выбор — итог рассмотрения ситуации; рассматривать
 * ту же ситуацию второй раз нечего.
 */
function withDecisionScheduled(
  state: WorldState,
  actorId: string,
  event: { readonly event_id: string; readonly world_time: string },
): WorldState {
  const agent = state.agents[actorId];
  if (agent === undefined || !isAgentFree(agent)) return state;

  const remaining: Record<string, ScheduledAction> = {};
  for (const [id, action] of Object.entries(state.scheduledActions)) {
    if (action.kind === 'agent.decide' && action.entityId === actorId) continue;
    remaining[id] = action;
  }

  const decision: AgentDecideAction = {
    id: agentDecideActionId(event.event_id),
    kind: 'agent.decide',
    dueAt: event.world_time,
    priority: SCHEDULED_ACTION_PRIORITY['agent.decide'],
    entityId: actorId,
  };
  remaining[decision.id] = decision;

  return { ...state, scheduledActions: remaining };
}

/**
 * Агент узнал опасность дороги (I06-B).
 *
 * Знание кладётся в состояние ИМЕННО ЗДЕСЬ, из факта, и нигде больше. Побочный эффект в ветке
 * прибытия дал бы то же самое сегодня и разошёлся бы завтра: способов узнать станет несколько, а
 * требование «знание не появляется без provenance» (SIM-05) держалось бы дисциплиной в каждой из
 * веток вместо одной.
 *
 * Записывается `event_id` этого факта — провенанс, а не украшение: по нему расследование
 * отвечает на вопрос «откуда он это взял», не гадая по времени.
 */
function applyRiskObserved(
  state: WorldState,
  event: Extract<WorldEvent, { type: 'risk.observed' }>,
): WorldState {
  const actorId = requireSingleActorId(event);
  const agent = state.agents[actorId];
  if (agent === undefined) {
    throw new Error(`evolve: risk.observed ссылается на неизвестного актора ${actorId}`);
  }

  return {
    ...state,
    agents: {
      ...state.agents,
      [actorId]: {
        ...agent,
        knownRoutes: {
          ...agent.knownRoutes,
          [event.payload.route_id]: {
            risk: event.payload.risk,
            at: event.world_time,
            sourceEventId: event.event_id,
          },
        },
      },
    },
  };
}
