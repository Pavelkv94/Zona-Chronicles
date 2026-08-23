/**
 * @zona/projections — скелет пакета, созданный в I00.
 *
 * Свёртка канонического журнала в observer projection (I03) — `observer-fold.ts`. Пакет НЕ
 * зависит от `@zona/persistence` и не имеет права зависеть: `apps/api` зависит от проекций, а
 * запрет на доступ observer-пути к каноническому хранилищу транзитивен.
 * Границы пакета исполняются `pnpm boundaries:check` (ADR-002), а не соглашением.
 */
export const PACKAGE_NAME = '@zona/projections' as const;

/** Итерация `10_ITERATION_MASTER_PLAN`, вводящая содержимое пакета. */
export const OWNING_ITERATION = 'I03' as const;

export type {
  ObserverFoldResult,
  ObserverProjectionSeed,
  ObserverProjectionState,
} from './observer-fold.ts';
export { applyObserverEvent, initialObserverProjection } from './observer-fold.ts';

export type {
  ProjectionDatabase,
  ProjectionDatabaseConfig,
  ProjectionSchema,
} from './projection-database.ts';
export { createProjectionDatabase, parseProjectionDatabaseUrl } from './projection-database.ts';

export type { ObserverEventPage, ProjectionCursor } from './projection-store.ts';
export {
  initializeProjection,
  loadObserverEvents,
  loadObserverSnapshot,
  loadProjectionCursor,
  resetProjection,
  saveProjectionStep,
} from './projection-store.ts';
