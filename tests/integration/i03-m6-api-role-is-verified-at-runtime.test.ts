/**
 * m6 независимого архитектурного аудита I03 — роль подключения observer-пути проверяется в
 * рантайме, а не только грантами и тестами.
 *
 * ## Что доказывают гранты и чего они не доказывают
 *
 * Матрица грантов доказывает, что роль `zona_api` бессильна: `SELECT` только на `projection_*`.
 * Она НЕ доказывает, что API подключился именно ею. Одна опечатка в окружении —
 * `PROJECTION_DATABASE_URL` со значением `DATABASE_URL` — и observer-путь ходит под ролью
 * владельца схемы. Код тот же, тесты те же, гранты те же; D5 нарушен, и ни один контроль этого
 * не замечает, потому что все они проверяют ПРАВА РОЛИ, а не то, какая роль подключена.
 *
 * Проверка спрашивает у самой базы (`has_table_privilege` для текущего подключения), поэтому она
 * отвечает на вопрос, на который конфигурация ответить не может.
 *
 * Импорты относительные — `tests/` не workspace-пакет.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_ROLE_PASSWORD,
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../packages/persistence/src/__fixtures__/migrated-database.ts';
import { ROLE_NAMES } from '../../packages/persistence/src/principals.ts';
import {
  assertObserverRoleIsReadOnly,
  createProjectionDatabase,
  parseProjectionDatabaseUrl,
  type ProjectionDatabase,
} from '../../packages/projections/src/index.ts';

const asRole = (url: string, role: string): string => {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = TEST_ROLE_PASSWORD;
  return parsed.toString();
};

describe('m6 — observer-путь отказывается стартовать под чужой ролью', () => {
  let migrated: MigratedDatabase;
  const opened: ProjectionDatabase[] = [];

  const connect = (url: string): ProjectionDatabase => {
    const db = createProjectionDatabase(parseProjectionDatabaseUrl(url));
    opened.push(db);
    return db;
  };

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i03_m6_api_role');
  }, 120_000);

  afterAll(async () => {
    for (const db of opened) await db.destroy();
    await migrated.close();
  });

  it('под ролью zona_api проверка проходит — она и есть правильная роль', async () => {
    await expect(
      assertObserverRoleIsReadOnly(connect(asRole(migrated.testDb.url, ROLE_NAMES.api))),
    ).resolves.toBeUndefined();
  });

  it('под ролью владельца схемы — НАЗВАННЫЙ отказ с перечислением доступного', async () => {
    const failure = await assertObserverRoleIsReadOnly(connect(migrated.testDb.url)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    // Отказ обязан называть и роль, и таблицы, и вероятную причину: без этого оператор увидит
    // «что-то не так с правами» и пойдёт искать не там.
    expect(String(failure)).toMatch(/world_events/);
    expect(String(failure)).toMatch(/PROJECTION_DATABASE_URL совпал с DATABASE_URL/);
  });

  it('под ролью worker-а — тоже отказ: это ровно тот случай, из-за которого проверка есть', async () => {
    await expect(
      assertObserverRoleIsReadOnly(connect(asRole(migrated.testDb.url, ROLE_NAMES.worker))),
    ).rejects.toThrow(/нарушение D5/);
  });
});
