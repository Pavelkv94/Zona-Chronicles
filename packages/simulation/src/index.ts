/**
 * @zona/simulation — скелет пакета, созданный в I00.
 *
 * Scheduler, PRNG streams и Utility AI появляются начиная с I02B.
 * Границы пакета исполняются `pnpm boundaries:check` (ADR-002), а не соглашением.
 */
export const PACKAGE_NAME = '@zona/simulation' as const;

/** Итерация `10_ITERATION_MASTER_PLAN`, вводящая содержимое пакета. */
export const OWNING_ITERATION = 'I02B' as const;
