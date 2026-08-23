import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.ts';

/**
 * I03: `PROJECTION_DATABASE_URL` стал ОБЯЗАТЕЛЬНЫМ. Поведение изменилось намеренно — API перестал
 * быть скелетом с `/health` и теперь показывает мир; без проекции показывать нечего, а
 * отвечающий пустотой сервис неотличим от работающего с пустым миром.
 */
const PROJECTION_DB = 'postgres://zona_api:pw@localhost:5432/zona';

describe('parseConfig', () => {
  it('returns documented defaults when no relevant env vars are set', () => {
    const config = parseConfig({
      PROJECTION_DATABASE_URL: PROJECTION_DB,
    });

    expect(config).toEqual({
      projectionDatabaseUrl: PROJECTION_DB,
      worldId: 'world:prototype',
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      nodeEnv: 'development',
      deploymentId: 'local-dev-unset',
    });
  });

  it('reads allowed keys from the provided env record', () => {
    const config = parseConfig({
      PROJECTION_DATABASE_URL: PROJECTION_DB,
      PORT: '4100',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
      DEPLOYMENT_ID: 'ci-run-42',
    });

    expect(config).toEqual({
      projectionDatabaseUrl: PROJECTION_DB,
      worldId: 'world:prototype',
      port: 4100,
      host: '127.0.0.1',
      logLevel: 'debug',
      nodeEnv: 'production',
      deploymentId: 'ci-run-42',
    });
  });

  it('rejects a non-numeric PORT with a clear error', () => {
    expect(() =>
      parseConfig({ PROJECTION_DATABASE_URL: PROJECTION_DB, PORT: 'not-a-port' }),
    ).toThrow(/PORT/);
  });

  it('rejects a PORT outside the valid TCP range with a clear error', () => {
    expect(() => parseConfig({ PROJECTION_DATABASE_URL: PROJECTION_DB, PORT: '70000' })).toThrow(
      /PORT/,
    );
    expect(() => parseConfig({ PROJECTION_DATABASE_URL: PROJECTION_DB, PORT: '0' })).toThrow(
      /PORT/,
    );
  });

  it('rejects an unsupported LOG_LEVEL with a clear error', () => {
    expect(() =>
      parseConfig({ PROJECTION_DATABASE_URL: PROJECTION_DB, LOG_LEVEL: 'shout' }),
    ).toThrow(/LOG_LEVEL/);
  });

  it('rejects an unsupported NODE_ENV with a clear error', () => {
    expect(() =>
      parseConfig({ PROJECTION_DATABASE_URL: PROJECTION_DB, NODE_ENV: 'staging' }),
    ).toThrow(/NODE_ENV/);
  });

  it('ignores env vars that are not in the allowlist', () => {
    const config = parseConfig({
      PROJECTION_DATABASE_URL: PROJECTION_DB,
      SECRET_TOKEN: 'super-secret',
      AWS_ACCESS_KEY_ID: 'leak-me-not',
    });

    expect(config).toEqual({
      projectionDatabaseUrl: PROJECTION_DB,
      worldId: 'world:prototype',
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      nodeEnv: 'development',
      deploymentId: 'local-dev-unset',
    });
  });

  describe('I03: API без проекции не запускается', () => {
    it('отсутствующий PROJECTION_DATABASE_URL — отказ запуска, а не пустой мир', () => {
      expect(() => parseConfig({})).toThrow(/PROJECTION_DATABASE_URL/);
    });

    it('пустая строка — тот же отказ', () => {
      expect(() => parseConfig({ PROJECTION_DATABASE_URL: '   ' })).toThrow(
        /PROJECTION_DATABASE_URL/,
      );
    });

    /**
     * Отдельная переменная от `DATABASE_URL` — не удобство, а граница D5: одинаковая строка
     * подключения означала бы одинаковую роль, и запрет на чтение канонических таблиц держался бы
     * на честном слове вместо грантов.
     */
    it('DATABASE_URL не подставляется вместо PROJECTION_DATABASE_URL', () => {
      expect(() => parseConfig({ DATABASE_URL: 'postgres://zona:pw@localhost:5432/zona' })).toThrow(
        /PROJECTION_DATABASE_URL/,
      );
    });
  });

  describe('DEPLOYMENT_ID fail-closed behavior (§12 03_TECHNICAL_DESIGN)', () => {
    it('fails closed with a clear, actionable error when NODE_ENV=production and DEPLOYMENT_ID is missing', () => {
      expect(() =>
        parseConfig({ PROJECTION_DATABASE_URL: PROJECTION_DB, NODE_ENV: 'production' }),
      ).toThrow(/DEPLOYMENT_ID.*required.*production/is);
    });

    it('fails closed when NODE_ENV=production and DEPLOYMENT_ID is set but blank', () => {
      expect(() =>
        parseConfig({
          PROJECTION_DATABASE_URL: PROJECTION_DB,
          NODE_ENV: 'production',
          DEPLOYMENT_ID: '   ',
        }),
      ).toThrow(/DEPLOYMENT_ID/);
    });

    it('succeeds in production when DEPLOYMENT_ID is provided', () => {
      const config = parseConfig({
        PROJECTION_DATABASE_URL: PROJECTION_DB,
        NODE_ENV: 'production',
        DEPLOYMENT_ID: 'release-2026-08-20-1',
      });
      expect(config.deploymentId).toBe('release-2026-08-20-1');
    });

    it('defaults to a visibly-local deployment id outside production, never silently to a plausible prod-looking value', () => {
      const dev = parseConfig({ PROJECTION_DATABASE_URL: PROJECTION_DB, NODE_ENV: 'development' });
      const test = parseConfig({ PROJECTION_DATABASE_URL: PROJECTION_DB, NODE_ENV: 'test' });
      const unset = parseConfig({
        PROJECTION_DATABASE_URL: PROJECTION_DB,
      });

      for (const config of [dev, test, unset]) {
        expect(config.deploymentId).toMatch(/local/);
      }
    });
  });
});
