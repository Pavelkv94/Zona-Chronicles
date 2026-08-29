import type { ItemKind, NeedKind, NeedLevel } from '@zona/contracts';

/**
 * Внутреннее (canonical) состояние мира — первый slice (§11 `09_EVENT_AND_COMMAND_CONTRACTS`):
 * агенты и маршруты, достаточные для `journey.start` → `journey.started`.
 *
 * Форму владеет домен (`snapshot.ts` контракта: «форма принадлежит домену, контракт требует
 * лишь того, чтобы оно было канонически сериализуемым»). Поэтому состояние — простые объекты,
 * массивы и примитивы, БЕЗ `Map`/`Set`: `canonicalize` из `@zona/contracts` отвергает их как
 * «не имеющие канонического представления», а `WorldState` должен без преобразований стать
 * `Snapshot.canonical_state`.
 *
 * Ключи `agents`/`routes` — сами id (`agent:*`, `route:*`): порядок вставки не несёт смысла и
 * не влияет на checksum, потому что `canonicalize` сортирует ключи по кодовым точкам (SIM-01).
 */

/**
 * Что агент делает прямо сейчас. `resting` добавлен в I05: отдых занял мировое время, и агент
 * во время него ЗАНЯТ — значит, состояние обязано быть наблюдаемым, иначе «отдыхает» ничем не
 * отличалось бы от «стоит без дела», и прервать его было бы нечего.
 */
export type AgentStatus = 'idle' | 'traveling' | 'resting';

export interface AgentState {
  readonly id: string;
  readonly locationId: string;
  readonly status: AgentStatus;
  /** Маршрут, по которому агент сейчас идёт; `null`, а не отсутствующее поле, когда `idle`. */
  readonly routeId: string | null;
  /**
   * Момент мирового времени, с которого отсчитывается каждая нужда (I04, §5).
   *
   * Каноническим является ИМЕННО момент, а не значение нужды: значение вычисляется из него
   * чистой функцией (`needs.ts`) и потому не является фактом. Хранить оба означало бы держать
   * два источника одной истины, которые однажды разойдутся, — и разойдутся молча, потому что
   * несогласованность видна только при сравнении.
   */
  readonly needBaseline: Readonly<Record<NeedKind, string>>;
}

/**
 * Предмет мира (I04).
 *
 * Владелец РОВНО один и всегда назван: агент. Лежащих на земле предметов в этой итерации нет —
 * их появление означало бы второй способ владения и второй набор правил передачи, а передачи
 * ещё нет вовсе. Когда предметы начнут лежать в локациях (I08), поле станет union-ом, и это
 * заставит разобрать оба случая явно, а не добавит `null`, который потребитель забудет проверить.
 */
export interface ItemState {
  readonly id: string;
  readonly kind: ItemKind;
  readonly ownerId: string;
}

export interface RouteDefinition {
  readonly id: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  /** Время в пути; единица — минуты мирового времени (`addMinutes` контракта). */
  readonly travelMinutes: number;
}

/**
 * Запланированное действие — ЧАСТЬ канонического состояния, а не операционная очередь (I02B).
 *
 * Это решение, и оно неочевидное. Альтернатива — таблица задач, которую наполняет адаптер
 * персистентности, прочитав `expected_arrival` из события. Она короче, но переносит доменное
 * знание («начатый путь обязан завершиться») в оболочку, и тогда replay журнала перестаёт
 * восстанавливать расписание: его пришлось бы восстанавливать отдельным механизмом, который
 * может разойтись с событиями молча.
 *
 * Здесь расписание выводится из событий чистой функцией `evolve`, поэтому пересимуляция
 * восстанавливает его бесплатно и по построению не может разойтись с историей. Таблица в БД —
 * зеркало этого состояния плюс операционные поля аренды, которые каноническими не являются и в
 * checksum не входят.
 *
 * `id` детерминирован и уникален; ЧЕМ именно он является, решает вид действия. У завершения
 * пути это `event_id` события-причины — связь прямая, без отдельного справочника. У пересечения
 * порога нужды события-причины может не быть вовсе (первое пересечение планируется в генезисе),
 * поэтому там ключ собирается из агента, нужды и момента. Общее требование одно: по ключу
 * действие должно быть отличимо от любого другого, включая уже выполненные.
 */
interface ScheduledActionBase {
  readonly id: string;
  /** Каноническая ISO-метка МИРОВОГО времени, когда действие становится доступным. */
  readonly dueAt: string;
  /** Меньше — раньше. Разводит действия с одинаковым `dueAt` до сравнения id (C4). */
  readonly priority: number;
  readonly entityId: string;
}

/**
 * Завершение начатого пути. `id` равен `event_id` события-причины: связь «действие ↔ факт, его
 * породивший» прямая, без отдельного справочника, и `journey.completed` снимает действие именно
 * по ней (M7).
 */
export interface JourneyCompleteAction extends ScheduledActionBase {
  readonly kind: 'journey.complete';
  readonly routeId: string;
}

/**
 * Пересечение порога нужды (I04).
 *
 * `id` НЕ равен id события-причины, и это вынужденно: самое первое пересечение планируется в
 * генезисе, где событий нет вовсе. Ключ вместо этого детерминирован —
 * `sched:need:<агент>:<нужда>:<момент>`, — и уникален по построению: у одного агента по одной
 * нужде не может быть двух ждущих пересечений одновременно.
 *
 * Это не «совпадение полей», от которого предостерегает M7: там пара «агент + маршрут» была
 * ЭВРИСТИКОЙ, верной лишь пока механика одна. Здесь ключ содержит момент срабатывания, поэтому
 * различает даже два пересечения одной нужды у одного агента.
 */
/**
 * Съесть предмет по достигнутому порогу голода (I04).
 *
 * Это НЕ выбор цели: выбор — I05. Здесь прямое следствие порога, записанное правилом «дошёл до
 * critical и еда есть — ест». Действие планируется, а не исполняется на месте, по той же
 * причине, что и всё остальное: у мира один способ измениться, и он проходит через `decide`.
 */
export interface AgentEatAction extends ScheduledActionBase {
  readonly kind: 'agent.eat';
  readonly itemId: string;
}

/** Завершение начатого отдыха (I05). `id` равен `event_id` события `rest.started`. */
export interface RestCompleteAction extends ScheduledActionBase {
  readonly kind: 'rest.complete';
}

export interface NeedThresholdAction extends ScheduledActionBase {
  readonly kind: 'need.threshold';
  readonly need: NeedKind;
  /** Уровень, которого нужда достигнет к `dueAt`. Ожидание, которое `decide` перепроверяет. */
  readonly toLevel: NeedLevel;
}

export type ScheduledAction =
  JourneyCompleteAction | NeedThresholdAction | AgentEatAction | RestCompleteAction;

/** Детерминированный ключ действия «поесть»: у агента не может быть двух ждущих приёмов пищи. */
export function agentEatActionId(agentId: string, at: string): string {
  return `sched:eat:${agentId}:${at}`;
}

/** Детерминированный ключ действия по нужде. Один источник формата на весь проект. */
export function needThresholdActionId(agentId: string, need: NeedKind, dueAt: string): string {
  return `sched:need:${agentId}:${need}:${dueAt}`;
}

/** Приоритеты по видам действий. Данные, а не магические числа внутри `evolve`. */
export const SCHEDULED_ACTION_PRIORITY: Readonly<Record<ScheduledAction['kind'], number>> = {
  'journey.complete': 100,
  // Пересечение порога обрабатывается ПОСЛЕ прибытия при одинаковом `dueAt`: прибывший агент
  // сначала оказывается на месте, и только потом мир замечает, что он голоден. Обратный порядок
  // дал бы летопись, где голод наступает у того, кто ещё в пути.
  'need.threshold': 200,
  // Есть агент начинает ПОСЛЕ того, как мир заметил его голод: обратный порядок дал бы летопись,
  // в которой агент поел раньше, чем проголодался.
  'agent.eat': 300,
  // Отдых заканчивается ПЕРВЫМ при равном сроке: агент сначала встаёт, и только потом мир
  // замечает его нужды. Обратный порядок дал бы летопись, где спящий проголодался и тут же
  // проснулся, — переставленную местами причину и следствие.
  'rest.complete': 50,
};

export interface WorldState {
  readonly worldId: string;
  /** Версия мира для optimistic concurrency (`expected_world_version` команды, §2). */
  readonly worldVersion: number;
  /** Каноническая ISO-метка мирового времени на момент этого состояния. */
  readonly worldTime: string;
  /** Последняя применённая sequence; 0 — мир без событий (`SNAPSHOT_SEQUENCE_UNIT`). */
  readonly sequence: number;
  readonly agents: Readonly<Record<string, AgentState>>;
  readonly routes: Readonly<Record<string, RouteDefinition>>;
  /** Ключ — `id` предмета. Предмет существует, пока он здесь; сток его отсюда убирает. */
  readonly items: Readonly<Record<string, ItemState>>;
  /** Ключ — `id` действия. Порядок вставки смысла не несёт: `canonicalize` сортирует ключи. */
  readonly scheduledActions: Readonly<Record<string, ScheduledAction>>;
}
