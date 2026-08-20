import { describe, expect, it } from 'vitest';
import { buildServer } from './server.ts';

const SUSPICIOUS_KEY_PATTERN = /token|secret|password|apikey|api_key|credential|private[_-]?key/i;
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

function testDeps(): Parameters<typeof buildServer>[0] {
  return {
    deploymentId: 'test-deployment',
    schemaVersion: 0,
    rulesVersion: '0.0.0-unset',
    uptime: { uptimeMs: () => 12_345 },
  };
}

describe('GET /health', () => {
  it('returns 200 with the exact documented shape', async () => {
    const app = buildServer(testDeps());
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toEqual({
      status: 'ok',
      deployment_id: 'test-deployment',
      schema_version: 0,
      rules_version: '0.0.0-unset',
      uptime_ms: 12_345,
    });

    await app.close();
  });

  it('derives uptime_ms from the injected uptime port, not wall clock', async () => {
    const app = buildServer({ ...testDeps(), uptime: { uptimeMs: () => 999_999 } });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.json()).toMatchObject({ uptime_ms: 999_999 });

    await app.close();
  });

  it('does not include unknown or secret-looking fields', async () => {
    const app = buildServer(testDeps());
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = response.json<Record<string, unknown>>();

    const allowedKeys = ['status', 'deployment_id', 'schema_version', 'rules_version', 'uptime_ms'];
    expect(Object.keys(body).sort()).toEqual([...allowedKeys].sort());
    for (const key of Object.keys(body)) {
      expect(key).not.toMatch(SUSPICIOUS_KEY_PATTERN);
    }
    for (const value of Object.values(body)) {
      if (typeof value === 'string') {
        expect(value).not.toMatch(SUSPICIOUS_KEY_PATTERN);
      }
    }

    await app.close();
  });
});

describe('GET /ready', () => {
  it('returns 200 with a readiness status distinct from /health', async () => {
    const app = buildServer(testDeps());
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });

    await app.close();
  });
});

describe('unknown routes', () => {
  it('returns 404 for a path that does not exist', async () => {
    const app = buildServer(testDeps());
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});

describe('public API is read-only', () => {
  it('registers no POST/PUT/PATCH/DELETE routes', async () => {
    const app = buildServer(testDeps());
    await app.ready();

    for (const method of WRITE_METHODS) {
      expect(app.hasRoute({ method, url: '/health' })).toBe(false);
      expect(app.hasRoute({ method, url: '/ready' })).toBe(false);
    }

    const routesTree = app.printRoutes();
    for (const method of WRITE_METHODS) {
      expect(routesTree).not.toContain(method);
    }

    await app.close();
  });
});
