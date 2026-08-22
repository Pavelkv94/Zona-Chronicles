/**
 * Общая обвязка интеграционных тестов I02A: одноразовая база + применённые миграции.
 *
 * Миграции применяет ОБЩИЙ runner (`migration-runner.ts`, I00) — тот же, что в проде, с
 * журналом, checksum-проверкой и advisory-локом. Отдельного «тестового» пути применения схемы
 * нет намеренно: тест, который создаёт схему иначе, чем прод, доказывает не ту схему.
 */
import {
  createDatabase,
  parseDatabaseConnectionUrl,
  type DatabaseConnection,
} from '../database.ts';
import { migrations } from '../migrations/index.ts';
import { runMigrations, type Logger } from '../migration-runner.ts';
import { createTestDatabase, type TestDatabase } from './test-database.ts';

const SILENT_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export interface MigratedDatabase {
  readonly testDb: TestDatabase;
  readonly db: DatabaseConnection;
  readonly close: () => Promise<void>;
}

export const createMigratedDatabase = async (
  label: string,
  maxConnections = 8,
): Promise<MigratedDatabase> => {
  const testDb = await createTestDatabase(label);
  const db = createDatabase({
    ...parseDatabaseConnectionUrl(testDb.url),
    maxConnections,
  });
  await runMigrations({ db, migrations, logger: SILENT_LOGGER });
  return {
    testDb,
    db,
    close: async () => {
      await db.destroy();
      await testDb.drop();
    },
  };
};

/** Очищает данные, не трогая схему: порядок обратный зависимостям внешних ключей. */
export const truncateWorldData = async (db: DatabaseConnection): Promise<void> => {
  await db.deleteFrom('outbox').execute();
  await db.deleteFrom('command_results').execute();
  await db.deleteFrom('world_events').execute();
  await db.deleteFrom('agents').execute();
  await db.deleteFrom('routes').execute();
  await db.deleteFrom('locations').execute();
  await db.deleteFrom('worlds').execute();
};
