import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.ts';

describe('parseConfig', () => {
  it('returns documented defaults when no relevant env vars are set', () => {
    const config = parseConfig({});

    expect(config).toEqual({
      logLevel: 'info',
      nodeEnv: 'development',
      deploymentId: 'local-dev-unset',
    });
  });

  it('reads allowed keys from the provided env record', () => {
    const config = parseConfig({
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
      DEPLOYMENT_ID: 'ci-run-42',
    });

    expect(config).toEqual({
      logLevel: 'debug',
      nodeEnv: 'production',
      deploymentId: 'ci-run-42',
    });
  });

  it('rejects an unsupported LOG_LEVEL with a clear error', () => {
    expect(() => parseConfig({ LOG_LEVEL: 'shout' })).toThrow(/LOG_LEVEL/);
  });

  it('rejects an unsupported NODE_ENV with a clear error', () => {
    expect(() => parseConfig({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('ignores env vars that are not in the allowlist', () => {
    const config = parseConfig({
      SECRET_TOKEN: 'super-secret',
      AWS_ACCESS_KEY_ID: 'leak-me-not',
      PORT: '9999',
    });

    expect(config).toEqual({
      logLevel: 'info',
      nodeEnv: 'development',
      deploymentId: 'local-dev-unset',
    });
  });

  describe('DEPLOYMENT_ID fail-closed behavior (§12 03_TECHNICAL_DESIGN)', () => {
    it('fails closed with a clear, actionable error when NODE_ENV=production and DEPLOYMENT_ID is missing', () => {
      expect(() => parseConfig({ NODE_ENV: 'production' })).toThrow(
        /DEPLOYMENT_ID.*required.*production/is,
      );
    });

    it('fails closed when NODE_ENV=production and DEPLOYMENT_ID is set but blank', () => {
      expect(() => parseConfig({ NODE_ENV: 'production', DEPLOYMENT_ID: '   ' })).toThrow(
        /DEPLOYMENT_ID/,
      );
    });

    it('succeeds in production when DEPLOYMENT_ID is provided', () => {
      const config = parseConfig({ NODE_ENV: 'production', DEPLOYMENT_ID: 'release-2026-08-20-1' });
      expect(config.deploymentId).toBe('release-2026-08-20-1');
    });

    it('defaults to a visibly-local deployment id outside production, never silently to a plausible prod-looking value', () => {
      const dev = parseConfig({ NODE_ENV: 'development' });
      const test = parseConfig({ NODE_ENV: 'test' });
      const unset = parseConfig({});

      for (const config of [dev, test, unset]) {
        expect(config.deploymentId).toMatch(/local/);
      }
    });
  });
});
