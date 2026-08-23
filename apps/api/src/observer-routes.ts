/**
 * Публичные read-only маршруты наблюдателя (I03, §7 `03_TECHNICAL_DESIGN`).
 *
 * ## Зритель не влияет на мир
 *
 * Ни один обработчик здесь не пишет никуда и не сообщает миру о своём существовании. Число
 * подключений, их отсутствие и значение `Last-Event-ID` не участвуют ни в одном вычислении,
 * касающемся канонического состояния (D3). Мир двигает worker по своему темпу, и подписчик для
 * него не существует.
 *
 * ## Восстановление не зависит от истории потока
 *
 * `GET /v1/world/snapshot` самодостаточен: карта, агенты и курсор, с которого можно продолжить.
 * Это OPS-02 и D11 — страница, перезагруженная при выключенном SSE, обязана показать актуальный
 * мир. Поэтому лента в snapshot НЕ входит: иначе размер ответа рос бы с возрастом мира, и
 * восстановление однажды перестало бы работать именно у старых миров.
 */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  OBSERVER_STREAM_EVENT_NAMES,
  ObserverEventSchema,
  ObserverWorldSnapshotSchema,
  type ObserverStreamReset,
} from '@zona/contracts';
import type { ObserverPort } from './observer-port.ts';

/** Верхняя граница страницы ленты: server-side maximum, а не то, что попросил клиент (§7). */
export const MAX_EVENT_PAGE = 200;
const DEFAULT_EVENT_PAGE = 50;

const EventPageQuerySchema = Type.Object(
  {
    after: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EVENT_PAGE })),
  },
  { additionalProperties: false },
);

const EventPageResponseSchema = Type.Object(
  {
    events: Type.Array(ObserverEventSchema),
    earliest_available_sequence: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const NotFoundSchema = Type.Object(
  { error: Type.Literal('world_not_found'), world_id: Type.String() },
  { additionalProperties: false },
);

export interface ObserverRoutesOptions {
  readonly observer: ObserverPort;
  readonly worldId: string;
  /** Как часто поток опрашивает проекцию. Инъектирован, чтобы тест не зависел от wall clock. */
  readonly streamPollMs?: number;
}

const DEFAULT_STREAM_POLL_MS = 500;

/** Один кадр SSE. Формат текстовый и построчный — собирается здесь, а не разбросан по коду. */
const sseFrame = (input: {
  readonly id?: number;
  readonly event: string;
  readonly data: unknown;
}): string => {
  const lines = [
    ...(input.id === undefined ? [] : [`id: ${String(input.id)}`]),
    `event: ${input.event}`,
    `data: ${JSON.stringify(input.data)}`,
    '',
    '',
  ];
  return lines.join('\n');
};

/**
 * С какой позиции продолжать поток.
 *
 * `Last-Event-ID` — стандартный заголовок переподключения EventSource; браузер шлёт его сам.
 * Query-параметр поддержан для клиентов, которые EventSource не используют (и для проверки
 * руками). Заголовок имеет приоритет: его ставит браузер, и он отражает реально полученное.
 */
export const resumeFrom = (
  header: string | undefined,
  query: string | undefined,
): number | 'invalid' => {
  const raw = header ?? query;
  if (raw === undefined || raw.trim().length === 0) return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 'invalid';
  return parsed;
};

export function registerObserverRoutes(app: FastifyInstance, options: ObserverRoutesOptions): void {
  const { observer, worldId } = options;
  const streamPollMs = options.streamPollMs ?? DEFAULT_STREAM_POLL_MS;

  app.get(
    '/v1/world/snapshot',
    { schema: { response: { 200: ObserverWorldSnapshotSchema, 404: NotFoundSchema } } },
    async (_request, reply) => {
      const snapshot = await observer.loadSnapshot(worldId);
      if (snapshot === null) {
        // Мир не создан либо проекция не собрана. Для зрителя это одно и то же: смотреть не на
        // что. Различать их наружу значило бы рассказывать о внутреннем устройстве.
        return await reply.code(404).send({ error: 'world_not_found' as const, world_id: worldId });
      }
      return await reply.send(snapshot);
    },
  );

  app.get(
    '/v1/events',
    {
      schema: {
        querystring: EventPageQuerySchema,
        response: { 200: EventPageResponseSchema },
      },
    },
    async (request, reply) => {
      const query = request.query as { after?: number; limit?: number };
      const page = await observer.loadEvents(worldId, {
        after: query.after ?? 0,
        limit: Math.min(query.limit ?? DEFAULT_EVENT_PAGE, MAX_EVENT_PAGE),
      });
      return await reply.send({
        events: page.events,
        earliest_available_sequence: page.earliestAvailableSequence,
      });
    },
  );

  /**
   * SSE-поток ленты.
   *
   * Реализован опросом проекции, а не подпиской на БД: `LISTEN/NOTIFY` привязал бы observer-путь
   * к каноническому процессу, который эти уведомления шлёт, и один зритель на медленном соединении
   * задерживал бы мир. Опрос стоит задержки в полсекунды и НИЧЕГО не стоит миру — а это ровно тот
   * размен, который требует D3.
   */
  app.get('/v1/stream', async (request, reply) => {
    const query = request.query as { last_event_id?: string };
    const resume = resumeFrom(
      request.headers['last-event-id'] as string | undefined,
      query.last_event_id,
    );
    if (resume === 'invalid') {
      return await reply.code(400).send({ error: 'invalid_last_event_id' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Прокси, буферизующий поток, превратил бы «живую ленту» в пакетную доставку раз в минуту.
      'X-Accel-Buffering': 'no',
    });

    let cursor = resume;
    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    // Первая же выборка отвечает на вопрос, доступна ли запрошенная позиция (D10).
    const first = await observer.loadEvents(worldId, { after: cursor, limit: MAX_EVENT_PAGE });
    if (
      first.earliestAvailableSequence !== null &&
      cursor > 0 &&
      cursor + 1 < first.earliestAvailableSequence
    ) {
      // Клиент отстал за пределы окна: между его позицией и первой доступной есть дыра. Молча
      // отдать ленту с этого места значило бы, что зритель не узнает о пропуске.
      // Тип контракта, а не свободный объект: поле, разошедшееся со схемой, обязано ломать
      // компиляцию здесь, а не обнаруживаться у зрителя как непонятое сообщение.
      const reset: ObserverStreamReset = {
        reason: 'reset_required',
        earliest_available_sequence: first.earliestAvailableSequence,
      };
      reply.raw.write(sseFrame({ event: OBSERVER_STREAM_EVENT_NAMES.reset, data: reset }));
      reply.raw.end();
      return reply;
    }

    for (const event of first.events) {
      reply.raw.write(
        sseFrame({
          id: event.projection_sequence,
          event: OBSERVER_STREAM_EVENT_NAMES.event,
          data: event,
        }),
      );
      cursor = event.projection_sequence;
    }

    while (!closed) {
      await new Promise((resolve) => setTimeout(resolve, streamPollMs));
      if (closed) break;
      const page = await observer.loadEvents(worldId, { after: cursor, limit: MAX_EVENT_PAGE });
      for (const event of page.events) {
        reply.raw.write(
          sseFrame({
            id: event.projection_sequence,
            event: OBSERVER_STREAM_EVENT_NAMES.event,
            data: event,
          }),
        );
        cursor = event.projection_sequence;
      }
    }

    reply.raw.end();
    return reply;
  });
}
