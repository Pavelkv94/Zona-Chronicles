/**
 * Свёртка канонического журнала в observer projection (I03).
 *
 * ## Это ЧИСТАЯ функция, и это не стилистика
 *
 * Пакет не импортирует ни `@zona/persistence`, ни драйвер БД, и не может: `apps/api` зависит от
 * проекций, а правило `observer-api-does-not-reach-persistence` в `.dependency-cruiser.cjs`
 * ТРАНЗИТИВНО запрещает observer-пути дотягиваться до канонического хранилища. Один импорт здесь
 * молча снял бы запрет для всего API. Поэтому чтение журнала и запись проекции живут снаружи, а
 * здесь — только преобразование.
 *
 * ## Проекция ПРИМЕНЯЕТ записанные факты, а не решает заново
 *
 * Тот же довод, что у replay (C10). Место прибытия берётся из `location_id` события, а не
 * вычисляется по маршруту: маршрут мог измениться в контенте после того, как путь был пройден, и
 * тогда пересборка проекции показала бы агента там, где он никогда не был. Событие — источник
 * факта; всё, что можно взять из него, берётся из него.
 *
 * ## Лента не накапливается в состоянии
 *
 * `applyObserverEvent` возвращает ОДНУ порождённую запись ленты, а не растущий массив. Состояние
 * проекции ограничено размером мира (узлы, рёбра, агенты), а лента ограничена только его
 * возрастом; держать её в памяти означало бы, что сборщик однажды перестанет запускаться на
 * старом мире — и заметить это можно было бы только там, где чинить дороже всего.
 */
import type {
  ObserverAgent,
  ObserverEvent,
  ObserverMapEdge,
  ObserverMapNode,
  WorldEvent,
} from '@zona/contracts';

export interface ObserverProjectionState {
  readonly worldId: string;
  /** Курсор ленты: сколько записей проекция уже породила. 0 — ни одной. */
  readonly projectionSequence: number;
  /** Докуда применён журнал. Нужен, чтобы догон после перезапуска шёл ровно один раз (D6). */
  readonly lastEventSequence: number;
  readonly worldTime: string;
  readonly nodes: Readonly<Record<string, ObserverMapNode>>;
  readonly edges: Readonly<Record<string, ObserverMapEdge>>;
  readonly agents: Readonly<Record<string, ObserverAgent>>;
}

/** Карта и агенты на момент создания мира: они приходят не из событий, а из `initializeWorld`. */
export interface ObserverProjectionSeed {
  readonly worldId: string;
  readonly worldTime: string;
  readonly nodes: readonly ObserverMapNode[];
  readonly edges: readonly ObserverMapEdge[];
  readonly agents: readonly ObserverAgent[];
}

const indexBy = <T>(items: readonly T[], key: (item: T) => string): Record<string, T> => {
  const result: Record<string, T> = {};
  for (const item of items) result[key(item)] = item;
  return result;
};

export function initialObserverProjection(seed: ObserverProjectionSeed): ObserverProjectionState {
  return {
    worldId: seed.worldId,
    projectionSequence: 0,
    lastEventSequence: 0,
    worldTime: seed.worldTime,
    nodes: indexBy(seed.nodes, (node) => node.location_id),
    edges: indexBy(seed.edges, (edge) => edge.route_id),
    agents: indexBy(seed.agents, (agent) => agent.agent_id),
  };
}

export interface ObserverFoldResult {
  readonly state: ObserverProjectionState;
  /** Запись ленты, порождённая этим событием. */
  readonly emitted: ObserverEvent;
}

const singleActor = (event: WorldEvent): string => {
  const [actorId, ...rest] = event.actor_ids;
  if (actorId === undefined || rest.length > 0) {
    throw new Error(
      `observer-fold: событие ${event.event_id} типа ${event.type} обязано иметь ровно одного ` +
        `актора, получено ${String(event.actor_ids.length)}`,
    );
  }
  return actorId;
};

const requireAgent = (state: ObserverProjectionState, agentId: string, event: WorldEvent) => {
  const agent = state.agents[agentId];
  if (agent === undefined) {
    // Событие уже записано в журнал; отсутствие агента в проекции означает, что проекция собрана
    // не из того мира или её seed неполон. Тихо создать агента здесь значило бы придумать факт.
    throw new Error(
      `observer-fold: событие ${event.event_id} ссылается на агента ${agentId}, которого нет в ` +
        `проекции мира ${state.worldId}. Проекция собрана не из того мира либо её seed неполон.`,
    );
  }
  return agent;
};

/**
 * Применяет одно каноническое событие. Порядок вызовов обязан совпадать с порядком `sequence`:
 * свёртка не сортирует и не проверяет непрерывность — это забота вызывающего, у которого есть
 * журнал целиком (тот же раздел ответственности, что у `replay.ts`).
 */
export function applyObserverEvent(
  state: ObserverProjectionState,
  event: WorldEvent,
): ObserverFoldResult {
  if (event.world_id !== state.worldId) {
    throw new Error(
      `observer-fold: событие ${event.event_id} принадлежит миру ${event.world_id}, а проекция — ` +
        `миру ${state.worldId}`,
    );
  }
  if (event.sequence <= state.lastEventSequence) {
    throw new Error(
      `observer-fold: событие ${event.event_id} с sequence ${String(event.sequence)} уже применено ` +
        `(проекция на ${String(state.lastEventSequence)}). Повторное применение удвоило бы ленту.`,
    );
  }

  const projectionSequence = state.projectionSequence + 1;
  const base = {
    ...state,
    projectionSequence,
    lastEventSequence: event.sequence,
    // Мировое время проекции — время последнего применённого факта. Оно не обгоняет журнал.
    worldTime: event.world_time,
  };

  switch (event.type) {
    case 'journey.started': {
      const actorId = singleActor(event);
      const agent = requireAgent(state, actorId, event);
      return {
        state: {
          ...base,
          agents: {
            ...state.agents,
            [actorId]: {
              ...agent,
              status: 'traveling',
              // В пути агент не находится ни в одной локации: иначе карта показывала бы его
              // одновременно вышедшим и стоящим на месте.
              location_id: null,
              route_id: event.payload.route_id,
            },
          },
        },
        emitted: {
          projection_sequence: projectionSequence,
          event_id: event.event_id,
          world_time: event.world_time,
          type: event.type,
          actor_ids: [...event.actor_ids],
          location_id: event.location_id ?? null,
          route_id: event.payload.route_id,
        },
      };
    }
    case 'journey.completed': {
      const actorId = singleActor(event);
      const agent = requireAgent(state, actorId, event);
      const arrivalLocationId = event.location_id ?? null;
      if (arrivalLocationId === null) {
        throw new Error(
          `observer-fold: journey.completed ${event.event_id} без location_id — место прибытия ` +
            'является фактом события, и вычислять его по маршруту нельзя (контент мог измениться).',
        );
      }
      return {
        state: {
          ...base,
          agents: {
            ...state.agents,
            [actorId]: {
              ...agent,
              status: 'idle',
              location_id: arrivalLocationId,
              route_id: null,
            },
          },
        },
        emitted: {
          projection_sequence: projectionSequence,
          event_id: event.event_id,
          world_time: event.world_time,
          type: event.type,
          actor_ids: [...event.actor_ids],
          location_id: arrivalLocationId,
          route_id: event.payload.route_id,
        },
      };
    }
    case 'plan.invalidated': {
      // Планы вне scope наблюдаемого мира I03, но факт произошёл и обязан быть виден в ленте:
      // «событие есть, а изменения нет» — нормальное состояние, «события нет вовсе» — потеря.
      return {
        state: base,
        emitted: {
          projection_sequence: projectionSequence,
          event_id: event.event_id,
          world_time: event.world_time,
          type: event.type,
          actor_ids: [...event.actor_ids],
          location_id: event.location_id ?? null,
          route_id: null,
        },
      };
    }
    default: {
      // Исчерпывающий union (A8): новый тип события обязан ломать компиляцию здесь, а не
      // молча выпадать из ленты.
      const exhaustive: never = event;
      throw new Error(`observer-fold: неизвестный тип события ${JSON.stringify(exhaustive)}`);
    }
  }
}
