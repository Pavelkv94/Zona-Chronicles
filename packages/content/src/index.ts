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
  /**
   * Опасность места в тысячных (I06, §8).
   *
   * Данные мира, а не коэффициент правил: «мост полуразрушен» — свойство моста, и меняется оно
   * вместе с картой, а не вместе с балансом. Тот же довод, что у длительности маршрута.
   */
  readonly risk: number;
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
  /** Опасность дороги в тысячных (I06, §8). Данные дороги, как и её длина. */
  readonly risk: number;
}

/**
 * Предмет стартового мира (I04).
 *
 * Владелец назван прямо в данных: инвентарь это контент, а не результат розыгрыша. Разный seed
 * меняет, ГДЕ агенты стоят, но не то, что у них с собой, — иначе «в этом мире голод наступил
 * раньше» означало бы и «и еды оказалось меньше», и два независимых эффекта было бы не
 * разделить при разборе прогона.
 */
export interface ItemDefinition {
  readonly id: string;
  /** Совпадает по форме с `ItemKind` контрактов; content не имеет права их импортировать. */
  readonly kind: 'food';
  readonly ownerId: string;
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
  readonly items: readonly ItemDefinition[];
}

/**
 * Версия этого content bundle (§7/§9 контракта: "версии без checksum недостаточно" — версия
 * здесь, checksum считает `apps/cli` от фактического содержимого при сборке snapshot).
 */
// 0.4.0 — I06: у мест и дорог появилась опасность, станция связи соединена с миром.
// 0.3.0 — I04: у мира появились предметы. Версия контента входит в bundle снимка вместе с
// checksum его СОДЕРЖИМОГО, поэтому расширение мира при прежней версии сделало бы два разных
// мира неразличимыми по имени контента.
export const CONTENT_VERSION = '0.4.0';

/**
 * Версии, которыми подписывается каждое событие мира прототипа.
 *
 * Живут ЗДЕСЬ, рядом с контентом, и это не произвол: `contentVersion` обязан совпадать с
 * `CONTENT_VERSION`, иначе события подписываются одной версией, а bundle снимка несёт другую —
 * и снимок не проходит проверку checksum. Пока это были два литерала в разных пакетах, они
 * совпадали лишь потому, что контент не менялся; первое же расширение мира (I03) их развело, и
 * worker перестал читать генезисный снимок. Найдено E2E-прогоном.
 *
 * Тип не импортируется из `@zona/domain` намеренно: `content-is-data-only` запрещает пакету
 * зависимости, а совпадение ФОРМЫ зависимостью не является.
 */
export const PROTOTYPE_RULESET_VERSIONS = {
  schemaVersion: 1,
  // 0.3.0 — I05-A: отдых занял мировое время, у правил появился его коэффициент.
  // 0.4.0 — I05-B: у правил появились веса выбора цели (срочность, цена времени, порог смены).
  // 0.5.0 — I06-C: у правил появилась оценка неизвестной дороги.
  // 0.2.0 — I04: у правил появились НАСТОЯЩИЕ коэффициенты (скорость роста нужд и пороги §5).
  // Rules bundle хешируется от содержимого ruleset, поэтому коэффициенты при прежней версии
  // дали бы два разных мира под одним именем правил. Литерал обязан совпадать с
  // `RULES_VERSION` в `@zona/domain` — совпадение проверяется тестом в `apps/cli`, потому что
  // content не имеет права импортировать domain и общего литерала быть не может.
  rulesVersion: '0.5.0',
  contentVersion: CONTENT_VERSION,
} as const;

/**
 * Единственный мир прототипа. Имена — оригинальные и нейтральные (CLAUDE.md: без письменного
 * IP-разрешения — никаких заимствованных названий фракций/локаций).
 *
 * Границы I01 («2–4 локации, 1–2 маршрута») расширены в I03 до связного графа с обратными
 * маршрутами: мир, из которого нельзя вернуться, наблюдать нечем — агенты за несколько переходов
 * упираются в тупик и замирают. `loc:relay-station` остаётся НЕСВЯЗНОЙ намеренно: критерий D12
 * требует, чтобы попытка пути к недостижимой локации была отвергнута названной причиной, и без
 * такой локации его нечем проверить.
 */
export const PROTOTYPE_WORLD: WorldDefinition = {
  worldId: 'world:prototype',
  initialWorldTime: '2028-04-26T06:00:00Z',
  locations: [
    {
      id: 'loc:quiet-yard',
      name: 'Тихий двор',
      description: 'Огороженный внутренний двор — самое спокойное место в округе.',
      risk: 0,
    },
    {
      id: 'loc:bridge',
      name: 'Мост',
      description: 'Полуразрушенный автомобильный мост через реку.',
      // Единственное место карты, откуда агент уходит по своей воле: риск выше порога ruleset.
      risk: 600,
    },
    {
      id: 'loc:checkpoint',
      name: 'Блокпост',
      description: 'Старый контрольный пункт на дороге за мостом.',
      risk: 300,
    },
    {
      id: 'loc:relay-station',
      name: 'Ретрансляционная станция',
      description: 'Заброшенная станция связи на возвышенности.',
      // Дорог к станции нет и в I06 не появилось: на её недостижимости держится D12 — «путь к
      // недостижимой локации отвергается названной причиной». Соединить её значило бы починить
      // карту и сломать проверку, ради которой она такая.
      risk: 100,
    },
    {
      id: 'loc:ravine',
      name: 'Овраг',
      description: 'Длинный обходной спуск по дну оврага — дольше, зато в стороне от дороги.',
      risk: 150,
    },
  ],
  routes: [
    {
      id: 'route:yard-to-bridge',
      fromLocationId: 'loc:quiet-yard',
      toLocationId: 'loc:bridge',
      travelMinutes: 40,
      risk: 400,
    },
    {
      id: 'route:bridge-to-checkpoint',
      fromLocationId: 'loc:bridge',
      toLocationId: 'loc:checkpoint',
      travelMinutes: 25,
      // Короткая дорога с моста, но самая опасная: выбор между «быстро» и «спокойно» существует
      // только когда эти два свойства расходятся.
      risk: 700,
    },
    // I03: обратные маршруты. Без них мир «заканчивается» после нескольких переходов — агенты
    // упираются в тупик и больше не двигаются, и наблюдать становится нечего. Длительность та
    // же: дорога одна, разница только в направлении.
    {
      id: 'route:bridge-to-yard',
      fromLocationId: 'loc:bridge',
      toLocationId: 'loc:quiet-yard',
      travelMinutes: 40,
      risk: 400,
    },
    {
      id: 'route:checkpoint-to-bridge',
      fromLocationId: 'loc:checkpoint',
      toLocationId: 'loc:bridge',
      travelMinutes: 25,
      risk: 700,
    },
    /**
     * I06: у мира появился ОБХОД.
     *
     * До этой итерации из каждой локации выходила ровно одна дорога, и «выбрал обход» было
     * невыразимо — выбирать не из чего. Овраг соединяет двор с блокпостом в объезд моста:
     * заметно дольше и заметно спокойнее прямой дороги.
     *
     * Разница в числах обязательна. При равных длине и риске различие между осторожным и
     * беспечным агентом не проявилось бы вовсе, и гипотезу итерации нечем было бы проверить.
     */
    {
      id: 'route:yard-to-ravine',
      fromLocationId: 'loc:quiet-yard',
      toLocationId: 'loc:ravine',
      travelMinutes: 90,
      risk: 150,
    },
    {
      id: 'route:ravine-to-yard',
      fromLocationId: 'loc:ravine',
      toLocationId: 'loc:quiet-yard',
      travelMinutes: 90,
      risk: 150,
    },
    {
      id: 'route:ravine-to-checkpoint',
      fromLocationId: 'loc:ravine',
      toLocationId: 'loc:checkpoint',
      travelMinutes: 70,
      risk: 200,
    },
    {
      id: 'route:checkpoint-to-ravine',
      fromLocationId: 'loc:checkpoint',
      toLocationId: 'loc:ravine',
      travelMinutes: 70,
      risk: 200,
    },
  ],
  agents: [
    { id: 'agent:rook', name: 'Рук' },
    { id: 'agent:kite', name: 'Коршун' },
    { id: 'agent:finch', name: 'Зяблик' },
    { id: 'agent:swift', name: 'Стриж' },
  ],
  /**
   * По два пайка на человека — ровно столько, чтобы демонстрация показала ОБА исхода: голод,
   * снятый едой, и голод, который снять уже нечем. Один паёк не показал бы повторения цикла,
   * а запас на неделю не показал бы исчерпания вовсе.
   */
  items: [
    { id: 'item:ration-rook-1', kind: 'food', ownerId: 'agent:rook' },
    { id: 'item:ration-rook-2', kind: 'food', ownerId: 'agent:rook' },
    { id: 'item:ration-kite-1', kind: 'food', ownerId: 'agent:kite' },
    { id: 'item:ration-kite-2', kind: 'food', ownerId: 'agent:kite' },
    { id: 'item:ration-finch-1', kind: 'food', ownerId: 'agent:finch' },
    { id: 'item:ration-finch-2', kind: 'food', ownerId: 'agent:finch' },
    { id: 'item:ration-swift-1', kind: 'food', ownerId: 'agent:swift' },
    { id: 'item:ration-swift-2', kind: 'food', ownerId: 'agent:swift' },
  ],
};
