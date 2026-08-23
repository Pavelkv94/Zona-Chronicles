/**
 * Contract-тесты observer API (I03, D4/D8/D9/D10/D11).
 *
 * Проекция подменена портом: проверяется КОНТРАКТ маршрутов, а не хранилище (оно проверено
 * отдельно на настоящей базе). Подмена законна ровно потому, что порт — граница приложения, а не
 * шов внутри проверяемого поведения.
 */
import { describe, expect, it } from 'vitest';
import {
  OBSERVER_STREAM_EVENT_NAMES,
  decodeObserverWorldSnapshot,
  isValidationFailure,
  type ObserverEvent,
  type ObserverWorldSnapshot,
} from '@zona/contracts';
import { buildServer } from './server.ts';
import { MAX_EVENT_PAGE, resumeFrom } from './observer-routes.ts';
import type { ObserverPort } from './observer-port.ts';

const WORLD_ID = 'world:prototype';
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

const snapshot = (): ObserverWorldSnapshot => ({
  world_id: WORLD_ID,
  projection_sequence: 3,
  world_time: '2028-04-26T06:40:00.000Z',
  nodes: [{ location_id: 'loc:bridge', name: 'Мост', description: 'Мост.' }],
  edges: [
    {
      route_id: 'route:yard-to-bridge',
      from_location_id: 'loc:quiet-yard',
      to_location_id: 'loc:bridge',
      travel_minutes: 40,
    },
  ],
  agents: [
    {
      agent_id: 'agent:rook',
      name: 'Рук',
      location_id: 'loc:bridge',
      status: 'idle',
      route_id: null,
    },
  ],
});

const feedEvent = (sequence: number): ObserverEvent => ({
  projection_sequence: sequence,
  event_id: `evt_${'A'.repeat(20)}${String(sequence).padStart(6, '0')}`,
  world_time: '2028-04-26T06:40:00.000Z',
  type: 'journey.completed',
  actor_ids: ['agent:rook'],
  location_id: 'loc:bridge',
  route_id: 'route:yard-to-bridge',
});

const port = (overrides: Partial<ObserverPort> = {}): ObserverPort => ({
  loadSnapshot: async () => await Promise.resolve(snapshot()),
  loadEvents: async () =>
    await Promise.resolve({ events: [feedEvent(1)], earliestAvailableSequence: 1 }),
  ...overrides,
});

const server = (observer: ObserverPort = port(), streamPollMs = 10) =>
  buildServer({
    deploymentId: 'test',
    schemaVersion: 1,
    rulesVersion: '0.1.0',
    uptime: { uptimeMs: () => 1 },
    observer: { observer, worldId: WORLD_ID, streamPollMs },
  });

describe('D4: публичное API не содержит write-маршрутов', () => {
  /**
   * Обходится ТАБЛИЦА маршрутов, а не список известных путей: список пришлось бы дополнять при
   * каждом новом маршруте, и однажды его забыли бы дополнить — ровно там, где появился первый
   * write-маршрут.
   */
  it('ни один зарегистрированный маршрут не отвечает на POST/PUT/PATCH/DELETE', async () => {
    const registered: { method: string; url: string }[] = [];
    const app = server();
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.push({ method, url: route.url });
    });
    await app.ready();

    // Хук ловит маршруты, зарегистрированные ПОСЛЕ него, поэтому опираемся ещё и на дерево:
    // два независимых обхода, и оба обязаны согласиться.
    const tree = app.printRoutes();
    for (const method of WRITE_METHODS) {
      expect(registered.some((route) => route.method === method)).toBe(false);
      expect(tree).not.toContain(method);
    }

    await app.close();
  });

  it.each(WRITE_METHODS)('%s на наблюдательский маршрут отвергается', async (method) => {
    const app = server();
    for (const url of ['/v1/world/snapshot', '/v1/events', '/v1/stream']) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });
});

describe('D8: snapshot самодостаточен и проходит собственный контракт', () => {
  it('отдаёт карту, агентов и курсор', async () => {
    const app = server();
    const response = await app.inject({ method: 'GET', url: '/v1/world/snapshot' });

    expect(response.statusCode).toBe(200);
    const decoded = decodeObserverWorldSnapshot(response.json());
    expect(isValidationFailure(decoded)).toBe(false);
    if (!isValidationFailure(decoded)) {
      expect(decoded.value.projection_sequence).toBe(3);
      expect(decoded.value.nodes).toHaveLength(1);
    }

    await app.close();
  });

  it('мира нет — 404 с названной причиной, а не пустой snapshot', async () => {
    const app = server(port({ loadSnapshot: async () => await Promise.resolve(null) }));
    const response = await app.inject({ method: 'GET', url: '/v1/world/snapshot' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'world_not_found', world_id: WORLD_ID });

    await app.close();
  });
});

describe('лента: курсор и server-side maximum', () => {
  it('limit ограничен сервером, а не клиентом', async () => {
    let seenLimit = 0;
    const app = server(
      port({
        loadEvents: async (_worldId, options) => {
          seenLimit = options.limit;
          return await Promise.resolve({ events: [], earliestAvailableSequence: null });
        },
      }),
    );

    const response = await app.inject({ method: 'GET', url: `/v1/events?limit=${MAX_EVENT_PAGE}` });
    expect(response.statusCode).toBe(200);
    expect(seenLimit).toBe(MAX_EVENT_PAGE);

    // Запрос сверх максимума отвергается схемой, а не молча урезается: клиент, попросивший
    // тысячу, обязан узнать, что столько не дают.
    const tooMuch = await app.inject({
      method: 'GET',
      url: `/v1/events?limit=${MAX_EVENT_PAGE + 1}`,
    });
    expect(tooMuch.statusCode).toBe(400);

    await app.close();
  });

  it('отдаёт earliest_available_sequence всегда, а не только при промахе', async () => {
    const app = server(
      port({
        loadEvents: async () =>
          await Promise.resolve({ events: [], earliestAvailableSequence: null }),
      }),
    );
    const response = await app.inject({ method: 'GET', url: '/v1/events' });
    expect(response.json()).toEqual({ events: [], earliest_available_sequence: null });
    await app.close();
  });
});

describe('D9/D10: возобновление потока', () => {
  it('Last-Event-ID разбирается из заголовка и из query, заголовок в приоритете', () => {
    expect(resumeFrom('7', '3')).toBe(7);
    expect(resumeFrom(undefined, '3')).toBe(3);
    expect(resumeFrom(undefined, undefined)).toBe(0);
    expect(resumeFrom('  ', undefined)).toBe(0);
  });

  it.each(['-1', 'abc', '1.5', '9007199254740993'])(
    'непригодный Last-Event-ID %s отвергается, а не считается нулём',
    (raw) => {
      expect(resumeFrom(raw, undefined)).toBe('invalid');
    },
  );

  it('поток отдаёт события после курсора с id, равным projection_sequence', async () => {
    const app = server(
      port({
        loadEvents: async (_worldId, options) =>
          await Promise.resolve({
            events: options.after < 2 ? [feedEvent(2)] : [],
            earliestAvailableSequence: 1,
          }),
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/v1/stream',
      headers: { 'last-event-id': '1' },
      payloadAsStream: true,
    });

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      response.stream().on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).toString('utf8').includes('id: 2')) resolve();
      });
    });

    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('id: 2');
    expect(text).toContain(`event: ${OBSERVER_STREAM_EVENT_NAMES.event}`);

    response.stream().destroy();
    await app.close();
  });

  /** D10: между позицией клиента и первой доступной есть дыра — он обязан узнать об этом. */
  it('утраченное окно retention даёт reset_required, а не тихую ленту с начала', async () => {
    const app = server(
      port({
        loadEvents: async () =>
          await Promise.resolve({ events: [feedEvent(50)], earliestAvailableSequence: 50 }),
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/v1/stream?last_event_id=5',
      payloadAsStream: true,
    });

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      response.stream().on('data', (chunk: Buffer) => chunks.push(chunk));
      response.stream().on('end', () => resolve());
    });

    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain(`event: ${OBSERVER_STREAM_EVENT_NAMES.reset}`);
    expect(text).toContain('"reason":"reset_required"');
    expect(text).toContain('"earliest_available_sequence":50');
    // И НИ ОДНОГО события ленты: молчаливая отдача с начала — ровно то, от чего защищает D10.
    expect(text).not.toContain(`event: ${OBSERVER_STREAM_EVENT_NAMES.event}`);

    await app.close();
  });

  it('непригодный Last-Event-ID даёт 400, а не молчаливый старт с нуля', async () => {
    const app = server();
    const response = await app.inject({ method: 'GET', url: '/v1/stream?last_event_id=abc' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
