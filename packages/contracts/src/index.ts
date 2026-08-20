/**
 * @zona/contracts — скелет пакета, созданный в I00.
 *
 * Runtime-схемы и envelopes команд/событий v1 появляются в I01.
 * Границы пакета исполняются `pnpm boundaries:check` (ADR-002), а не соглашением.
 */
export const PACKAGE_NAME = '@zona/contracts' as const;

/** Итерация `10_ITERATION_MASTER_PLAN`, вводящая содержимое пакета. */
export const OWNING_ITERATION = 'I01' as const;
