import { describe, expect, it } from 'vitest';
import { parseDatabaseConnectionUrl } from './database.ts';

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
