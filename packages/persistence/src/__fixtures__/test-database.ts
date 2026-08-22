/**
 * Одноразовая база на тестовый файл.
 *
 * Почему не одна общая база с `TRUNCATE` между тестами: B1 сравнивает dump СХЕМЫ до и после
 * повторной миграции, B7 проверяет гранты ролей, а B5 — что после отката база побайтово та же.
 * Ни одно из этих свойств нельзя проверить в базе, которую параллельно правит другой тест, и
 * `TRUNCATE` не восстанавливает схему и роли. Стоимость `CREATE DATABASE` — десятки миллисекунд.
 *
 * Имя базы детерминировано по метке вызывающего файла, а не случайно: упавший прогон оставляет
 * базу, которую можно открыть и посмотреть, и следующий прогон её пересоздаёт.
 */
import { Client } from 'pg';

/** Административное подключение к локальному docker-postgres. Только для тестов. */
export const ADMIN_DATABASE_URL =
  process.env['ZONA_TEST_ADMIN_DATABASE_URL'] ??
  'postgres://zona:zona_local_dev_only@localhost:5432/zona';

const sanitize = (label: string): string => {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned.length === 0) throw new Error(`test-database: пустая метка "${label}"`);
  return cleaned.slice(0, 40);
};

export const testDatabaseUrl = (name: string): string => {
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
};

const withAdmin = async <T>(fn: (client: Client) => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: ADMIN_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  readonly drop: () => Promise<void>;
}

/** Создаёт (пересоздавая, если осталась с прошлого прогона) пустую базу под именем метки. */
export const createTestDatabase = async (label: string): Promise<TestDatabase> => {
  const name = `zona_test_${sanitize(label)}`;
  await withAdmin(async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    // LC_* и шаблон фиксированы: детерминизм сортировки и сообщений не должен зависеть от
    // настроек шаблонной базы хоста (SIM-01, тот же довод, что у TZ/LANG в docker-compose).
    await client.query(
      `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
  });
  return {
    name,
    url: testDatabaseUrl(name),
    drop: async () => {
      await withAdmin(async (client) => {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name],
        );
        await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      });
    },
  };
};

/** Полный текстовый слепок схемы: таблицы, колонки, типы, ограничения, индексы и гранты. */
export const dumpSchema = async (url: string): Promise<string> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const parts: string[] = [];
    const queries: ReadonlyArray<readonly [string, string]> = [
      [
        'columns',
        `SELECT table_name, column_name, data_type, is_nullable, column_default
           FROM information_schema.columns WHERE table_schema = 'public'
          ORDER BY table_name, column_name`,
      ],
      [
        'constraints',
        `SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = 'public' ORDER BY 1, 2`,
      ],
      [
        'indexes',
        `SELECT tablename, indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public' ORDER BY tablename, indexname`,
      ],
      [
        'grants',
        `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' ORDER BY table_name, grantee, privilege_type`,
      ],
    ];
    for (const [label, sql] of queries) {
      const result = await client.query(sql);
      parts.push(`-- ${label}`);
      for (const row of result.rows) parts.push(JSON.stringify(row));
    }
    return parts.join('\n');
  } finally {
    await client.end();
  }
};
