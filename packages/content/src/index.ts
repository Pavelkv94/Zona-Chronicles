/**
 * @zona/content — скелет пакета, созданный в I00.
 *
 * Versioned world data и asset manifest появляются вместе с fixtures.
 * Границы пакета исполняются `pnpm boundaries:check` (ADR-002), а не соглашением.
 */
export const PACKAGE_NAME = '@zona/content' as const;

/** Итерация `10_ITERATION_MASTER_PLAN`, вводящая содержимое пакета. */
export const OWNING_ITERATION = 'I03' as const;
