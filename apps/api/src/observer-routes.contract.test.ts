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
      needs: { hunger: 'normal', fatigue: 'normal' },
      food_carried: 0,
      goal: 'idle' as const,
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
  need: null,
  need_level: null,
  goal: null,
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
    const app = server();
    await app.ready();
    const tree = app.printRoutes();

    /**
     * СНАЧАЛА доказываем, что обход вообще что-то видит, и видит МЕТОДЫ.
     *
     * Отрицательные проверки ниже держатся на формате `printRoutes()`: он печатает методы в
     * скобках — `events (GET, HEAD)`. Если однажды формат изменится (обновление Fastify,
     * другие опции печати), `not.toContain('POST')` станет истинным ВСЕГДА, и тест продолжит
     * зеленеть, ничего не проверяя. Положительная проверка ломается в тот же день.
     *
     * Прежняя редакция вместо этого собирала маршруты хуком `onRoute`, повешенным ПОСЛЕ
     * `server()`, и называла это «двумя независимыми обходами, которые обязаны согласиться».
     * Список был ПУСТ: хук ловит только маршруты, зарегистрированные после него. Проверено
     * пробой — `expect(registered).not.toEqual([])` падает с `expected [] to not deeply equal []`.
     * Пустой обход соглашается с чем угодно.
     */
    expect(tree).toContain('GET');
    for (const url of ['snapshot', 'events', 'stream', 'health']) {
      expect(tree, `маршрут ${url} не виден в обходе`).toContain(url);
    }

    for (const method of WRITE_METHODS) {
      expect(tree, `дерево маршрутов содержит ${method}`).not.toContain(method);
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

  /**
   * MAJOR-4 независимой проверки тестов, закрыт по CR-I03-01 (одобрен владельцем 2026-08-29).
   *
   * ПУСТАЯ проекция — не то же самое, что «клиент не отстал». Проекция бывает пустой законно:
   * её только что пересобрали, или она ещё не дошла до генезиса. Клиент, пришедший с
   * `Last-Event-ID: 42`, в этот момент отстал НАСТОЛЬКО, что доступного для него нет вовсе, и
   * это ровно тот случай, ради которого существует `reset_required`.
   *
   * До починки условие требовало `earliestAvailableSequence !== null`, поэтому здесь не
   * срабатывало ничего: поток открывался и молчал. Экран показывал «Поток: подключён» и не
   * обновлялся, а зритель не мог отличить это от мира, в котором ничего не происходит.
   *
   * Убрать проверку на `null` было нельзя без change request: `earliest_available_sequence` был
   * объявлен `ProjectionSequenceSchema` с `min = 1`, и состояния «доступного нет» в допустимом
   * множестве не существовало — ни `0`, ни `null` схему не проходили.
   */
  it('пустая проекция при last_event_id > 0 даёт reset_required, а не молчащий поток', async () => {
    const app = server(
      port({
        loadEvents: async () =>
          await Promise.resolve({ events: [], earliestAvailableSequence: null }),
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/v1/stream?last_event_id=42',
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
    // `null`, а не `0`: отсутствие доступного номера — это отсутствие, а не нулевой номер.
    expect(text).toContain('"earliest_available_sequence":null');
    expect(text).not.toContain(`event: ${OBSERVER_STREAM_EVENT_NAMES.event}`);

    await app.close();
  });

  /**
   * Обратная сторона той же границы: пустая проекция и клиент БЕЗ позиции — это не сброс.
   * Новый зритель на пустом мире обязан получить открытый поток и ждать первых событий, а не
   * требование перечитать снимок, которого ещё нет.
   */
  it('пустая проекция без last_event_id сбросом не является', async () => {
    const app = server(
      port({
        loadEvents: async () =>
          await Promise.resolve({ events: [], earliestAvailableSequence: null }),
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/v1/stream',
      payloadAsStream: true,
    });

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      response.stream().on('data', (chunk: Buffer) => chunks.push(chunk));
      setTimeout(() => response.stream().destroy(), 300);
      response.stream().on('close', () => resolve());
    });

    expect(Buffer.concat(chunks).toString('utf8')).not.toContain('"reason":"reset_required"');
    await app.close();
  });

  /**
   * ГРАНИЦА D10, а не только явная дыра. Условие сброса — `cursor + 1 < earliest`, и обе его
   * стороны наблюдаемы: сдвиг на единицу в одну сторону даёт ЛОЖНЫЕ сбросы исправным клиентам
   * (лента перезапрашивается на каждом переподключении), в другую — МОЛЧАЛИВУЮ потерю ровно
   * одного события. Проверялась только явная дыра (5 против 50), при которой оба сдвига
   * выглядят одинаково.
   */
  it('дыры нет (следующее доступное — ровно следующее за курсором): поток идёт, сброса нет', async () => {
    const app = server(
      port({
        loadEvents: async () =>
          await Promise.resolve({ events: [feedEvent(6)], earliestAvailableSequence: 6 }),
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/v1/stream?last_event_id=5',
      payloadAsStream: true,
    });

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      response.stream().on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).toString('utf8').includes('id: 6')) resolve();
      });
    });

    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('id: 6');
    expect(text).not.toContain(`event: ${OBSERVER_STREAM_EVENT_NAMES.reset}`);

    response.stream().destroy();
    await app.close();
  });

  it('пропущено ровно одно событие — это уже дыра, и клиент о ней узнаёт', async () => {
    const app = server(
      port({
        loadEvents: async () =>
          await Promise.resolve({ events: [feedEvent(7)], earliestAvailableSequence: 7 }),
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
    expect(text).toContain('"reason":"reset_required"');
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

describe('m5/m7 независимого аудита I03 — готовность и контракт потока', () => {
  /**
   * m5. `/ready` без обращения к зависимости означает «процесс запустился», а не «могу
   * обслуживать»: балансировщик направит трафик туда, где все `/v1/*` ответят ошибкой.
   *
   * Проверяются ОБА исхода, потому что различать их и есть смысл проверки: недоступная база —
   * не готов, отсутствующий мир — готов, просто показывать нечего.
   */
  it('недоступная проекция даёт 503 с названной причиной', async () => {
    const app = server(
      port({
        loadSnapshot: async () => await Promise.reject(new Error('connection refused')),
      }),
    );
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      reason: 'projection_unavailable',
    });
    await app.close();
  });

  it('мира ещё нет — сервис ГОТОВ: показывать нечего, но обслуживать он может', async () => {
    const app = server(port({ loadSnapshot: async () => await Promise.resolve(null) }));
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  /**
   * m7. Поток — единственный публичный ответ вне сериализации по схеме: остальные маршруты
   * отдают ответ через TypeBox, где `additionalProperties: false` отсекает лишнее поле, а кадр
   * пишется в сокет напрямую. Лишнее поле приходит не из литерала в коде (его поймал бы
   * компилятор), а из колонки таблицы в рантайме — поэтому проверка нужна именно на выходе.
   */
  it('лишнее поле в событии не уходит в поток, а роняет запрос', async () => {
    const leaky = { ...feedEvent(2), last_event_sequence: 7 } as unknown as ObserverEvent;
    const app = server(
      port({
        loadEvents: async () =>
          await Promise.resolve({ events: [leaky], earliestAvailableSequence: 1 }),
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
      response.stream().on('data', (chunk: Buffer) => chunks.push(chunk));
      response.stream().on('end', () => resolve());
      response.stream().on('close', () => resolve());
    });

    const text = Buffer.concat(chunks).toString('utf8');
    // Главное: утёкшего поля в проводе НЕТ.
    expect(text).not.toContain('last_event_sequence');
    response.stream().destroy();
    await app.close();
  });

  it('исправное событие в поток проходит — проверка не запрещает нормальную работу', async () => {
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
    expect(Buffer.concat(chunks).toString('utf8')).toContain('id: 2');
    response.stream().destroy();
    await app.close();
  });
});
