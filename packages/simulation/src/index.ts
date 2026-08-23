/**
 * @zona/simulation — скелет пакета, созданный в I00.
 *
 * Порождение мира из seed — `world-generation.ts` (I03). Utility AI и планирование появятся
 * позже; scheduler живёт в persistence, потому что он про транзакции, а не про правила.
 * Границы пакета исполняются `pnpm boundaries:check` (ADR-002), а не соглашением.
 */
export const PACKAGE_NAME = '@zona/simulation' as const;

/** Итерация `10_ITERATION_MASTER_PLAN`, вводящая содержимое пакета. */
export const OWNING_ITERATION = 'I03' as const;

export type { GeneratorContent, HostRuntimeProfile, SeededWorld } from './world-generation.ts';
export {
  bundlesFor,
  deterministicRuntimeProfileFor,
  rulesBundleContent,
  seedWorld,
} from './world-generation.ts';
