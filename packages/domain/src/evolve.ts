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
  needThresholdActionId,
  type NeedThresholdAction,
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

  const remaining: Record<string, ScheduledAction> = {};
  for (const [id, action] of Object.entries(state.scheduledActions)) {
    if (id === firedId) continue;
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

  return { ...state, scheduledActions: remaining };
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
