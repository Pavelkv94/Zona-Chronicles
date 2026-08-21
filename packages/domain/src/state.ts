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
}
