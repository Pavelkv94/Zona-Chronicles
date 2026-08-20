import { sql } from 'kysely';
import type { Migration } from './types.ts';

/**
 * Baseline-миграция (I00-T04, A5). Создаёт ТОЛЬКО журнал миграций и включает
 * расширение `postgis` — этого достаточно, чтобы доказать, что pipeline и
 * образ БД (`postgis/postgis:17-3.5`) пригодны для будущей геометрии. Доменные
 * таблицы мира (`world_events`, `agents`, ...) добавляются в I02A.
 */
export const bootstrapMigration: Migration = {
  id: '0001',
  name: 'bootstrap',
  async up(db) {
    await sql`create extension if not exists postgis`.execute(db);

    await db.schema
      .createTable('schema_migrations')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('checksum', 'text', (col) => col.notNull())
      .addColumn('applied_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('duration_ms', 'integer', (col) => col.notNull())
      .execute();
  },
};
