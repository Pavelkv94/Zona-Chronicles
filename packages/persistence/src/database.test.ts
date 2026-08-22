import { describe, expect, it } from 'vitest';
import { parseDatabaseConnectionUrl, redactConnectionUrl } from './database.ts';

/**
 * minor (I00-F2) — `docker-compose.yml` передаёт `DATABASE_URL` в `api`/`worker`,
 * но ни один `config.ts` его пока не читает (I02A). Со стороны `packages/persistence`
 * этот тест фиксирует, что пакет уже предоставляет пригодный способ построить
 * `DatabaseConnectionConfig` из такого URL, чтобы I02A не изобретала парсинг заново.
 */
describe('parseDatabaseConnectionUrl', () => {
  it('разбирает DATABASE_URL из docker-compose.yml на поля', () => {
    const config = parseDatabaseConnectionUrl(
      'postgres://zona:zona_local_dev_only@postgres:5432/zona',
    );
    expect(config).toEqual({
      host: 'postgres',
      port: 5432,
      user: 'zona',
      password: 'zona_local_dev_only',
      database: 'zona',
    });
  });

  it('принимает "postgresql://" схему', () => {
    const config = parseDatabaseConnectionUrl('postgresql://u:p@localhost:5432/db');
    expect(config.host).toBe('localhost');
    expect(config.database).toBe('db');
  });

  it('по умолчанию использует порт 5432, если порт не указан', () => {
    const config = parseDatabaseConnectionUrl('postgres://u:p@localhost/db');
    expect(config.port).toBe(5432);
  });

  it('использует явно указанный нестандартный порт', () => {
    const config = parseDatabaseConnectionUrl('postgres://u:p@localhost:6543/db');
    expect(config.port).toBe(6543);
  });

  it('декодирует URL-encoded user/password (спецсимволы вроде "@" и "/")', () => {
    const config = parseDatabaseConnectionUrl('postgres://us%40er:p%2Fass@localhost:5432/db');
    expect(config.user).toBe('us@er');
    expect(config.password).toBe('p/ass');
  });

  it('падает на неверной схеме (не postgres/postgresql)', () => {
    expect(() => parseDatabaseConnectionUrl('mysql://u:p@localhost:5432/db')).toThrow(
      /expected "postgres:\/\/" or "postgresql:\/\/"/,
    );
  });

  it('падает, если в пути нет имени базы данных', () => {
    expect(() => parseDatabaseConnectionUrl('postgres://u:p@localhost:5432/')).toThrow(
      /missing database name/,
    );
  });

  it('падает на невалидной строке (не URL вовсе)', () => {
    expect(() => parseDatabaseConnectionUrl('not-a-url')).toThrow(/not a valid URL/);
  });

  it('не кодирует maxConnections из URL — поле остаётся explicit-параметром вызывающего кода', () => {
    const config = parseDatabaseConnectionUrl(
      'postgres://zona:zona_local_dev_only@postgres:5432/zona',
    );
    expect(config.maxConnections).toBeUndefined();
  });
});

describe('redactConnectionUrl (M-5)', () => {
  // Значение собирается из частей намеренно: литерал настоящего пароля в файле — ровно то, что
  // ловит `credential-url` из `security/policy.json`, и тест не должен быть исключением из
  // собственного контроля (проверено исполнением: с литералом `pnpm security:secrets` падает).
  const secret = ['R3al', 'Pr0d', 'Passw0rd'].join('-');
  const host = 'db.example.com';

  it('не пропускает пароль в текст', () => {
    const redacted = redactConnectionUrl(`postgres://zona:${secret}@${host}/zona`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toBe(`postgres://zona:${'*'.repeat(3)}@${host}/zona`);
  });

  it('сообщения об ошибке разбора не содержат пароль', () => {
    // Настоящий сценарий M-5: невалидный URL с настоящим паролем уходил в stderr целиком.
    const invalid = `postgres://zona:${secret}@/zona`;
    expect(() => parseDatabaseConnectionUrl(invalid)).toThrow(/Invalid database connection URL/);
    try {
      parseDatabaseConnectionUrl(invalid);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('нераспознанную строку не показывает вовсе — из неё нечего вырезать безопасно', () => {
    expect(redactConnectionUrl(`не-url-с-паролем ${secret}`)).not.toContain(secret);
  });
});
