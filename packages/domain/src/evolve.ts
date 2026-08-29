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
  agentEatActionId,
  needThresholdActionId,
  type AgentEatAction,
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
    case 'plan.invalidated':
      // Планы и потребности агентов — вне scope I01 (§5 плана итерации); envelope уже
      // заморожен (§11), поэтому ветка обязана существовать уже сейчас (A8), даже без
      // собственного эффекта на `WorldState`.
      return bumped;
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

  return {
    ...state,
    agents: {
      ...state.agents,
      [actorId]: { ...agent, status: 'traveling', routeId: event.payload.route_id },
    },
    scheduledActions: { ...state.scheduledActions, [action.id]: action },
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

  return {
    ...state,
    agents: {
      ...state.agents,
      [actorId]: { ...agent, status: 'idle', routeId: null, locationId: route.toLocationId },
    },
    scheduledActions: remaining,
  };
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

  const withEating = scheduleEatingIfStarving(
    state,
    remaining,
    actorId,
    need,
    toLevel,
    event.world_time,
  );

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
    withEating[next.id] = next;
  }

  return { ...state, scheduledActions: withEating };
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
 * Правило «дошёл до предела голода и еда есть — ест» (I04, PLAN §2).
 *
 * Это НЕ выбор цели и не интеллект: выбор — I05. Здесь прямое следствие порога, и оно живёт в
 * `evolve`, потому что является планированием, а планирование в этом проекте выводится из
 * журнала чистой функцией — иначе пересимуляция восстанавливала бы мир без запланированной еды.
 *
 * Предмет выбирается ДЕТЕРМИНИРОВАННО — первый по возрастанию id среди съедобного, что есть у
 * агента. Любой другой выбор («самый свежий», «случайный») потребовал бы либо данных, которых у
 * предмета нет, либо розыгрыша, а розыгрыш в `evolve` запрещён: она применяет записанные факты,
 * а не бросает кости заново (см. заголовок `replay.ts`).
 */
function scheduleEatingIfStarving(
  state: WorldState,
  scheduled: Record<string, ScheduledAction>,
  actorId: string,
  need: 'hunger' | 'fatigue',
  toLevel: 'normal' | 'warning' | 'critical',
  at: string,
): Record<string, ScheduledAction> {
  if (need !== 'hunger' || toLevel !== 'critical') return scheduled;

  const food = Object.values(state.items)
    .filter((item) => item.ownerId === actorId && item.kind === 'food')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chosen = food[0];
  if (chosen === undefined) return scheduled;

  const action: AgentEatAction = {
    id: agentEatActionId(actorId, at),
    kind: 'agent.eat',
    dueAt: at,
    priority: SCHEDULED_ACTION_PRIORITY['agent.eat'],
    entityId: actorId,
    itemId: chosen.id,
  };
  return { ...scheduled, [action.id]: action };
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

  // Запланированный приём пищи выполнен и уходит из расписания — по тому же ключу, по которому
  // был поставлен, восстановленному из момента события.
  const remainingActions: Record<string, ScheduledAction> = {};
  const firedId = agentEatActionId(actorId, event.world_time);
  for (const [id, action] of Object.entries(state.scheduledActions)) {
    if (id === firedId) continue;
    remainingActions[id] = action;
  }

  return {
    ...state,
    items: remainingItems,
    scheduledActions: remainingActions,
    agents: {
      ...state.agents,
      [actorId]: {
        ...agent,
        needBaseline: { ...agent.needBaseline, hunger: event.world_time },
      },
    },
  };
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
  return {
    ...state,
    agents: { ...state.agents, [actorId]: { ...agent, status: 'resting' } },
    scheduledActions: { ...state.scheduledActions, [action.id]: action },
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

  return {
    ...state,
    scheduledActions: remaining,
    agents: {
      ...state.agents,
      [actorId]: {
        ...agent,
        status: 'idle',
        needBaseline: { ...agent.needBaseline, fatigue: event.world_time },
      },
    },
  };
}
