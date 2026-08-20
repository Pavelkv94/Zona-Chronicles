/**
 * @zona/testkit — скелет пакета, созданный в I00.
 *
 * Builders, arbitraries и fake ports появляются в I01.
 * Границы пакета исполняются `pnpm boundaries:check` (ADR-002), а не соглашением.
 */
export const PACKAGE_NAME = '@zona/testkit' as const;

/** Итерация `10_ITERATION_MASTER_PLAN`, вводящая содержимое пакета. */
export const OWNING_ITERATION = 'I01' as const;
