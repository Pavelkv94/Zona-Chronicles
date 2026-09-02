/**
 * D9 — возобновление потока по `Last-Event-ID` на НАСТОЯЩЕЙ проекции.
 *
 * ## Что уже проверено и чего не хватало
 *
 * `observer-routes.contract.test.ts` проверяет разбор `Last-Event-ID` (заголовок против query,
 * непригодные значения) и то, что поток отдаёт события после курсора. Всё это — на ЗАГЛУШКЕ
 * порта: подставная функция возвращает выдуманный список.
 *
 * Последняя строка критерия при этом звучит так: «ни одно событие МЕЖДУ K и переподключением не
 * потеряно». Её заглушкой доказать нельзя: она про то, что произошло с ХРАНИЛИЩЕМ, пока клиент
 * был отключён. Здесь проверяется именно это — события дописываются в проекцию между двумя
 * подключениями, и второе обязано их отдать: каждое по одному разу и по возрастанию.
 *
 * ## Почему сервер настоящий, а хранилище настоящее
 *
 * Порт подменён быть не может: подмена сняла бы ровно тот слой, где дефект и живёт — переход от
 * курсора клиента к запросу в базу. Поэтому `buildServer` получает порт, ходящий в реальный
 * `projection_*`, и запросы идут через `app.inject`.
 *
 * Импорты относительные — `tests/` не workspace-пакет.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObserverEvent } from '../../packages/contracts/src/index.ts';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../packages/persistence/src/__fixtures__/migrated-database.ts';
import {
  createProjectionDatabase,
  initialObserverProjection,
  initializeProjection,
  loadObserverEvents,
  loadObserverSnapshot,
  parseProjectionDatabaseUrl,
  saveProjectionStep,
  type ObserverProjectionState,
  type ProjectionDatabase,
} from '../../packages/projections/src/index.ts';
import { buildServer } from '../../apps/api/src/server.ts';

const WORLD_ID = 'world:resume';
const GENESIS_TIME = '2028-04-26T06:00:00.000Z';

/**
 * Сколько читать ПОСЛЕ появления искомого события, прежде чем утверждать «пришло ровно это».
 * Дубли приходят следующим опросом потока; тест, закрывающий соединение сразу, их не видит.
 * Окно взято с запасом к интервалу опроса: одного лишнего опроса хватает, два дают устойчивость.
 */
const GRACE_MS = 1500;

/**
 * Алфавит Crockford base32 — тот же, что в контракте `event_id`. Взят ЦЕЛИКОМ из него, а не
 * составлен арифметикой по кодам символов: первая редакция брала `String.fromCharCode(64 + seq)`
 * и на девятом событии выдала `I`, которой в алфавите нет (исключены I, L, O, U — они путаются с
 * 1 и 0). Тест падал, и падал справедливо.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const baseState = (): ObserverProjectionState =>
  initialObserverProjection({
    worldId: WORLD_ID,
    worldTime: GENESIS_TIME,
    nodes: [{ location_id: 'loc:a', name: 'А', description: 'узел А' }],
    edges: [
      {
        route_id: 'route:a-b',
        from_location_id: 'loc:a',
        to_location_id: 'loc:b',
        travel_minutes: 10,
      },
    ],
    agents: [
      {
        agent_id: 'agent:one',
        name: 'Один',
        location_id: 'loc:a',
        status: 'idle',
        route_id: null,
        needs: { hunger: 'normal', fatigue: 'normal' },
        food_carried: 0,
        goal: 'idle' as const,
      },
    ],
  });

const feedEntry = (seq: number): ObserverEvent => ({
  projection_sequence: seq,
  // Идентификатор соответствует КОНТРАКТУ (ULID: 26 символов Crockford base32), а не просто
  // «выглядит уникально». Прежняя редакция подставляла `evt_001`, и это работало ровно потому,
  // что никто не проверял: с появлением проверки кадра (m7 аудита) поток стал справедливо
  // рваться, а тест — падать по таймауту. Фикстура, не проходящая собственный контракт, — та же
  // ложь о системе, только со стороны теста.
  event_id: `evt_${'0'.repeat(25)}${CROCKFORD[seq % CROCKFORD.length]!}`,
  world_time: `2028-04-26T06:${String(seq).padStart(2, '0')}:00.000Z`,
  type: 'journey.started',
  actor_ids: ['agent:one'],
  location_id: 'loc:a',
  route_id: 'route:a-b',
  need: null,
  need_level: null,
  goal: null,
});

describe('D9 — переподключение не теряет событий, появившихся во время разрыва', () => {
  let migrated: MigratedDatabase;
  let projection: ProjectionDatabase;

  /** Дописывает в проекцию события с курсорами `from..to` включительно, как это делает сборщик. */
  const append = async (from: number, to: number): Promise<void> => {
    const emitted = [];
    for (let seq = from; seq <= to; seq += 1) emitted.push(feedEntry(seq));
    await saveProjectionStep(
      projection,
      { ...baseState(), projectionSequence: to, lastEventSequence: to, worldTime: GENESIS_TIME },
      emitted,
      new Date(),
    );
  };

  const server = () =>
    buildServer({
      deploymentId: 'test-resume',
      schemaVersion: 1,
      rulesVersion: 'test',
      uptime: { uptimeMs: () => 0 },
      observer: {
        worldId: WORLD_ID,
        observer: {
          loadSnapshot: async (worldId) => await loadObserverSnapshot(projection, worldId),
          loadEvents: async (worldId, options) =>
            await loadObserverEvents(projection, worldId, options),
        },
      },
    });

  /**
   * Читает поток, пока не увидит `id: <until>`, и возвращает все встреченные id по порядку.
   *
   * `duringStream` вызывается ПОСЛЕ открытия потока — это единственный способ проверить цикл
   * опроса, а не только первичный догон. Разница не теоретическая: мутация «цикл перечитывает
   * ленту с нуля» проходила все существовавшие проверки, потому что ни одна не доживала до
   * второй итерации цикла. Именно этот дефект пришлось ловить руками в браузере при реализации —
   * события двоились, и спасала только защита от дублей на экране.
   */
  const readStreamUntil = async (
    lastEventId: number,
    until: number,
    duringStream?: () => Promise<void>,
  ): Promise<number[]> => {
    const app = server();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/stream',
        headers: { 'last-event-id': String(lastEventId) },
        payloadAsStream: true,
      });
      expect(response.statusCode).toBe(200);

      const chunks: Buffer[] = [];
      if (duringStream !== undefined) await duringStream();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`поток не дошёл до id: ${String(until)} за 15 секунд`));
        }, 15_000);
        /**
         * ПОСЛЕ появления искомого id читаем ещё окно ожидания, а не рвём поток немедленно.
         *
         * Дефект в МОЕЙ первой редакции, найденный ревьюером исполнением. Тест резолвился на
         * первом же появлении `id: <until>` и закрывал соединение — а дубли приходят СЛЕДУЮЩИМ
         * опросом, то есть после того, как тест уже всё решил. Мутация «курсор не двигается»
         * проходила весь набор: 487 contract и 119 integration зелёные. Ревьюер продлил чтение
         * на 1.5 с при той же мутации и получил
         *   expected [ 8, 9, 8, 9, 8, 9 ] to deeply equal [ 8, 9 ]
         * — сервер дублировал, а тест этого не видел, при том что докстринг файла утверждал
         * обратное: что цикл опроса покрыт.
         */
        let grace: NodeJS.Timeout | undefined;
        response.stream().on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          const seen = Buffer.concat(chunks)
            .toString('utf8')
            .includes(`id: ${String(until)}\n`);
          if (seen && grace === undefined) {
            grace = setTimeout(() => {
              clearTimeout(timer);
              resolve();
            }, GRACE_MS);
          }
        });
        response.stream().on('error', (error: Error) => {
          clearTimeout(timer);
          if (grace !== undefined) clearTimeout(grace);
          reject(error);
        });
      });

      const text = Buffer.concat(chunks).toString('utf8');
      response.stream().destroy();
      return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    } finally {
      await app.close();
    }
  };

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i03_stream_resume');
    projection = createProjectionDatabase(parseProjectionDatabaseUrl(migrated.testDb.url));
    const state = baseState();
    await initializeProjection(
      projection,
      state,
      { nodes: Object.values(state.nodes), edges: Object.values(state.edges) },
      new Date(),
    );
    await append(1, 5);
  }, 120_000);

  afterAll(async () => {
    await projection.destroy();
    await migrated.close();
  });

  it('второе подключение отдаёт ровно то, что появилось после разрыва', async () => {
    // Клиент дочитал до 5.
    const first = await readStreamUntil(3, 5);
    expect(first).toEqual([4, 5]);

    // Разрыв. Пока его нет, мир прожил ещё два события.
    await append(6, 7);

    // Переподключение с последней известной позиции.
    const second = await readStreamUntil(5, 7);
    expect(second).toEqual([6, 7]);
  });

  it('повторное подключение с той же позиции не отдаёт уже полученное дважды', async () => {
    const again = await readStreamUntil(5, 7);
    expect(again).toEqual([6, 7]);
    expect(new Set(again).size).toBe(again.length);
  });

  /**
   * Цикл опроса, а не первичный догон. Клиент подключается на актуальной позиции, ничего не
   * получает, и события появляются УЖЕ ПРИ ОТКРЫТОМ потоке.
   */
  it('события, появившиеся при открытом потоке, приходят по одному разу и только новые', async () => {
    const live = await readStreamUntil(7, 9, async () => {
      await append(8, 9);
    });

    expect(live).toEqual([8, 9]);
  });

  /**
   * Обработчик потока не отклоняется, когда зритель ушёл, а хранилище стало недоступно.
   *
   * Найдено полным прогоном, а не прогоном этого файла: файл зеленел («3 passed»), а код возврата
   * набора был единицей — vitest считает необработанные отклонения на уровне ПРОГОНА. Fastify на
   * отклонённый промис пытается ответить ошибкой, а заголовки уже ушли, и получается
   * `ERR_HTTP_HEADERS_SENT`.
   *
   * Здесь это воспроизводится честно: поток открыт, клиент уходит, хранилище закрывается. Именно
   * такая последовательность и бывает в жизни — вкладку закрыли, база ушла на обслуживание.
   */
  it('уход зрителя и падение хранилища не дают необработанного отклонения', async () => {
    const app = server();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/stream',
      headers: { 'last-event-id': '0' },
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);

    // Зритель ушёл посреди потока.
    response.stream().destroy();

    // И хранилище стало недоступно: следующий опрос обязан упасть.
    const casualty = createProjectionDatabase(parseProjectionDatabaseUrl(migrated.testDb.url));
    await casualty.destroy();

    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on('unhandledRejection', onRejection);
    try {
      // Дольше интервала опроса: цикл обязан успеть сходить в базу хотя бы раз.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      process.off('unhandledRejection', onRejection);
      await app.close();
    }

    expect(rejections).toEqual([]);
  });
});
