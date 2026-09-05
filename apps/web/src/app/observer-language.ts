/**
 * Прочтение факта зрителем: как одно событие ленты становится строкой на экране (I03, I06-D).
 *
 * ## Фраза строится ЗДЕСЬ, а не приходит из мира
 *
 * ADR-005: текст никогда не является источником факта. Лента отдаёт `type`, `actor_ids`,
 * `route_id` и прочее, но не готовую фразу. Пока фраза собирается на экране из полей факта,
 * расхождение фразы с фактом невозможно: фраза и ЕСТЬ прочтение факта. Настоящий слой
 * representation появится в I11B — эти функции его предвосхищают ровно настолько, чтобы не
 * оказаться его подменой.
 *
 * ## Почему это отдельный модуль, а не функция внутри компонента
 *
 * Проверяемость. Прочтение факта — то место, где зритель может быть обманут молча: строка,
 * потерявшая дорогу, выглядит нормальной. Здесь оно проверяется без браузера, событием за
 * событием, а e2e остаётся доказательством, что мир и экран сходятся.
 *
 * ## Названий может не быть, и тогда показывается идентификатор
 *
 * Snapshot ещё не пришёл, либо проекция собрана из другого мира. Придумать имя значило бы
 * соврать, написать «неизвестно» — скрыть расхождение. Идентификатор — та правда, которая есть.
 */
import type {
  GoalKind,
  NeedKind,
  NeedLevel,
  ObserverAgent,
  ObserverEvent,
  ObserverWorldSnapshot,
} from '@zona/contracts';

const EVENT_LABELS = {
  'journey.started': 'вышел в путь',
  'journey.completed': 'дошёл',
  'plan.invalidated': 'план отменён',
  'need.threshold.crossed': 'изменилось состояние',
  'agent.ate': 'поел',
  'agent.rested': 'отдохнул',
  'rest.started': 'лёг отдыхать',
  'goal.chosen': 'решил',
  'risk.observed': 'разведал дорогу',
} as const satisfies Readonly<Record<ObserverEvent['type'], string>>;

/**
 * Где произошло событие: на дороге или в месте.
 *
 * Названо по типу события явно, а не выведено из «есть ли `route_id`»: у прибытия есть и
 * дорога, и место, и зрителю нужно место — куда он дошёл. У ухода есть и то и другое, и нужна
 * дорога: до I06 её выбирал человек своей же командой и мог не читать, а теперь выбирает агент,
 * и строка без дороги скрывает единственное, что в ней есть нового.
 */
const EVENT_PLACE = {
  'journey.started': 'route',
  'journey.completed': 'location',
  'plan.invalidated': 'location',
  'need.threshold.crossed': 'location',
  'agent.ate': 'location',
  'agent.rested': 'location',
  'rest.started': 'location',
  'goal.chosen': 'location',
  'risk.observed': 'route',
} as const satisfies Readonly<Record<ObserverEvent['type'], 'route' | 'location'>>;

/**
 * Цель словами. `idle` читается как отказ от дела, а не как пустая строка: факт «перестал
 * что-либо затевать» произошёл, и лента, показавшая на его месте пробел, соврала бы молчанием.
 */
export const GOAL_LABELS = {
  idle: 'ничего не делать',
  eat: 'поесть',
  rest: 'отдохнуть',
  flee: 'уйти отсюда',
} as const satisfies Readonly<Record<GoalKind, string>>;

/**
 * Состояние агента словами. `normal` не имеет подписи намеренно: «Зяблик спокоен» — это не
 * событие, а отсутствие события, и в ленте оно означало бы, что произошло что-то, чего не было.
 * Восстановление читается по паре «нужда + уровень», а не по отдельному слову.
 */
const NEED_LEVEL_LABELS = {
  hunger: { normal: 'сыт', warning: 'голоден', critical: 'изголодался' },
  fatigue: { normal: 'бодр', warning: 'устал', critical: 'вымотан' },
} as const satisfies Readonly<Record<NeedKind, Readonly<Record<NeedLevel, string>>>>;

export interface WorldNaming {
  /** Имя агента по идентификатору; сам идентификатор, если мир его не знает. */
  readonly agent: (agentId: string) => string;
  readonly location: (locationId: string) => string;
  /** Дорога как «откуда → куда»; идентификатор, если мир её не знает. */
  readonly route: (routeId: string) => string;
}

export function namingOf(snapshot: ObserverWorldSnapshot | null): WorldNaming {
  const agents = new Map((snapshot?.agents ?? []).map((agent) => [agent.agent_id, agent.name]));
  const locations = new Map((snapshot?.nodes ?? []).map((node) => [node.location_id, node.name]));
  const location = (locationId: string): string => locations.get(locationId) ?? locationId;
  const edges = new Map((snapshot?.edges ?? []).map((edge) => [edge.route_id, edge]));
  return {
    agent: (agentId) => agents.get(agentId) ?? agentId,
    location,
    route: (routeId) => {
      const edge = edges.get(routeId);
      return edge === undefined
        ? routeId
        : `${location(edge.from_location_id)} → ${location(edge.to_location_id)}`;
    },
  };
}

/** Место события хвостом строки: « — Мост» либо «: Мост → Блокпост». Пусто, если места нет. */
const placeOf = (event: ObserverEvent, naming: WorldNaming): string => {
  if (EVENT_PLACE[event.type] === 'route') {
    return event.route_id === null ? '' : `: ${naming.route(event.route_id)}`;
  }
  return event.location_id === null ? '' : ` — ${naming.location(event.location_id)}`;
};

export function describeEvent(event: ObserverEvent, naming: WorldNaming): string {
  const who = event.actor_ids.map(naming.agent).join(', ');
  const where = placeOf(event, naming);
  // Событие о нужде читается своим состоянием, а не общей подписью: «Зяблик голоден» говорит
  // зрителю то же, что факт, а «Зяблик изменилось состояние» не говорит ничего.
  if (event.need !== null && event.need_level !== null) {
    return `${who}: ${NEED_LEVEL_LABELS[event.need][event.need_level]}${where}`;
  }
  // Решение читается своей целью. Разбора оценок в ленте нет и не будет: зритель видит, ЧТО
  // агент решил, а не как считал (§7 `03_TECHNICAL_DESIGN`, ADR-005).
  if (event.goal !== null) {
    return `${who} решил ${GOAL_LABELS[event.goal]}${where}`;
  }
  return `${who} ${EVENT_LABELS[event.type]}${where}`;
}

/**
 * Состояние агента одной строкой: что с ним не так и есть ли чем это поправить.
 *
 * `normal` не показывается: «Зяблик сыт и бодр» — это отсутствие новости, и на карте, где стоят
 * четыре человека, такие строки скрыли бы единственную важную. Показывается только отклонение.
 */
export function describeCondition(agent: ObserverAgent): string {
  const troubles = (['hunger', 'fatigue'] as const)
    .filter((need) => agent.needs[need] !== 'normal')
    .map((need) => NEED_LEVEL_LABELS[need][agent.needs[need]]);
  const food = agent.food_carried === 0 ? 'еды нет' : `еды: ${String(agent.food_carried)}`;
  // Цель показывается только когда она есть: «намерен ничего не делать» — это не намерение.
  const goal = agent.goal === 'idle' ? [] : [`намерен ${GOAL_LABELS[agent.goal]}`];
  return [...troubles, food, ...goal].join(' · ');
}
