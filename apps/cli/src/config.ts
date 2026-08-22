/**
 * apps/cli — единственное место, читающее окружение процесса (I02A).
 *
 * Тот же контракт, что у `apps/api/src/config.ts`: `parseCliConfig` — чистая функция от уже
 * прочитанного `Record`, `loadCliConfig()` — единственное место во всём apps/cli, где встречается
 * литеральное `process.env` (см. правило для apps-приложений в `eslint.config.mjs`).
 *
 * Allowlist исчерпывающий: читается только `DATABASE_URL`. Строка подключения содержит пароль,
 * поэтому она НИКОГДА не попадает в вывод и в сообщения об ошибках — `describeDatabaseTarget`
 * отдаёт `user@host:port/database` без пароля (§11 `03_TECHNICAL_DESIGN`: secrets не в логах).
 */

export interface CliConfig {
  /** `undefined` — переменная не задана; команды без базы обязаны работать и в этом случае. */
  readonly databaseUrl: string | undefined;
  /**
   * Подключение под ролью migration owner — только для `world migrate` (BL-2 аудита I02A).
   *
   * Рантайм ходит под `zona_worker`, у которого нет DDL и нет `update`/`delete` на
   * `world_events`; миграции требуют владельца схемы. Разные роли — разные строки подключения,
   * иначе разделение ролей существует только в миграции и ни в одном работающем пути
   * (`03_TECHNICAL_DESIGN` §11). Если переменная не задана, `world migrate` падает обратно на
   * `DATABASE_URL` и ГОВОРИТ об этом: в локальной разработке это удобно, в поставке — заметно.
   */
  readonly migrationDatabaseUrl: string | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** Разбирает окружение в конфиг. Валидацию самой строки делает `parseDatabaseConnectionUrl`. */
export function parseCliConfig(env: Record<string, string | undefined>): CliConfig {
  return {
    databaseUrl: nonEmpty(env['DATABASE_URL']),
    migrationDatabaseUrl: nonEmpty(env['MIGRATION_DATABASE_URL']),
  };
}

/** Читает `process.env`. Единственное место в apps/cli, где это допустимо. */
export function loadCliConfig(): CliConfig {
  return parseCliConfig(process.env);
}

/** Безопасное для вывода описание цели подключения: без пароля и без query-параметров. */
export function describeDatabaseTarget(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return '<нераспознанный DATABASE_URL>';
  }
  const user = url.username.length > 0 ? `${url.username}@` : '';
  const port = url.port.length > 0 ? `:${url.port}` : '';
  return `${user}${url.hostname}${port}${url.pathname}`;
}
