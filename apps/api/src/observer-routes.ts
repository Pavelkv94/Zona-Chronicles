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
import { TypeCompiler } from '@sinclair/typebox/compiler';
import {
  OBSERVER_STREAM_EVENT_NAMES,
  ObserverEventSchema,
  ObserverStreamResetSchema,
  ObserverWorldSnapshotSchema,
  ProjectionSequenceSchema,
  decodeObserverEvent,
  isValidationFailure,
  type ObserverEvent,
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

/**
 * Ответ страницы ленты. Форма маршрута, но правило поля — из контракта, а не переписанное рядом.
 *
 * Здесь стояло `Type.Integer({ minimum: 1 })` — копия `PROJECTION_SEQUENCE_UNIT.min`, сделанная
 * руками. Копия не ломается, когда расходится с оригиналом: она просто начинает описывать другое.
 * Замечено при закрытии MAJOR-4 — то же самое поле в замороженной схеме сброса `null` не
 * допускало, а здесь допускало всегда, и два описания одного поля жили рядом, не зная друг о
 * друге.
 */
const EventPageResponseSchema = Type.Object(
  {
    events: Type.Array(ObserverEventSchema),
    earliest_available_sequence: Type.Union([ProjectionSequenceSchema, Type.Null()]),
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

/** Как часто молчащий поток напоминает о себе комментарием, чтобы его не оборвал прокси. */
const KEEP_ALIVE_MS = 15_000;

/** Один кадр SSE. Формат текстовый и построчный — собирается здесь, а не разбросан по коду. */
/**
 * Кадр SSE — ЕДИНСТВЕННЫЙ публичный ответ вне сериализации Fastify по схеме (m7 аудита I03).
 *
 * Обычные маршруты отдают ответ через TypeBox: схема с `additionalProperties: false` отсекает
 * лишнее поле на выходе. Поток пишется в сокет напрямую, поэтому такой отсечки у него нет — и
 * именно потоком утекло бы поле, случайно попавшее в объект из колонки таблицы. Тип на входе
 * этого не ловит: он проверяется при компиляции, а лишнее поле приходит в рантайме.
 *
 * Поэтому данные кадра проверяются схемой ПЕРЕД записью. Отказ громкий: молча отправить
 * непроверенное — ровно то, от чего защищает `additionalProperties: false` на остальных путях.
 */
/** Проверка кадра события контрактом: та же схема, что у ленты, включая additionalProperties. */
const eventIssues = (value: unknown): readonly string[] => {
  const decoded = decodeObserverEvent(value);
  return isValidationFailure(decoded)
    ? decoded.errors.map((issue) => `${issue.path} ${issue.message}`)
    : [];
};

/**
 * Проверка управляющего кадра. Схема заморожена вместе с остальным observer-контрактом.
 *
 * Отдельного декодера у неё нет — она не пересекает границу процесса в обратную сторону, — поэтому
 * проверка идёт компилятором TypeBox напрямую.
 */
const resetChecker = TypeCompiler.Compile(ObserverStreamResetSchema);
const resetIssues = (value: unknown): readonly string[] =>
  [...resetChecker.Errors(value)].map((issue) => `${issue.path} ${issue.message}`);

const sseFrame = (input: {
  readonly id?: number;
  readonly event: string;
  readonly data: unknown;
  readonly validate?: (value: unknown) => readonly string[];
}): string => {
  const issues = input.validate?.(input.data) ?? [];
  if (issues.length > 0) {
    throw new Error(
      `observer-routes: кадр потока "${input.event}" не соответствует контракту: ` +
        `${issues.join('; ')}. Поток — единственный публичный ответ вне сериализации по схеме, ` +
        'поэтому проверка здесь и есть та самая отсечка лишнего.',
    );
  }
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

    // Заголовки, уже поставленные хуками Fastify (CORS в первую очередь), ПЕРЕНОСЯТСЯ в сырой
    // ответ. Первая редакция писала только свои — и `writeHead` затирал всё остальное, из-за чего
    // на потоке не оказывалось `Access-Control-Allow-Origin`: браузер молча отказывался
    // подключаться, а обычные `GET` при этом работали. Найдено живым прогоном: экран показывал
    // мир, но «Поток: нет», и в консоли не было ничего, что указывало бы на причину.
    const inheritedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (typeof value === 'string') inheritedHeaders[name] = value;
      else if (Array.isArray(value)) inheritedHeaders[name] = value.join(', ');
      else if (typeof value === 'number') inheritedHeaders[name] = String(value);
    }

    reply.raw.writeHead(200, {
      ...inheritedHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Прокси, буферизующий поток, превратил бы «живую ленту» в пакетную доставку раз в минуту.
      'X-Accel-Buffering': 'no',
    });
    // Заголовки отправляются НЕМЕДЛЕННО. Без этого Node держит их до первой записи, и в мире, где
    // пока ничего не произошло, поток не открывался вовсе: браузер ждал ответа, `open` не
    // наступал, экран показывал «Поток: нет» — и никакой ошибки при этом не было. Ручная проверка
    // это скрывала, потому что в живом мире события уже были и первая же запись заголовки
    // выталкивала. Найдено E2E-сценарием на свежесозданном мире.
    reply.raw.flushHeaders();

    let cursor = resume;
    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    /**
     * Запись в поток, переживающая УХОД КЛИЕНТА.
     *
     * Найдено полным прогоном, а не прогоном файла: зритель, закрывший вкладку посреди кадра,
     * заставлял `reply.raw.write` бросить на разрушенном сокете. Ошибка выходила из async-хендлера
     * УЖЕ ПОСЛЕ отправки заголовков, Fastify пытался ответить ошибкой и падал с
     * `ERR_HTTP_HEADERS_SENT` — необработанным rejection. Тестовый файл при этом зеленел: vitest
     * считает такие ошибки на уровне ПРОГОНА, а не файла, и код возврата отличался от «3 passed».
     *
     * Уход клиента — не сбой сервера. Это самое обычное событие: вкладку закрывают. Поэтому
     * запись возвращает `false` и помечает поток закрытым, а не бросает.
     */
    const safeWrite = (chunk: string): boolean => {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) return false;
      try {
        reply.raw.write(chunk);
        return true;
      } catch {
        closed = true;
        return false;
      }
    };

    /** Завершение потока с тем же условием: закрывать уже закрытое — не ошибка, а шум. */
    const safeEnd = (): void => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.end();
      } catch {
        closed = true;
      }
    };

    // Первая же выборка отвечает на вопрос, доступна ли запрошенная позиция (D10).
    const first = await observer.loadEvents(worldId, { after: cursor, limit: MAX_EVENT_PAGE });
    /**
     * Отставание клиента — это ДВА случая, а не один, и второй раньше выпадал (MAJOR-4).
     *
     * `earliestAvailableSequence === null` означает пустую проекцию: доступного нет вовсе.
     * Клиент с позицией отстал настолько, что предложить ему нечего, — то есть сброс нужен тем
     * более. Прежнее условие требовало непустоты и потому молчало именно там, где сказать было
     * обязательно.
     *
     * `cursor > 0` остаётся в обоих случаях: новый зритель на пустом мире не отстал ни от чего
     * и обязан получить открытый поток, а не требование перечитать снимок, которого ещё нет.
     */
    const behindWindow =
      first.earliestAvailableSequence === null || cursor + 1 < first.earliestAvailableSequence;
    if (cursor > 0 && behindWindow) {
      // Клиент отстал за пределы окна: между его позицией и первой доступной есть дыра. Молча
      // отдать ленту с этого места значило бы, что зритель не узнает о пропуске.
      // Тип контракта, а не свободный объект: поле, разошедшееся со схемой, обязано ломать
      // компиляцию здесь, а не обнаруживаться у зрителя как непонятое сообщение.
      const reset: ObserverStreamReset = {
        reason: 'reset_required',
        earliest_available_sequence: first.earliestAvailableSequence,
      };
      safeWrite(
        sseFrame({
          event: OBSERVER_STREAM_EVENT_NAMES.reset,
          data: reset,
          validate: resetIssues,
        }),
      );
      safeEnd();
      return reply;
    }

    /**
     * Кадр, не прошедший контракт, ЗАВЕРШАЕТ поток, а не подвешивает его.
     *
     * Заголовки уже отправлены, поэтому обычный путь Fastify «бросить и получить 500» здесь
     * недоступен: исключение из обработчика оставило бы соединение открытым навсегда, и зритель
     * ждал бы событий, которых не будет. Проверено исполнением — тест на утёкшее поле висел до
     * таймаута. Закрытое соединение EventSource переоткрывает сам, и следующая попытка либо
     * получит исправный кадр, либо снова закроется — но зритель не окажется в тишине, приняв её
     * за спокойный мир.
     */
    const writeEvent = (event: ObserverEvent): boolean => {
      try {
        return safeWrite(
          sseFrame({
            id: event.projection_sequence,
            event: OBSERVER_STREAM_EVENT_NAMES.event,
            data: event,
            validate: eventIssues,
          }),
        );
      } catch (error) {
        // Сюда попадает ТОЛЬКО нарушение контракта: отказ записи `safeWrite` уже поглотил.
        request.log.error({ worldId, error: String(error) }, 'observer.stream.contract_violation');
        safeEnd();
        return false;
      }
    };

    for (const event of first.events) {
      if (!writeEvent(event)) return reply;
      cursor = event.projection_sequence;
    }

    /**
     * Обработчик потока НЕ ИМЕЕТ ПРАВА отклоняться после отправки заголовков.
     *
     * Fastify на отклонённый промис пытается ответить ошибкой, а заголовки уже ушли — получается
     * `ERR_HTTP_HEADERS_SENT` и НЕОБРАБОТАННЫЙ rejection. Найдено полным прогоном: файл теста
     * зеленел («3 passed»), а код возврата всего набора был единицей — vitest считает такие
     * ошибки на уровне прогона, а не файла.
     *
     * Источник в цикле опроса: он продолжает ходить в базу и после того, как зритель ушёл, — а
     * закрытие соединения для внедрённого запроса не всегда поднимает `close`. Любой отказ здесь
     * означает «поток дальше не идёт», и правильный ответ — назвать причину и закрыть, а не
     * отдать её Fastify, которому уже нечего с ней делать.
     */
    let quietPolls = 0;
    try {
      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, streamPollMs));
        if (closed) break;
        const page = await observer.loadEvents(worldId, { after: cursor, limit: MAX_EVENT_PAGE });
        if (page.events.length === 0) {
          quietPolls += 1;
          // Комментарий SSE (строка, начинающаяся с двоеточия) — не событие: клиент его
          // игнорирует. Он нужен, чтобы молчащий мир не выглядел оборванным соединением для
          // прокси и балансировщиков, которые закрывают тихие потоки по таймауту.
          if (quietPolls * streamPollMs >= KEEP_ALIVE_MS) {
            if (!safeWrite(': keep-alive\n\n')) break;
            quietPolls = 0;
          }
          continue;
        }
        quietPolls = 0;
        for (const event of page.events) {
          if (!writeEvent(event)) return reply;
          cursor = event.projection_sequence;
        }
      }
    } catch (error) {
      request.log.error({ worldId, error: String(error) }, 'observer.stream.aborted');
    }

    safeEnd();
    return reply;
  });
}
