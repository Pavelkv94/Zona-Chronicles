/**
 * D6 — сборщик проекции переживает УБИЙСТВО ПРОЦЕССА, а не только повторный вызов шага
 * (`docs/iterations/I03-journey-to-browser/ACCEPTANCE.md`).
 *
 * ## Зачем отдельный тест, если D6 уже «покрыт»
 *
 * `tests/integration/i03-projection-builder.test.ts` вызывает `runProjectionStep` дважды в одном
 * процессе и проверяет, что второй вызов не добавил ничего. Это доказывает ИДЕМПОТЕНТНОСТЬ ШАГА
 * и не доказывает того, что написано в критерии: «процесс сборщика убит и запущен заново».
 *
 * Разница не формальная. Повторный вызов в живом процессе продолжает работу с состоянием,
 * которое уже в памяти; убитый и заново запущенный процесс обязан ВОССТАНОВИТЬ курсор из базы.
 * Ошибка в этом пути — сборщик, начинающий с нуля или с чужой позиции, — даёт дубли или дыры и
 * не видна ни одному in-process тесту.
 *
 * ## Что этот тест НЕ доказывает, и это установлено пробой
 *
 * Он НЕ доказывает атомарность шага. Проба: границу транзакции внутри `saveProjectionStep`
 * временно разорвали — курсор стал продвигаться отдельной транзакцией через 120 мс после записи
 * ленты. Этот тест прошёл ПЯТЬ раз из пяти.
 *
 * Причина арифметическая, а не случайная: убийство приходится на фиксированный момент после
 * старта процесса, окно уязвимости — миллисекунды на шаг, и попасть в него систематически
 * нельзя. Довести такой тест до «иногда ловит» можно, но тест, ловящий дефект иногда, в gate
 * хуже отсутствующего: он создаёт впечатление проверки и добавляет мигание.
 *
 * Атомарность проверяется детерминированно и там, где она объявлена, —
 * `packages/projections/src/projection-store.integration.test.ts`.
 *
 * ## Почему SIGKILL, а не SIGTERM
 *
 * `SIGTERM` даёт процессу закрыться штатно — это проверка выключения, а не сбоя. `SIGKILL` не
 * оставляет процессу ни одного шанса, и именно так выглядит падение узла, OOM или потеря
 * контейнера.
 *
 * Момент убийства не подбирается: он случайный относительно фазы догона. Поэтому убийств
 * несколько — одиночное могло бы каждый раз приходиться на паузу между шагами и не проверять
 * ничего. Тест не требует, чтобы убийство попало в транзакцию; он требует, чтобы РЕЗУЛЬТАТ был
 * верен при любом попадании.
 *
 * ## Что именно проверяется в конце
 *
 * Не «проекция непуста» — этого достигает и сборщик, потерявший половину журнала. Проверяется
 * точное соответствие ленты каноническому журналу: столько же записей, те же `event_id`, каждый
 * ровно один раз, курсор строго возрастает без пропусков.
 *
 * Импорты относительные — `tests/` не workspace-пакет.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../packages/persistence/src/__fixtures__/test-database.ts';
import {
  createDatabase,
  loadWorldEvents,
  parseDatabaseConnectionUrl,
} from '../../packages/persistence/src/index.ts';
import {
  createProjectionDatabase,
  loadObserverEvents,
  parseProjectionDatabaseUrl,
} from '../../packages/projections/src/index.ts';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';

/**
 * Читаем через ПУБЛИЧНЫЕ функции пакетов, а не своим клиентом `pg`.
 *
 * Прямой `pg` в корне репозитория запрещён намеренно: его наличие в корневых зависимостях уже
 * один раз МОЛЧА ослабило контроль границ — фикстура `core-has-no-adapter-dependencies`
 * перестала ловить импорт `pg` из `packages/simulation` (найдено в I03). Тест, ради удобства
 * возвращающий такую зависимость, отключил бы контроль повторно.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL('../../apps/worker/src/main.ts', import.meta.url));
const ROLE_PASSWORD = 'zona_local_dev_only';
const SEED = 42;
const WORLD_ID = 'world:prototype';

/** Маршруты кольца: агент ходит туда-обратно, поэтому событий можно сделать сколько нужно. */
const RING: Readonly<Record<string, readonly [string, string]>> = {
  'agent:rook': ['route:yard-to-bridge', 'route:bridge-to-yard'],
  'agent:kite': ['route:yard-to-bridge', 'route:bridge-to-yard'],
  'agent:finch': ['route:bridge-to-checkpoint', 'route:checkpoint-to-bridge'],
  'agent:swift': ['route:checkpoint-to-bridge', 'route:bridge-to-checkpoint'],
};

const roleUrl = (url: string, user: string): string => {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = ROLE_PASSWORD;
  return parsed.toString();
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('I03 D6 — убитый сборщик проекции догоняет журнал ровно один раз на событие', () => {
  let db: TestDatabase;
  let canonicalEventIds: string[] = [];

  const cli = (argv: readonly string[]) =>
    spawnWorldCliDirect(argv, { env: { DATABASE_URL: db.url } });

  const canonicalLog = async (): Promise<readonly string[]> => {
    const canonical = createDatabase(parseDatabaseConnectionUrl(db.url));
    try {
      const events = await loadWorldEvents(canonical, WORLD_ID);
      return events.map((event) => event.event_id);
    } finally {
      await canonical.destroy();
    }
  };

  /** Лента проекции целиком, прочитанная тем же путём, каким её читает observer API. */
  const projectionFeed = async (): Promise<readonly { event_id: string; seq: number }[]> => {
    const projection = createProjectionDatabase(
      parseProjectionDatabaseUrl(roleUrl(db.url, 'zona_projection')),
    );
    try {
      const page = await loadObserverEvents(projection, WORLD_ID, { after: 0, limit: 1000 });
      return page.events.map((event) => ({
        event_id: event.event_id,
        seq: event.projection_sequence,
      }));
    } finally {
      await projection.destroy();
    }
  };

  /** Запускает НАСТОЯЩИЙ процесс worker-а: тот же вход, что у `pnpm worker`. */
  const startWorker = (): ChildProcess =>
    spawn('node', [WORKER_ENTRY], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        PROJECTION_DATABASE_URL: roleUrl(db.url, 'zona_projection'),
        // Быстрый темп: журнал должен успеть наполниться до убийства. На то, КАКИМИ будут
        // события, темп не влияет (D2).
        WORLD_MINUTES_PER_REAL_SECOND: '600',
        // Пачка в два события — не «настройка ради теста», а единственный способ вообще
        // НАБЛЮДАТЬ то, что требует D6. При умолчании 200 догон мира из полутора десятков
        // событий целиком укладывается в ОДНУ транзакцию, и убить сборщик посреди догона
        // невозможно. Первая редакция этого теста именно так и проходила, ничего не проверив:
        // три SIGKILL не заставали сборщик за работой ни разу (поймано проверкой ниже).
        PROJECTION_BATCH_SIZE: '2',
        LOG_LEVEL: 'silent',
      },
    });

  beforeAll(async () => {
    db = await createTestDatabase('acceptance_i03_d6');
    expect(cli(['world', 'migrate']).exitCode).toBe(0);
    expect(cli(['world', 'init', '--seed', String(SEED)]).exitCode).toBe(0);

    // Наполняем журнал: четыре агента по кольцу, чтобы догон был не мгновенным и убийство
    // имело шанс попасть внутрь него.
    for (const [agentId, [outbound]] of Object.entries(RING)) {
      const started = cli(['world', 'run', '--agent', agentId, '--route', outbound]);
      expect(started.exitCode, started.stdout).toBe(0);
    }
    // Доводим пути до конца БЕЗ сборщика: канонический журнал наполняется, проекция отстаёт.
    const tick = cli(['world', 'tick', '--advance', '120']);
    expect(tick.exitCode, tick.stdout).toBe(0);
    for (const [agentId, [, inbound]] of Object.entries(RING)) {
      expect(cli(['world', 'run', '--agent', agentId, '--route', inbound]).exitCode).toBe(0);
    }
    expect(cli(['world', 'tick', '--advance', '120']).exitCode).toBe(0);

    canonicalEventIds = [...(await canonicalLog())];
    // Меньше десятка событий сделали бы догон мгновенным, и убийство никогда бы в него не попало.
    expect(canonicalEventIds.length).toBeGreaterThanOrEqual(8);

    // Проекции ещё нет вовсе: её создаёт первый запуск worker-а из генезисного снимка.
    expect(await projectionFeed()).toEqual([]);
  }, 180_000);

  afterAll(async () => {
    await db.drop();
  });

  it('D6: три SIGKILL посреди догона не дают ни пропусков, ни дублей', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = (await projectionFeed()).length;
      const worker = startWorker();
      try {
        // Убиваем не по таймеру, а КАК ТОЛЬКО сборщик сделал шаг.
        //
        // Первая редакция ждала фиксированные 400-900 мс от запуска и была мигающей: под
        // нагрузкой (полный gate плюс параллельные прогоны) процесс не успевал стартовать, ни
        // одно убийство не заставало его за работой, и проверка на пустоту роняла gate. Она и
        // должна была — тест в этот момент ничего не проверял, — но контроль, зависящий от
        // скорости старта Node, не контроль, а генератор мигания.
        //
        // Ожидание РОСТА, а не «непустоты»: на втором и третьем заходе лента уже не пуста.
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          if ((await projectionFeed()).length > before) break;
          await sleep(25);
        }
      } finally {
        worker.kill('SIGKILL');
        await new Promise((resolve) => worker.once('exit', resolve));
      }
    }

    // ПРОВЕРКА САМОГО ТЕСТА, а не мира. Если бы ни одно убийство не заставало сборщик за
    // работой, тест проходил бы, ничего не проверив: последний, неубитый запуск собрал бы всё, и
    // результат сошёлся бы независимо от того, восстанавливается ли курсор из базы. Требуем,
    // чтобы проекция была ЧАСТИЧНОЙ: что-то записано и записано не всё.
    //
    // Второе неравенство держится арифметикой, а не удачей: worker опрашивает мир раз в секунду
    // и применяет по одной пачке (здесь — два события), поэтому догон 16 событий занимает около
    // восьми секунд, а три убийства успевают лишь к шести записям.
    const partial = await projectionFeed();
    expect(
      partial.length,
      'ни одно убийство не застало сборщик за работой — тест бесполезен',
    ).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(canonicalEventIds.length);

    // Последний запуск доводит догон до конца и работает штатно.
    const survivor = startWorker();
    try {
      const deadline = Date.now() + 60_000;
      let feed: readonly { event_id: string; seq: number }[] = [];
      while (Date.now() < deadline) {
        feed = await projectionFeed();
        if (feed.length >= canonicalEventIds.length) break;
        await sleep(250);
      }

      // Ровно столько же записей, сколько событий: ни пропусков, ни дублей.
      expect(feed.map((row) => row.event_id)).toEqual(canonicalEventIds);

      // Курсор строго возрастает и не имеет дыр: 1..N.
      expect(feed.map((row) => row.seq)).toEqual(canonicalEventIds.map((_, index) => index + 1));
    } finally {
      survivor.kill('SIGKILL');
      await new Promise((resolve) => survivor.once('exit', resolve));
    }
  }, 180_000);
});
