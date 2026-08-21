/**
 * apps/cli — builds an in-memory, deterministic `Snapshot` from a seed and `@zona/content`
 * fixtures (I01 PLAN §2/§6, ACCEPTANCE A1/A2/A3/A9/A10).
 *
 * No database, no event log: I01 doesn't run `decide`/`evolve` here — "мир пока не живёт:
 * событий во времени нет" (PLAN §2). "Seeding" means picking each agent's starting location
 * deterministically from `seed` via the domain's `RandomSource` port; that is the ONLY thing
 * that varies between two seeds of the same content (ACCEPTANCE A2: "разный seed даёт другой,
 * но валидный мир"). Everything content-derived (bundles, locations, routes, agent roster) is
 * identical across seeds by construction — content is an immutable bundle, not something a seed
 * regenerates.
 *
 * `world_time`/`created_at` both come from the content-defined genesis instant via `FixedClock`,
 * never from a real wall clock: A1 demands byte-identical output across 100 separate OS
 * processes, and A3 demands it across different `TZ`/`LC_ALL`. Reading `Date.now()` anywhere in
 * this file would break both on the first run. `created_at` reuses the same instant as
 * `world_time` because there is no other deterministic-safe wall-clock stand-in available to an
 * in-memory, no-persistence CLI demo (see the I01-T4 handoff for the full reasoning).
 */
import {
  type Snapshot,
  CANONICAL_SERIALIZATION_VERSION,
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
  testRulesetVersions,
  type AgentState,
  type RouteDefinition as DomainRouteDefinition,
  type RulesetVersions,
  type WorldState,
} from '@zona/domain';
import { CONTENT_VERSION, PROTOTYPE_WORLD, type WorldDefinition } from '@zona/content';

/** Наш PRNG — не самостоятельный источник истины (это `@zona/domain`); версия здесь описывает
 *  сам алгоритм для deterministic runtime profile (§9), см. `random-source.ts` в domain. */
const PRNG_VERSION = 'mulberry32+splitmix32/1';

const NUMERIC_ROUNDING_POLICY_VERSION = 'numeric-units/1';

/** Каноническое время мира всегда UTC независимо от `TZ` хоста (A3) — это НЕ профиль хоста, а
 *  фиксированное свойство канонического ядра, поэтому литерал, а не чтение окружения. */
const CANONICAL_TIMEZONE = 'UTC';

/**
 * Профиль ХОСТА: единственная часть deterministic runtime profile, которая описывает машину, а
 * не канонические правила. Инъектируется, а не читается напрямую, ровно по одной причине: после
 * B2 профиль не входит в snapshot checksum, и это свойство обязано быть ПРОВЕРЯЕМЫМ — тест
 * подставляет чужой хост и убеждается, что checksum не сдвинулся. Без инъекции такая проверка
 * потребовала бы второй машины, то есть не выполнялась бы никогда.
 */
export interface HostRuntimeProfile {
  readonly nodeVersion: string;
  readonly icuVersion: string;
}

/** Профиль текущего процесса. Node/ICU одинаковы в рамках хоста независимо от TZ/LC_ALL (A3). */
export function currentHostRuntimeProfile(): HostRuntimeProfile {
  return {
    nodeVersion: process.version.replace(/^v/, ''),
    icuVersion: process.versions['icu'] ?? 'unavailable',
  };
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
export function rulesBundleContent(
  versions: RulesetVersions = testRulesetVersions(),
): Record<string, unknown> {
  return { versions: { ...versions } };
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
function seedAgents(content: WorldDefinition, seed: number): SeededAgents {
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
    };
    // `drawIndex` внутри потока начинается с 0 (RandomDraw); позиция после одного draw — 1.
    prngStreamPositions[streamKey] = draw.drawIndex + 1;
  }

  return { agents, prngStreamPositions };
}

function buildRoutes(content: WorldDefinition): Readonly<Record<string, DomainRouteDefinition>> {
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

export interface SeededWorld {
  readonly seed: number;
  readonly content: WorldDefinition;
  readonly state: WorldState;
  readonly snapshot: Snapshot;
}

/**
 * Строит детерминированный in-memory мир из seed и `@zona/content` fixtures. Тот же seed даёт
 * побайтово тот же `snapshot` в любом процессе (A1); разный seed даёт другой, но валидный мир
 * (A2), потому что различается ТОЛЬКО распределение агентов по локациям.
 */
export function seedWorld(
  seed: number,
  host: HostRuntimeProfile = currentHostRuntimeProfile(),
): SeededWorld {
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`world: seed обязан быть безопасным целым, получено ${String(seed)}`);
  }

  const content = PROTOTYPE_WORLD;
  const clock = new FixedClock(content.initialWorldTime);
  const worldTime = canonicalInstant(clock.now().iso, 'initialWorldTime контента');

  const { agents, prngStreamPositions } = seedAgents(content, seed);
  const routes = buildRoutes(content);

  const state: WorldState = {
    worldId: content.worldId,
    worldVersion: 0,
    worldTime,
    sequence: 0,
    agents,
    routes,
  };

  const rulesetVersions = testRulesetVersions();

  const snapshotWithoutChecksum: Omit<Snapshot, 'checksum'> = {
    world_id: content.worldId,
    last_sequence: 0,
    world_time: worldTime,
    // Нет независимого источника wall clock у in-memory CLI без БД (см. заголовок файла) —
    // created_at делит момент с world_time, а не притворяется настоящими часами.
    created_at: worldTime,
    bundles: {
      rules: bundleRefFor(rulesetVersions.rulesVersion, rulesBundleContent(rulesetVersions)),
      content: bundleRefFor(CONTENT_VERSION, content),
      // Содержимое — сами JSON Schema документы, версия и состав принадлежат контрактам
      // (`schema-bundle.ts`): bundle схем — их артефакт, а не CLI (M3, A9).
      schema: schemaBundleRef(),
    },
    deterministic_runtime_profile: {
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
    },
    prng_stream_positions: prngStreamPositions,
    canonical_state: state,
  };

  const snapshot: Snapshot = {
    ...snapshotWithoutChecksum,
    checksum: snapshotChecksum(snapshotWithoutChecksum),
  };

  return { seed, content, state, snapshot };
}
