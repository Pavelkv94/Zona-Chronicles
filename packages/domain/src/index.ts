/**
 * @zona/domain — скелет пакета, созданный в I00.
 *
 * decide/evolve, сущности и инварианты появляются в I01.
 * Границы пакета исполняются `pnpm boundaries:check` (ADR-002), а не соглашением.
 */
export const PACKAGE_NAME = '@zona/domain' as const;

/** Итерация `10_ITERATION_MASTER_PLAN`, вводящая содержимое пакета. */
export const OWNING_ITERATION = 'I01' as const;
