/**
 * 0003 — роли и гранты (OPS-03, ACCEPTANCE B7).
 *
 * Append-only `world_events` держится ПРАВАМИ, а не соглашением: canonical worker получает
 * `INSERT/SELECT` и не получает `UPDATE/DELETE`. Роль read-only api не получает НИЧЕГО на
 * канонических таблицах — observer path обязан читать проекции (OPS-02), и это свойство должно
 * ломаться на уровне БД, а не на уровне намерений разработчика.
 *
 * Оговорка о границе миграции: роли в PostgreSQL — объекты КЛАСТЕРА, а не базы. Миграция
 * создаёт их идемпотентно (проверкой `pg_roles`), а гранты выдаёт в текущей базе. Пароль —
 * локальный dev-литерал, тот же, что в `docker-compose.yml`; в реальном развёртывании роли
 * создаёт оператор из secret store, и миграция ограничивается грантами (`03_TECHNICAL_DESIGN`
 * §11: secrets не хранятся в git). Migration owner здесь не создаётся: это та роль, под
 * которой выполняется сама миграция.
 *
 * Один элемент `statements` — РОВНО один SQL-оператор: runner исполняет их через `sql.raw` по
 * extended protocol, который отвергает несколько команд в одном запросе.
 */
import type { Migration } from './types.ts';

/** Локальный dev-пароль ролей; совпадает с `docker-compose.yml`. Не секрет и не для прода. */
export const LOCAL_DEV_ROLE_PASSWORD = 'zona_local_dev_only';

export const ROLE_NAMES = {
  worker: 'zona_worker',
  projection: 'zona_projection',
  api: 'zona_api',
} as const;

const APPLICATION_ROLES = [ROLE_NAMES.worker, ROLE_NAMES.projection, ROLE_NAMES.api] as const;

const roleArrayLiteral = `array[${APPLICATION_ROLES.map((role) => `'${role}'`).join(', ')}]`;

const CREATE_ROLES = `
do $$
declare
  role_name text;
begin
  foreach role_name in array ${roleArrayLiteral} loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I login password %L', role_name, '${LOCAL_DEV_ROLE_PASSWORD}');
    end if;
  end loop;
end
$$
`;

/** Deny-by-default (ADR-008): ни DDL, ни доступа к таблицам без явного гранта. */
const REVOKE_PUBLIC_CREATE = `revoke create on schema public from public`;
const REVOKE_PUBLIC_TABLES = `revoke all on all tables in schema public from public`;

const BASELINE_ROLE_ACCESS = `
do $$
declare
  role_name text;
begin
  foreach role_name in array ${roleArrayLiteral} loop
    execute format('grant connect on database %I to %I', current_database(), role_name);
    execute format('grant usage on schema public to %I', role_name);
    execute format('revoke create on schema public from %I', role_name);
    execute format('revoke all on all tables in schema public from %I', role_name);
  end loop;
end
$$
`;

/**
 * Canonical worker пишет историю, но не переписывает её: ни `update`, ни `delete` на
 * `world_events` и `command_results`. Отсутствие read-only api в этом списке — не пропуск:
 * гранты api выдаются только на projection-таблицы, когда те появятся (I03).
 */
const WORKER_GRANTS: readonly string[] = [
  `grant select, insert on world_events to ${ROLE_NAMES.worker}`,
  `grant select, insert on command_results to ${ROLE_NAMES.worker}`,
  `grant select, insert, update on worlds to ${ROLE_NAMES.worker}`,
  `grant select, insert, update on agents to ${ROLE_NAMES.worker}`,
  `grant select, insert on locations to ${ROLE_NAMES.worker}`,
  `grant select, insert on routes to ${ROLE_NAMES.worker}`,
  `grant select, insert, update on outbox to ${ROLE_NAMES.worker}`,
];

/** Projection builder читает канонические факты и отмечает доставку; ничего не создаёт. */
const PROJECTION_GRANTS: readonly string[] = [
  `grant select on world_events to ${ROLE_NAMES.projection}`,
  `grant select on locations to ${ROLE_NAMES.projection}`,
  `grant select on routes to ${ROLE_NAMES.projection}`,
  `grant select, update on outbox to ${ROLE_NAMES.projection}`,
];

const statements: readonly string[] = [
  CREATE_ROLES,
  REVOKE_PUBLIC_CREATE,
  REVOKE_PUBLIC_TABLES,
  BASELINE_ROLE_ACCESS,
  ...WORKER_GRANTS,
  ...PROJECTION_GRANTS,
];

/**
 * `phase: 'expand'` — миграция добавляет роли и сужает доступ по умолчанию; migration owner,
 * под которым она исполняется, не затрагивается.
 */
export const rolesAndGrantsMigration: Migration = {
  id: '0003',
  name: 'roles-and-grants',
  phase: 'expand',
  statements,
};
