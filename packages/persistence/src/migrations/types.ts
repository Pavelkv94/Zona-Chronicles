import type { Kysely } from 'kysely';
import type { Database } from '../database.ts';

/**
 * Фаза миграции по expand → migrate/backfill → contract (§12 03_TECHNICAL_DESIGN.md).
 * `expand` — добавляет новое, ничего не ломает для старого reader/writer;
 * `backfill` — переносит/пересчитывает данные под новую схему;
 * `contract` — destructive-шаг (удаляет старую колонку/таблицу/constraint).
 * Runner запрещает применять `contract` в одном прогоне вместе с `expand`
 * той же поставки — см. `MigrationPhaseConflictError`.
 */
export type MigrationPhase = 'expand' | 'backfill' | 'contract';

/**
 * Контракт одной миграции. `id` — сортируемый префикс (`0001`, `0002`, ...),
 * задающий порядок применения. Реестр (`migrations/index.ts`) — явный
 * упорядоченный массив, а не сканирование каталога.
 *
 * `statements` — явный, стабильный текст SQL, который фактически применяет
 * `up`. Checksum журнала (`computeChecksum`) считается от `statements`, а не
 * от кода `up`, потому что текст функции меняется при смене версии
 * TypeScript/транспайлера/минификатора — это дало бы ложный
 * `MIGRATION_CHECKSUM_MISMATCH` на непотронутой миграции.
 */
export interface Migration {
  readonly id: string;
  readonly name: string;
  readonly phase: MigrationPhase;
  readonly statements: readonly string[];
  up(db: Kysely<Database>): Promise<void>;
}
