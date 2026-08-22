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
import { applyGrants, ensureApplicationRoles } from '../principals.ts';
import { createTestDatabase, type TestDatabase } from './test-database.ts';

const SILENT_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Пароль application-ролей для локальных тестов.
 *
 * Живёт в ТЕСТОВОЙ фикстуре, а не в поставляемом коде и не в миграции: из миграции он попадал
 * бы в git, в `dist` и в checksum журнала (M-4 аудита I02A). `__fixtures__` исключены из
 * `tsconfig.build.json`, поэтому в артефакт не входят.
 */
export const TEST_ROLE_PASSWORD = 'zona_local_dev_only';

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
  // Роли и гранты — не миграция схемы (см. `principals.ts`): в проде их применяет
  // `world migrate` тем же кодом, поэтому тест обязан идти тем же путём, а не своим.
  await ensureApplicationRoles(db, TEST_ROLE_PASSWORD);
  await applyGrants(db);
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
  await db.deleteFrom('command_attempt_rejections').execute();
  await db.deleteFrom('command_results').execute();
  await db.deleteFrom('world_events').execute();
  await db.deleteFrom('agents').execute();
  await db.deleteFrom('routes').execute();
  await db.deleteFrom('locations').execute();
  await db.deleteFrom('worlds').execute();
};
