/**
 * @zona/projections — скелет пакета, созданный в I00.
 *
 * Read models карты/эфира/летописи появляются в I03.
 * Границы пакета исполняются `pnpm boundaries:check` (ADR-002), а не соглашением.
 */
export const PACKAGE_NAME = '@zona/projections' as const;

/** Итерация `10_ITERATION_MASTER_PLAN`, вводящая содержимое пакета. */
export const OWNING_ITERATION = 'I03' as const;
