import type { Migration } from './types.ts';

/**
 * Явный SQL этой миграции. Держим его как строки, а не как вызовы Kysely
 * schema builder, потому что `computeChecksum` считает checksum журнала от
 * этого текста (см. `migrations/types.ts` и `migration-ledger.ts`) — builder
 * даёт скрытую генерацию SQL, а не стабильный, ревьюируемый текст.
 */
const CREATE_EXTENSION_POSTGIS = `create extension if not exists postgis`;

const CREATE_SCHEMA_MIGRATIONS_TABLE = `
create table schema_migrations (
  id text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now(),
  duration_ms integer not null
)
`;

const statements: readonly string[] = [CREATE_EXTENSION_POSTGIS, CREATE_SCHEMA_MIGRATIONS_TABLE];

/**
 * Baseline-миграция (I00-T04, A5). Создаёт ТОЛЬКО журнал миграций и включает
 * расширение `postgis` — этого достаточно, чтобы доказать, что pipeline и
 * образ БД (`postgis/postgis:17-3.5`) пригодны для будущей геометрии. Доменные
 * таблицы мира (`world_events`, `agents`, ...) добавляются в I02A.
 *
 * `phase: 'expand'` — миграция только добавляет (журнал + extension), ничего
 * не ломает для не существующего пока reader/writer.
 *
 * Никакой `up()` здесь больше нет: общий runner (`migration-runner.ts`)
 * исполняет `statements` по порядку — это и есть то, что фактически
 * применяется, и то, от чего считается checksum (см. `migrations/types.ts`).
 */
export const bootstrapMigration: Migration = {
  id: '0001',
  name: 'bootstrap',
  phase: 'expand',
  statements,
};
