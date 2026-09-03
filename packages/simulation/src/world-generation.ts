/**
 * Порождение мира из seed (I03; перенесено из `apps/cli/src/world.ts`).
 *
 * ## Почему это ПАКЕТ, а не модуль приложения
 *
 * Знание «какой мир получается при этом seed» перестало быть частным делом CLI, как только его
 * понадобилось второму приложению: сборщику проекции нужны те же `bundles`, чтобы прочитать
 * генезисный снимок. Приложения не имеют права импортировать друг друга, а `packages/persistence`
 * и `packages/projections` не имеют права импортировать друг друга — поэтому единственное
 * законное место общего знания это пакет, и `simulation` для него и заведён.
 *
 * ## Пакет ничего не читает у хоста
 *
 * `HostRuntimeProfile` приходит ПАРАМЕТРОМ: `process.version` в `packages/simulation` запрещён
 * (ADR-003, и правило `core-has-no-adapter-dependencies` это исполняет). Читает его приложение —
 * `currentHostRuntimeProfile` в `apps/cli`/`apps/worker`. Инъекция нужна и по второй причине,
 * записанной ещё в I01: профиль не входит в snapshot checksum, и это свойство обязано быть
 * проверяемым тестом, подставляющим чужой хост, а не второй машиной.
 *
 * ## Контент приходит параметром
 *
 * `@zona/content` пакету недоступен (`simulation-depends-on-contracts-and-domain`), и это к
 * лучшему: генератор мира не обязан знать, какой именно мир он порождает.
 */
import {
  type DeterministicRuntimeProfile,
  type Snapshot,
  CANONICAL_SERIALIZATION_VERSION,
  CANONICAL_TRANSACTION_ISOLATION_LEVEL,
  SNAPSHOT_CHECKSUM_SCOPE_VERSION,
  bundleRefFor,
  isInstantError,
  parseCanonicalInstant,
  schemaBundleRef,
  snapshotChecksum,
} from '@zona/contracts';
import {
  DeterministicRandomSource,
  FixedClock,
  SCHEDULED_ACTION_PRIORITY,
  needThresholdActionId,
  nextThresholdCrossing,
  type AgentState,
  type ItemState,
  type NeedThresholdAction,
  type RouteDefinition as DomainRouteDefinition,
  type Ruleset,
  type ScheduledAction,
  type WorldState,
} from '@zona/domain';
import { NEED_KINDS, type NeedKind } from '@zona/contracts';

/**
 * Форма контента, которую требует генератор. Совпадает с `WorldDefinition` из `@zona/content`
 * структурно, но объявлена здесь: пакет не имеет права зависеть от контента, а зависимость от
 * ФОРМЫ данных зависимостью не является.
 */
export interface GeneratorContent {
  readonly worldId: string;
  readonly initialWorldTime: string;
  readonly locations: readonly { readonly id: string }[];
  readonly routes: readonly {
    readonly id: string;
    readonly fromLocationId: string;
    readonly toLocationId: string;
    readonly travelMinutes: number;
  }[];
  readonly agents: readonly { readonly id: string }[];
  readonly items: readonly {
    readonly id: string;
    readonly kind: 'food';
    readonly ownerId: string;
  }[];
}

/** Версии, описывающие сам алгоритм для deterministic runtime profile (§9). */
const PRNG_VERSION = 'mulberry32+splitmix32/1';
const NUMERIC_ROUNDING_POLICY_VERSION = 'numeric-units/1';
const CANONICAL_TIMEZONE = 'UTC';

export interface HostRuntimeProfile {
  readonly nodeVersion: string;
  readonly icuVersion: string;
}

/**
 * Содержимое rules bundle — фактический ruleset, а не заглушка `{}` (M3).
 *
 * Прежняя редакция хешировала пустой объект, и checksum равнялся `sha256("{}")`: любое
 * изменение правил при неизменной версии было необнаружимо, то есть A9 для этого bundle не
 * выполнялся. Хешируется объект версий целиком, а не перечисленные вручную поля: поле,
 * добавленное в `RulesetVersions`, попадает в checksum само, без правки этого места.
 *
 * Когда у `Ruleset` появятся коэффициенты (§7), они добавляются сюда вместе с итерацией,
 * которая их вводит — иначе checksum снова начнёт лгать о содержимом.
 */
/**
 * Умолчания у `versions` НЕТ, и это не забывчивость (m13 независимого аудита I03).
 *
 * Прежде здесь стояло `= testRulesetVersions()`: тестовое значение на продуктовом пути. Ровно
 * такое умолчание у соседнего `bundlesFor` уже стоило дефекта — CLI перешёл на версию контента
 * из пакета, worker остался на умолчании, bundles разошлись, и мир перестал читать генезисный
 * снимок; падение приходило проверкой checksum, то есть в третьем месте, далеко от причины.
 * Там умолчание убрали, здесь — оставили. Один и тот же вывод, применённый наполовину, работает
 * как не применённый вовсе.
 */
export function rulesBundleContent(ruleset: Ruleset): Record<string, unknown> {
  // Коэффициенты хешируются ВМЕСТЕ с версиями, а не отдельно: иначе изменение порога при
  // неизменной версии осталось бы необнаружимым, и checksum лгал бы о содержимом правил — тот
  // самый дефект M3, из-за которого сюда вообще перестали передавать заглушку `{}`.
  return { versions: { ...ruleset.versions }, needs: { ...ruleset.needs } };
}

function canonicalInstant(iso: string, label: string): string {
  const parsed = parseCanonicalInstant(iso);
  if (isInstantError(parsed)) {
    throw new Error(`world: ${label} невалиден: ${parsed.error}`);
  }
  return parsed.iso;
}

interface SeededAgents {
  readonly agents: Readonly<Record<string, AgentState>>;
  readonly prngStreamPositions: Readonly<Record<string, number>>;
}

/**
 * Стартовая локация каждого агента выбирается одним draw на стабильном stream key `agent:<id>`
 * (A7: "поток случайности... разделён по stable stream key"). Один draw на агента — намеренно
 * минимально: I01 не моделирует ничего сверх "какой мир получился при этом seed" (PLAN §5, out
 * of scope: Utility AI, планы, экономика).
 */
function seedAgents(content: GeneratorContent, seed: number, worldTime: string): SeededAgents {
  const random = new DeterministicRandomSource(seed);
  const agents: Record<string, AgentState> = {};
  const prngStreamPositions: Record<string, number> = {};

  if (content.locations.length === 0) {
    throw new Error(`world: контент "${content.worldId}" не содержит ни одной локации`);
  }

  for (const agentDef of content.agents) {
    const streamKey = agentDef.id;
    const draw = random.draw(streamKey);
    const index = Math.min(
      Math.floor(draw.value * content.locations.length),
      content.locations.length - 1,
    );
    const location = content.locations[index]!;
    agents[agentDef.id] = {
      id: agentDef.id,
      locationId: location.id,
      status: 'idle',
      routeId: null,
      // Свежий мир начинается с сытых и отдохнувших агентов: момент отсчёта каждой нужды равен
      // стартовому времени мира. Иное значение было бы утверждением об истории, которой не было.
      needBaseline: Object.fromEntries(NEED_KINDS.map((need) => [need, worldTime])) as Record<
        NeedKind,
        string
      >,
      // Решений свежий мир ещё не принимал. Праздность здесь — не умолчание «на всякий случай»,
      // а тот же исход, который дал бы первый вызов выбора для спокойного тела.
      goal: 'idle',
      planId: null,
    };
    // `drawIndex` внутри потока начинается с 0 (RandomDraw); позиция после одного draw — 1.
    prngStreamPositions[streamKey] = draw.drawIndex + 1;
  }

  return { agents, prngStreamPositions };
}

/**
 * Предметы стартового мира. Владелец берётся из контента и НЕ проверяется на существование
 * здесь: генератор не знает правил мира, а несуществующий владелец упрётся во внешний ключ
 * `items -> agents` при записи — то есть в проверку, которую нельзя обойти забывчивостью.
 */
function buildItems(content: GeneratorContent): Readonly<Record<string, ItemState>> {
  const items: Record<string, ItemState> = {};
  for (const item of content.items) {
    items[item.id] = { id: item.id, kind: item.kind, ownerId: item.ownerId };
  }
  return items;
}

function buildRoutes(content: GeneratorContent): Readonly<Record<string, DomainRouteDefinition>> {
  const routes: Record<string, DomainRouteDefinition> = {};
  for (const route of content.routes) {
    routes[route.id] = {
      id: route.id,
      fromLocationId: route.fromLocationId,
      toLocationId: route.toLocationId,
      travelMinutes: route.travelMinutes,
    };
  }
  return routes;
}

/**
 * `bundles` ровно одного снимка — рефы правил/контента/схем. Вынесено из `seedWorld` (I02B):
 * `world snapshot`/`world replay` строят снимок/контекст чтения снимка НЕ через `seedWorld` (тот
 * порождает свежий мир, а не работает с уже существующим durable-миром), но им нужны ТЕ ЖЕ
 * bundles — CLI работает с одним неизменным content bundle (`PROTOTYPE_WORLD`) и одним rules
 * bundle (`testRulesetVersions()`) везде. Общая функция — единственный источник этих значений,
 * а не три места, которым предстоит разойтись.
 */
export function bundlesFor(
  content: GeneratorContent,
  contentVersion: string,
  // Умолчания НЕТ намеренно: пока оно было, два вызывающих подставляли разные версии, и
  // расхождение проявлялось не здесь, а падением проверки checksum снимка в третьем месте.
  ruleset: Ruleset,
): Snapshot['bundles'] {
  return {
    rules: bundleRefFor(ruleset.versions.rulesVersion, rulesBundleContent(ruleset)),
    content: bundleRefFor(contentVersion, content),
    // Содержимое — сами JSON Schema документы, версия и состав принадлежат контрактам
    // (`schema-bundle.ts`): bundle схем — их артефакт, а не CLI (M3, A9).
    schema: schemaBundleRef(),
  };
}

/**
 * `deterministic_runtime_profile` ровно одного снимка. Вынесено по тому же доводу, что
 * {@link currentBundles}: `world snapshot` строит НОВЫЙ профиль для снимка durable-мира, которого
 * `seedWorld` не строил (он строит только in-memory снимок свежепорождённого мира).
 */
export function deterministicRuntimeProfileFor(
  host: HostRuntimeProfile,
): DeterministicRuntimeProfile {
  return {
    canonical_serialization_version: CANONICAL_SERIALIZATION_VERSION,
    snapshot_checksum_scope_version: SNAPSHOT_CHECKSUM_SCOPE_VERSION,
    prng_version: PRNG_VERSION,
    numeric_rounding_policy_version: NUMERIC_ROUNDING_POLICY_VERSION,
    // Node/ICU — профиль машины, а не канонических правил: он записывается в снимок, но в
    // checksum не входит (B2) и проверяется `verifyRuntimeProfileCompatibility`.
    node_version: host.nodeVersion,
    icu_version: host.icuVersion,
    // В отличие от node/icu — это НЕ чтение окружения хоста, а фиксированное свойство
    // канонического мира (world time всегда UTC); литерал, а не `Intl`/`process.env.TZ`.
    timezone: CANONICAL_TIMEZONE,
    // Как и timezone — свойство канонического ядра, а не машины: уровень изоляции задан
    // явно в транзакции и не наследуется от настроек сервера (ADR-010 §10.1).
    transaction_isolation_level: CANONICAL_TRANSACTION_ISOLATION_LEVEL,
  };
}

export interface SeededWorld {
  readonly seed: number;
  readonly content: GeneratorContent;
  readonly state: WorldState;
  readonly snapshot: Snapshot;
}

/**
 * Строит детерминированный in-memory мир из seed и `@zona/content` fixtures. Тот же seed даёт
 * побайтово тот же `snapshot` в любом процессе (A1); разный seed даёт другой, но валидный мир
 * (A2), потому что различается ТОЛЬКО распределение агентов по локациям.
 */
export function seedWorld(
  content: GeneratorContent,
  contentVersion: string,
  seed: number,
  host: HostRuntimeProfile,
  ruleset: Ruleset,
): SeededWorld {
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`world: seed обязан быть безопасным целым, получено ${String(seed)}`);
  }

  const clock = new FixedClock(content.initialWorldTime);
  const worldTime = canonicalInstant(clock.now().iso, 'initialWorldTime контента');

  const { agents, prngStreamPositions } = seedAgents(content, seed, worldTime);
  const routes = buildRoutes(content);

  const state: WorldState = {
    worldId: content.worldId,
    worldVersion: 0,
    worldTime,
    sequence: 0,
    agents,
    routes,
    items: buildItems(content),
    // Расписание свежего мира НЕ пусто, и это исключение названо явно.
    //
    // Общее правило прежнее: расписание выводится из событий (`evolve`). Нужды его нарушают в
    // единственной точке — самой первой. Голод начинается не с события, а с существования
    // агента: событий у нового мира нет вовсе, а первое пересечение порога обязано быть
    // запланировано, иначе оно не наступит никогда и мир останется вечно сытым.
    //
    // Дальше правило действует без изъятий: каждое следующее пересечение планирует `evolve` по
    // факту предыдущего. Replay это не ломает — он начинается со СНИМКА, а расписание входит в
    // снимок и покрыто его checksum.
    scheduledActions: initialNeedSchedule(agents, ruleset),
  };

  const snapshotWithoutChecksum: Omit<Snapshot, 'checksum'> = {
    world_id: content.worldId,
    last_sequence: 0,
    world_time: worldTime,
    // Нет независимого источника wall clock у in-memory CLI без БД (см. заголовок файла) —
    // created_at делит момент с world_time, а не притворяется настоящими часами.
    created_at: worldTime,
    bundles: bundlesFor(content, contentVersion, ruleset),
    deterministic_runtime_profile: deterministicRuntimeProfileFor(host),
    prng_stream_positions: prngStreamPositions,
    canonical_state: state,
  };

  const snapshot: Snapshot = {
    ...snapshotWithoutChecksum,
    checksum: snapshotChecksum(snapshotWithoutChecksum),
  };

  return { seed, content, state, snapshot };
}

/**
 * Первые пересечения порогов для всех агентов свежего мира.
 *
 * Момент считается той же функцией, что и все последующие (`nextThresholdCrossing`), — второго
 * способа вычислить порог в проекте нет и быть не должно: разойдясь, они дали бы мир, где
 * первое событие голода наступает не тогда, когда голод достигает порога.
 */
function initialNeedSchedule(
  agents: Readonly<Record<string, AgentState>>,
  ruleset: Ruleset,
): Readonly<Record<string, ScheduledAction>> {
  const scheduled: Record<string, ScheduledAction> = {};
  for (const agent of Object.values(agents)) {
    for (const need of NEED_KINDS) {
      const crossing = nextThresholdCrossing(
        agent.needBaseline[need],
        'normal',
        ruleset.needs[need],
      );
      if (crossing === null) continue;
      const action: NeedThresholdAction = {
        id: needThresholdActionId(agent.id, need, crossing.at),
        kind: 'need.threshold',
        dueAt: crossing.at,
        priority: SCHEDULED_ACTION_PRIORITY['need.threshold'],
        entityId: agent.id,
        need,
        toLevel: crossing.level,
      };
      scheduled[action.id] = action;
    }
  }
  return scheduled;
}
