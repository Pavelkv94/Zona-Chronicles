/**
 * Роли (principals) и гранты — отдельно от миграций схемы.
 *
 * Почему не миграцией (M-4/M-8 независимого архитектурного аудита I02A):
 *
 * 1. **Роли — объекты КЛАСТЕРА, журнал миграций — объект БАЗЫ.** Дамп одной базы переносит
 *    `schema_migrations` со строкой «гранты применены», но не переносит сами роли. Runner такую
 *    миграцию пропустит, и после restore в чистый кластер прав не будет — молча. Гранты обязаны
 *    переприменяться при каждом `world migrate`, а не один раз в истории базы (OPS-04).
 * 2. **Пароль не может жить в тексте миграции.** Он входил бы в `computeChecksum`, то есть был
 *    бы неизменяемым, и одновременно лежал бы в git и в `dist` (§11: secrets не в git и не в
 *    artifacts). Здесь пароль приходит АРГУМЕНТОМ и в репозитории не хранится вовсе.
 * 3. **Происхождение роли нужно проверять, а не полагаться на имя.** `if not exists (pg_roles)`
 *    пропускал создание, если роль с таким именем уже была заведена кем-то другим, и выдавал ей
 *    права. Здесь несоответствие атрибутов — явная ошибка.
 *
 * Операции идемпотентны: повторный вызов ничего не меняет и ничего не ломает.
 */
import { sql } from 'kysely';
import type { DatabaseConnection } from './database.ts';

export const ROLE_NAMES = {
  worker: 'zona_worker',
  projection: 'zona_projection',
  api: 'zona_api',
} as const;

export type RoleName = (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES];

export const APPLICATION_ROLES: readonly RoleName[] = [
  ROLE_NAMES.worker,
  ROLE_NAMES.projection,
  ROLE_NAMES.api,
];

/**
 * Матрица прав. Данные, а не последовательность вызовов: её же читает golden-тест грантов
 * (M-7), поэтому список прав и его проверка не могут разойтись.
 *
 * `world_events` и `command_results` не имеют `update`/`delete` НИ У КОГО — append-only держится
 * правами, а не соглашением. Роль `api` отсутствует намеренно: observer path читает проекции,
 * а не канонические таблицы (OPS-02); её гранты появятся вместе с projection-таблицами в I03.
 */
export const GRANT_MATRIX: Readonly<Record<RoleName, Readonly<Record<string, readonly string[]>>>> =
  {
    [ROLE_NAMES.worker]: {
      world_events: ['SELECT', 'INSERT'],
      command_results: ['SELECT', 'INSERT'],
      worlds: ['SELECT', 'INSERT', 'UPDATE'],
      agents: ['SELECT', 'INSERT', 'UPDATE'],
      locations: ['SELECT', 'INSERT'],
      routes: ['SELECT', 'INSERT'],
      outbox: ['SELECT', 'INSERT', 'UPDATE'],
    },
    [ROLE_NAMES.projection]: {
      world_events: ['SELECT'],
      locations: ['SELECT'],
      routes: ['SELECT'],
      outbox: ['SELECT', 'UPDATE'],
    },
    [ROLE_NAMES.api]: {},
  };

export interface EnsureRolesResult {
  readonly created: readonly RoleName[];
  readonly existing: readonly RoleName[];
}

/**
 * Создаёт недостающие application-роли. Пароль приходит извне и в репозиторий не попадает.
 *
 * Уже существующая роль проверяется по АТРИБУТАМ, а не только по имени: `superuser`,
 * `createrole`, `createdb` или `bypassrls` у роли с нашим именем — это чужой principal, и
 * выдавать ему права нельзя.
 */
export const ensureApplicationRoles = async (
  db: DatabaseConnection,
  password: string,
): Promise<EnsureRolesResult> => {
  if (password.length === 0) {
    throw new Error('principals: пароль application-роли не может быть пустым');
  }
  const created: RoleName[] = [];
  const existing: RoleName[] = [];

  for (const role of APPLICATION_ROLES) {
    const found = await sql<{
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
    }>`
      select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
        from pg_roles where rolname = ${role}
    `.execute(db);

    const attributes = found.rows[0];
    if (attributes === undefined) {
      await sql`${sql.raw(`create role ${role} login password ${literal(password)}`)}`.execute(db);
      created.push(role);
      continue;
    }
    if (
      attributes.rolsuper ||
      attributes.rolcreaterole ||
      attributes.rolcreatedb ||
      attributes.rolbypassrls
    ) {
      throw new Error(
        `principals: роль ${role} уже существует в кластере с привилегиями, которых у ` +
          'application-роли быть не должно (superuser/createrole/createdb/bypassrls). Это чужой ' +
          'principal с совпавшим именем — гранты ему не выдаются.',
      );
    }
    existing.push(role);
  }

  return { created, existing };
};

/** Экранирует строковый литерал для SQL. Пароль не параметризуется: `create role` не принимает bind. */
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Применяет матрицу грантов. Идемпотентно и выполняется при КАЖДОМ `world migrate`, а не один
 * раз в журнале — иначе restore базы в кластер без ролей оставил бы права невосстановленными.
 */
export const applyGrants = async (db: DatabaseConnection): Promise<void> => {
  for (const role of APPLICATION_ROLES) {
    await sql`${sql.raw(`grant connect on database ${quoteIdent(await currentDatabase(db))} to ${role}`)}`.execute(
      db,
    );
    await sql`${sql.raw(`grant usage on schema public to ${role}`)}`.execute(db);
    // Сначала снимаем всё, потом выдаём объявленное: матрица описывает ИТОГОВОЕ состояние,
    // поэтому убранное из неё право действительно исчезает, а не остаётся с прошлого прогона.
    await sql`${sql.raw(`revoke all on all tables in schema public from ${role}`)}`.execute(db);
    await sql`${sql.raw(`revoke create on schema public from ${role}`)}`.execute(db);

    for (const [table, privileges] of Object.entries(GRANT_MATRIX[role])) {
      if (privileges.length === 0) continue;
      await sql`${sql.raw(`grant ${privileges.join(', ')} on ${table} to ${role}`)}`.execute(db);
    }
  }
};

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const currentDatabase = async (db: DatabaseConnection): Promise<string> => {
  const row = await sql<{ name: string }>`select current_database() as name`.execute(db);
  const name = row.rows[0]?.name;
  if (name === undefined) throw new Error('principals: не удалось определить текущую базу');
  return name;
};
