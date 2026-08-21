/**
 * @zona/content — минимальные fixtures мира (I01, PLAN §6 "6. Минимальные fixtures мира").
 *
 * Пакет — ДАННЫЕ, не логика (ADR-002): правило `content-is-data-only` в
 * `.dependency-cruiser.cjs` запрещает пакету импортировать что-либо, кроме себя, и
 * `scripts/boundaries/check-workspace-graph.ts` не разрешает пакету НИКАКИХ `@zona/*`
 * зависимостей. Поэтому здесь нет ни `@zona/domain`, ни `@zona/contracts` — только простые
 * объекты, массивы и строки, и ноль функций сверх типов. Кто и как превращает эти данные в
 * `WorldState`/`Snapshot` (случайный выбор стартовой локации по seed, канонизация, checksum) —
 * решает `apps/cli` (`apps/cli/src/world.ts`), а не этот пакет.
 *
 * Поля намеренно совпадают по форме с доменным `RouteDefinition`/`AgentState`
 * (`packages/domain/src/state.ts`), но типы не переиспользуются напрямую — граница пакета не
 * позволяет content импортировать domain, а domain не должен знать о content. Совпадение формы
 * структурно проверяется в `apps/cli/src/world.ts` присваиванием, а не общим типом.
 */

export interface LocationDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
}

/**
 * Данные маршрута — включая длительность (PLAN §6, решение 11: "длительность конкретного
 * маршрута — это данные маршрута, как расстояние, а не тюнинг правил"; коэффициенты остаются в
 * `Ruleset`, когда появится расчёт, который их использует).
 */
export interface RouteDefinition {
  readonly id: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  /** Время в пути; единица — минуты мирового времени (совпадает с доменным `RouteDefinition`). */
  readonly travelMinutes: number;
}

export interface WorldDefinition {
  readonly worldId: string;
  /**
   * Момент, с которого начинается только что порождённый (ещё без событий) мир — фиксированная
   * дата лора, не текущее время: content не источник wall clock, а `apps/cli` не имеет часов
   * (SIM-01). Строка проходит `Clock`/`parseCanonicalInstant` на стороне CLI, здесь — просто
   * валидный ISO-8601 момент с явным смещением.
   */
  readonly initialWorldTime: string;
  readonly locations: readonly LocationDefinition[];
  readonly routes: readonly RouteDefinition[];
  readonly agents: readonly AgentDefinition[];
}

/**
 * Версия этого content bundle (§7/§9 контракта: "версии без checksum недостаточно" — версия
 * здесь, checksum считает `apps/cli` от фактического содержимого при сборке snapshot).
 */
export const CONTENT_VERSION = '0.1.0';

/**
 * Единственный мир I01 (PLAN §6: "1 мир, 2–4 локации, 1–2 маршрута, 3–5 агентов"). Имена —
 * оригинальные и нейтральные (CLAUDE.md: без письменного IP-разрешения — никаких заимствованных
 * названий фракций/локаций).
 */
export const PROTOTYPE_WORLD: WorldDefinition = {
  worldId: 'world:prototype',
  initialWorldTime: '2028-04-26T06:00:00Z',
  locations: [
    {
      id: 'loc:quiet-yard',
      name: 'Тихий двор',
      description: 'Огороженный внутренний двор — самое спокойное место в округе.',
    },
    {
      id: 'loc:bridge',
      name: 'Мост',
      description: 'Полуразрушенный автомобильный мост через реку.',
    },
    {
      id: 'loc:checkpoint',
      name: 'Блокпост',
      description: 'Старый контрольный пункт на дороге за мостом.',
    },
    {
      id: 'loc:relay-station',
      name: 'Ретрансляционная станция',
      description: 'Заброшенная станция связи на возвышенности.',
    },
  ],
  routes: [
    {
      id: 'route:yard-to-bridge',
      fromLocationId: 'loc:quiet-yard',
      toLocationId: 'loc:bridge',
      travelMinutes: 40,
    },
    {
      id: 'route:bridge-to-checkpoint',
      fromLocationId: 'loc:bridge',
      toLocationId: 'loc:checkpoint',
      travelMinutes: 25,
    },
  ],
  agents: [
    { id: 'agent:rook', name: 'Рук' },
    { id: 'agent:kite', name: 'Коршун' },
    { id: 'agent:finch', name: 'Зяблик' },
    { id: 'agent:swift', name: 'Стриж' },
  ],
};
