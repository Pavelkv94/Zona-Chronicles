/**
 * Сборщик observer projection (I03, D6/D7).
 *
 * Живёт в worker-е, а не в `packages/projections`, ровно по одной причине: он читает КАНОНИЧЕСКИЙ
 * outbox. Пакет проекций этого делать не имеет права — от него зависит `apps/api`, и запрет на
 * доступ observer-пути к каноническому хранилищу транзитивен. Здесь же обе стороны сходятся
 * законно: worker и так канонический процесс.
 *
 * ## Ровно один раз на событие
 *
 * Курсор проекции (`projection_state.last_event_sequence`) — её собственная позиция, и она
 * продвигается В ТОЙ ЖЕ ТРАНЗАКЦИИ, что записи ленты (`saveProjectionStep`). Отсюда D6: убитый
 * посреди работы сборщик при следующем запуске догоняет с последней ЗАФИКСИРОВАННОЙ позиции —
 * без пропусков (курсор не обгонял ленту) и без дублей (лента не обгоняла курсор).
 *
 * `published_at` в outbox не трогается: подписчиков будет больше одного, и отметка «доставлено» в
 * общей таблице означала бы, что первый закрывает событие для всех.
 */
import {
  loadOutboxEventsAfter,
  loadWorldContent,
  loadWorldState,
  type DatabaseConnection,
} from '@zona/persistence';
import {
  applyObserverEvent,
  initialObserverProjection,
  initializeProjection,
  loadProjectionCursor,
  resetProjection,
  saveProjectionStep,
  type ObserverProjectionState,
  type ProjectionDatabase,
} from '@zona/projections';
import type { ObserverEvent } from '@zona/contracts';

/** Сколько событий забирается за один шаг. Догон старого мира идёт пачками, а не одним запросом. */
const DEFAULT_BATCH_SIZE = 200;

export interface ProjectionBuilderDeps {
  /** Канонический доступ: только чтение outbox и статического контента мира. */
  readonly canonical: DatabaseConnection;
  /** Хранилище проекции: сюда пишется результат. */
  readonly projection: ProjectionDatabase;
  readonly worldId: string;
  readonly now: () => Date;
  readonly batchSize?: number;
  readonly logger?: {
    readonly info: (fields: Record<string, unknown>, msg: string) => void;
  };
}

/**
 * Начальное состояние мира: агенты там, где их расставил генезис.
 *
 * Проекция ВСЕГДА начинается с генезиса и сворачивает весь журнал. Первая редакция засеивала её
 * ТЕКУЩИМ состоянием мира с курсором на текущей sequence — и это было ошибкой, которую нашёл
 * собственный тест D7: лента такого мира начиналась пустой, пересборка сворачивала ноль событий,
 * и критерий «пересборка даёт тот же результат» выполнялся тождественно, ничего не проверяя.
 *
 * Расстановку агентов нельзя вывести из журнала: её сделал `initializeWorld` в обход событий (тот
 * же довод записан в `replay.ts`). Поэтому её передаёт вызывающий — CLI, у которого есть
 * `seedWorld(seed)`, тот же источник, из которого мир и был создан.
 */
export interface ProjectionGenesis {
  readonly worldTime: string;
  readonly agents: readonly {
    readonly agent_id: string;
    readonly name: string;
    readonly location_id: string | null;
    readonly status: 'idle' | 'traveling';
    readonly route_id: string | null;
  }[];
}

const mapNodes = (
  locations: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  }[],
) =>
  locations.map((location) => ({
    location_id: location.id,
    name: location.name,
    description: location.description,
  }));

const mapEdges = (
  routes: readonly {
    readonly id: string;
    readonly fromLocationId: string;
    readonly toLocationId: string;
    readonly travelMinutes: number;
  }[],
) =>
  routes.map((route) => ({
    route_id: route.id,
    from_location_id: route.fromLocationId,
    to_location_id: route.toLocationId,
    travel_minutes: route.travelMinutes,
  }));

/** Карта мира для seed проекции: локации из контента, маршруты из состояния. */
const loadMap = async (deps: ProjectionBuilderDeps) => {
  const [state, content] = await Promise.all([
    loadWorldState(deps.canonical, deps.worldId),
    loadWorldContent(deps.canonical, deps.worldId),
  ]);
  if (state === null) {
    throw new Error(
      `projection-builder: мир ${deps.worldId} не создан — собирать проекцию не из чего`,
    );
  }
  return { nodes: mapNodes(content.locations), edges: mapEdges(Object.values(state.routes)) };
};

/**
 * Создаёт проекцию мира в состоянии ГЕНЕЗИСА, с нулевым курсором.
 *
 * Вызывается один раз, при создании мира. Дальше проекция только догоняет журнал — и потому
 * инкрементальная сборка и пересборка идут по одному и тому же пути, а не по двум похожим.
 */
export const createProjectionAtGenesis = async (
  deps: ProjectionBuilderDeps,
  genesis: ProjectionGenesis,
): Promise<void> => {
  const map = await loadMap(deps);
  const fresh = initialObserverProjection({
    worldId: deps.worldId,
    worldTime: genesis.worldTime,
    nodes: map.nodes,
    edges: map.edges,
    agents: genesis.agents,
  });
  await initializeProjection(deps.projection, fresh, map, deps.now());
  deps.logger?.info({ worldId: deps.worldId }, 'projection.created');
};

/**
 * Восстанавливает состояние свёртки из уже записанной проекции.
 *
 * Читается из проекции, а не пересобирается из журнала: проекция и есть материализованное
 * состояние, и повторный проход по журналу при каждом запуске сборщика сделал бы старт мира
 * линейным по его возрасту.
 */
const currentFoldState = async (
  deps: ProjectionBuilderDeps,
  cursor: { projectionSequence: number; lastEventSequence: number; worldTime: string },
): Promise<ObserverProjectionState> => {
  const rows = await deps.projection
    .selectFrom('projection_agents')
    .selectAll()
    .where('world_id', '=', deps.worldId)
    .execute();

  const agents = Object.fromEntries(
    rows.map((row) => [
      row.agent_id,
      {
        agent_id: row.agent_id,
        name: row.name,
        location_id: row.location_id,
        status: row.status === 'traveling' ? ('traveling' as const) : ('idle' as const),
        route_id: row.route_id,
      },
    ]),
  );

  return {
    worldId: deps.worldId,
    projectionSequence: cursor.projectionSequence,
    lastEventSequence: cursor.lastEventSequence,
    worldTime: cursor.worldTime,
    // Карта неизменна в рамках мира и в свёртке не участвует — она нужна только для seed.
    nodes: {},
    edges: {},
    agents,
  };
};

export interface ProjectionStepResult {
  readonly applied: number;
  readonly projectionSequence: number;
}

/** Один шаг догона: забрать пачку событий, свернуть, записать атомарно. */
export const runProjectionStep = async (
  deps: ProjectionBuilderDeps,
): Promise<ProjectionStepResult> => {
  const cursor = await loadProjectionCursor(deps.projection, deps.worldId);
  if (cursor === null) {
    // Молча создать проекцию здесь было бы удобно и неверно: сборщик не знает генезиса (агентов
    // расставил `initializeWorld` в обход событий), и «создал бы» её из текущего состояния — то
    // есть с пустой лентой и историей, которой уже не восстановить.
    throw new Error(
      `projection-builder: проекции мира ${deps.worldId} не существует. Она создаётся вместе с ` +
        'миром ("world init") либо пересобирается явно ("world projection rebuild"): сборщик не ' +
        'знает начальной расстановки агентов и придумать её не имеет права.',
    );
  }
  let state = await currentFoldState(deps, cursor);

  const events = await loadOutboxEventsAfter(
    deps.canonical,
    deps.worldId,
    state.lastEventSequence,
    deps.batchSize ?? DEFAULT_BATCH_SIZE,
  );
  if (events.length === 0) {
    return { applied: 0, projectionSequence: state.projectionSequence };
  }

  const emitted: ObserverEvent[] = [];
  for (const event of events) {
    const result = applyObserverEvent(state, event);
    state = result.state;
    emitted.push(result.emitted);
  }

  await saveProjectionStep(deps.projection, state, emitted, deps.now());
  deps.logger?.info(
    {
      worldId: deps.worldId,
      applied: emitted.length,
      projectionSequence: state.projectionSequence,
    },
    'projection.advanced',
  );
  return { applied: emitted.length, projectionSequence: state.projectionSequence };
};

/**
 * Пересборка проекции с нуля (D7).
 *
 * Стирает и собирает заново из журнала — единственный поддерживаемый способ починки. Правка строк
 * «чтобы стало правильно» создала бы состояние, не выводимое из журнала, и следующая пересборка
 * молча его отменила бы.
 *
 * Seed берётся из НАЧАЛЬНОГО состояния мира, а не из текущего: пересборка обязана пройти весь
 * журнал, иначе она проверяет не то. Начальное состояние восстанавливается тем же путём, что в
 * `world replay` — из snapshot-а на sequence 0 либо из seed мира.
 */
/**
 * Пересборка проекции с нуля (D7).
 *
 * Стирает и собирает заново из журнала — единственный поддерживаемый способ починки. Правка строк
 * «чтобы стало правильно» создала бы состояние, не выводимое из журнала, и следующая пересборка
 * молча его отменила бы.
 *
 * Идёт ТЕМ ЖЕ путём, что инкрементальная сборка: генезис плюс `runProjectionStep` до исчерпания.
 * Второй, «специальный» путь пересборки означал бы, что D7 сравнивает две разные реализации, а не
 * проверяет одну.
 */
export const rebuildProjection = async (
  deps: ProjectionBuilderDeps,
  genesis: ProjectionGenesis,
): Promise<ProjectionStepResult> => {
  await resetProjection(deps.projection, deps.worldId);
  await createProjectionAtGenesis(deps, genesis);

  let applied = 0;
  let sequence = 0;
  for (;;) {
    const step = await runProjectionStep(deps);
    if (step.applied === 0) break;
    applied += step.applied;
    sequence = step.projectionSequence;
  }
  deps.logger?.info({ worldId: deps.worldId, applied }, 'projection.rebuilt');
  return { applied, projectionSequence: sequence };
};
