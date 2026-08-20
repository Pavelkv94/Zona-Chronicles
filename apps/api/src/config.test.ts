import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.ts';

describe('parseConfig', () => {
  it('returns documented defaults when no relevant env vars are set', () => {
    const config = parseConfig({});

    expect(config).toEqual({
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      deploymentId: 'local-dev',
    });
  });

  it('reads allowed keys from the provided env record', () => {
    const config = parseConfig({
      PORT: '4100',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
      DEPLOYMENT_ID: 'ci-run-42',
    });

    expect(config).toEqual({
      port: 4100,
      host: '127.0.0.1',
      logLevel: 'debug',
      deploymentId: 'ci-run-42',
    });
  });

  it('rejects a non-numeric PORT with a clear error', () => {
    expect(() => parseConfig({ PORT: 'not-a-port' })).toThrow(/PORT/);
  });

  it('rejects a PORT outside the valid TCP range with a clear error', () => {
    expect(() => parseConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => parseConfig({ PORT: '0' })).toThrow(/PORT/);
  });

  it('rejects an unsupported LOG_LEVEL with a clear error', () => {
    expect(() => parseConfig({ LOG_LEVEL: 'shout' })).toThrow(/LOG_LEVEL/);
  });

  it('ignores env vars that are not in the allowlist', () => {
    const config = parseConfig({
      SECRET_TOKEN: 'super-secret',
      AWS_ACCESS_KEY_ID: 'leak-me-not',
    });

    expect(config).toEqual({
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      deploymentId: 'local-dev',
    });
  });
});
