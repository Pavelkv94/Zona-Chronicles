import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.ts';
import { DEFAULT_WORLD_TEMPO } from './world-tempo.ts';

/**
 * I03: `DATABASE_URL` стал ОБЯЗАТЕЛЬНЫМ, поэтому тесты, проверяющие остальные ключи, обязаны его
 * подставлять. Поведение изменилось намеренно и записано в `PLAN.md` §10.2 итерации I03: worker
 * перестал быть скелетом со `step`-no-op и теперь двигает мир, а worker без базы мир двигать не
 * может. Запускаться вхолостую ему нельзя — молчащий процесс неотличим от работающего, и ровно
 * это заблуждение стоило PR-04 завышенного статуса в трассировке (M8 аудита I02B).
 */
const DB = 'postgres://zona:zona_local_dev_only@localhost:5432/zona';

describe('parseConfig', () => {
  it('returns documented defaults when no relevant env vars are set', () => {
    const config = parseConfig({ DATABASE_URL: DB });

    expect(config).toEqual({
      logLevel: 'info',
      nodeEnv: 'development',
      deploymentId: 'local-dev-unset',
      databaseUrl: DB,
      worldId: 'world:prototype',
      worldMinutesPerRealSecond: DEFAULT_WORLD_TEMPO.worldMinutesPerRealSecond,
    });
  });

  it('reads allowed keys from the provided env record', () => {
    const config = parseConfig({
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
      DEPLOYMENT_ID: 'ci-run-42',
      DATABASE_URL: DB,
      WORLD_ID: 'world:other',
      WORLD_MINUTES_PER_REAL_SECOND: '4',
    });

    expect(config).toEqual({
      logLevel: 'debug',
      nodeEnv: 'production',
      deploymentId: 'ci-run-42',
      databaseUrl: DB,
      worldId: 'world:other',
      worldMinutesPerRealSecond: 4,
    });
  });

  it('rejects an unsupported LOG_LEVEL with a clear error', () => {
    expect(() => parseConfig({ LOG_LEVEL: 'shout', DATABASE_URL: DB })).toThrow(/LOG_LEVEL/);
  });

  it('rejects an unsupported NODE_ENV with a clear error', () => {
    expect(() => parseConfig({ NODE_ENV: 'staging', DATABASE_URL: DB })).toThrow(/NODE_ENV/);
  });

  it('ignores env vars that are not in the allowlist', () => {
    const config = parseConfig({
      SECRET_TOKEN: 'super-secret',
      AWS_ACCESS_KEY_ID: 'leak-me-not',
      PORT: '9999',
      DATABASE_URL: DB,
    });

    expect(config).toEqual({
      logLevel: 'info',
      nodeEnv: 'development',
      deploymentId: 'local-dev-unset',
      databaseUrl: DB,
      worldId: 'world:prototype',
      worldMinutesPerRealSecond: DEFAULT_WORLD_TEMPO.worldMinutesPerRealSecond,
    });
  });

  describe('I03: worker без базы и без осмысленного темпа не запускается', () => {
    it('отсутствующий DATABASE_URL — отказ запуска, а не тихий холостой ход', () => {
      expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
    });

    it('пустой DATABASE_URL — тот же отказ: пробел не является подключением', () => {
      expect(() => parseConfig({ DATABASE_URL: '   ' })).toThrow(/DATABASE_URL/);
    });

    it.each(['0', '-1', 'быстро', 'Infinity'])(
      'непригодный темп %s отвергается названной причиной',
      (raw) => {
        expect(() => parseConfig({ DATABASE_URL: DB, WORLD_MINUTES_PER_REAL_SECOND: raw })).toThrow(
          /WORLD_MINUTES_PER_REAL_SECOND/,
        );
      },
    );

    it('значение по умолчанию берётся из world-tempo, а не дублируется в конфиге', () => {
      expect(parseConfig({ DATABASE_URL: DB }).worldMinutesPerRealSecond).toBe(
        DEFAULT_WORLD_TEMPO.worldMinutesPerRealSecond,
      );
    });
  });

  describe('DEPLOYMENT_ID fail-closed behavior (§12 03_TECHNICAL_DESIGN)', () => {
    it('fails closed with a clear, actionable error when NODE_ENV=production and DEPLOYMENT_ID is missing', () => {
      expect(() => parseConfig({ NODE_ENV: 'production', DATABASE_URL: DB })).toThrow(
        /DEPLOYMENT_ID.*required.*production/is,
      );
    });

    it('fails closed when NODE_ENV=production and DEPLOYMENT_ID is set but blank', () => {
      expect(() =>
        parseConfig({ NODE_ENV: 'production', DEPLOYMENT_ID: '   ', DATABASE_URL: DB }),
      ).toThrow(/DEPLOYMENT_ID/);
    });

    it('succeeds in production when DEPLOYMENT_ID is provided', () => {
      const config = parseConfig({
        NODE_ENV: 'production',
        DEPLOYMENT_ID: 'release-2026-08-20-1',
        DATABASE_URL: DB,
      });
      expect(config.deploymentId).toBe('release-2026-08-20-1');
    });

    it('defaults to a visibly-local deployment id outside production, never silently to a plausible prod-looking value', () => {
      const dev = parseConfig({ NODE_ENV: 'development', DATABASE_URL: DB });
      const test = parseConfig({ NODE_ENV: 'test', DATABASE_URL: DB });
      const unset = parseConfig({ DATABASE_URL: DB });

      for (const config of [dev, test, unset]) {
        expect(config.deploymentId).toMatch(/local/);
      }
    });
  });
});
