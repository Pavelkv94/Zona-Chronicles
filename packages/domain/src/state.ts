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

export type AgentStatus = 'idle' | 'traveling';

export interface AgentState {
  readonly id: string;
  readonly locationId: string;
  readonly status: AgentStatus;
  /** Маршрут, по которому агент сейчас идёт; `null`, а не отсутствующее поле, когда `idle`. */
  readonly routeId: string | null;
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
 * `id` — это `event_id` события-причины: детерминирован, уникален и делает связь «действие ↔
 * факт, который его породил» прямой, без отдельного справочника.
 */
export interface ScheduledAction {
  readonly id: string;
  readonly kind: 'journey.complete';
  /** Каноническая ISO-метка МИРОВОГО времени, когда действие становится доступным. */
  readonly dueAt: string;
  /** Меньше — раньше. Разводит действия с одинаковым `dueAt` до сравнения id (C4). */
  readonly priority: number;
  readonly entityId: string;
  readonly routeId: string;
}

/** Приоритеты по видам действий. Данные, а не магические числа внутри `evolve`. */
export const SCHEDULED_ACTION_PRIORITY: Readonly<Record<ScheduledAction['kind'], number>> = {
  'journey.complete': 100,
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
  /** Ключ — `id` действия. Порядок вставки смысла не несёт: `canonicalize` сортирует ключи. */
  readonly scheduledActions: Readonly<Record<string, ScheduledAction>>;
}
