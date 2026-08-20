import type { Kysely } from 'kysely';
import type { Database } from '../database.ts';

/**
 * Контракт одной миграции. `id` — сортируемый префикс (`0001`, `0002`, ...),
 * задающий порядок применения. Реестр (`migrations/index.ts`) — явный
 * упорядоченный массив, а не сканирование каталога.
 */
export interface Migration {
  readonly id: string;
  readonly name: string;
  up(db: Kysely<Database>): Promise<void>;
}
