/**
 * PR-04 под отказом проекции — M1 независимого архитектурного аудита I03.
 *
 * ## Что было
 *
 * Ревьюер прочитал `worker.ts:45-57` и заметил: `runLoop` без `try/catch`, `start()` без
 * `.catch`, а шаг мира и догон проекции сшиты в один callback. Вывод — «любой отказ ПРОЕКЦИИ
 * останавливает КАНОНИЧЕСКИЙ мир, PR-04 держится ни на чём» — я проверил исполнением, и он
 * подтвердился дважды, причём вторая половина нашлась только после починки первой:
 *
 *   1. отказ ВО ВРЕМЯ работы уходил unhandled rejection-ом мимо `main().catch(...)` и убивал цикл;
 *   2. отказ ПРИ СТАРТЕ (`openProjection`) выходил из `main()` и завершал процесс с кодом 1.
 *
 * Живая проба на обеих: worker с исправным `DATABASE_URL` и НЕСУЩЕСТВУЮЩЕЙ базой проекции —
 * «событий до запуска: 1, через 12 секунд: 1, процесс ВЫШЕЛ с кодом 1».
 *
 * ## Что проверяется здесь
 *
 * Мир продолжает идти, когда наблюдать за ним нечем. Это не снисхождение к проекции, а порядок
 * подчинения: проекция — read model и не источник факта (`PLAN.md` §7.5), поэтому её
 * недоступность обязана делать мир НЕВИДИМЫМ, а не ОСТАНОВЛЕННЫМ. Обратное ставит наблюдение
 * выше наблюдаемого — ровно то, что запрещает PR-01/PR-04.
 *
 * Проверяется КАНОНИЧЕСКИЙ журнал, а не «процесс жив»: живой процесс, переставший двигать мир,
 * выглядит здоровым и не является им.
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
import { killAndWait } from '../support/kill-child.ts';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL('../../apps/worker/src/main.ts', import.meta.url));
const WORLD_ID = 'world:prototype';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PR-04 — недоступная проекция делает мир невидимым, а не остановленным', () => {
  let db: TestDatabase;

  const cli = (argv: readonly string[]) =>
    spawnWorldCliDirect(argv, { env: { DATABASE_URL: db.url } });

  const journalLength = async (): Promise<number> => {
    const connection = createDatabase(parseDatabaseConnectionUrl(db.url));
    try {
      return (await loadWorldEvents(connection, WORLD_ID)).length;
    } finally {
      await connection.destroy();
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase('acceptance_i03_m1');
    expect(cli(['world', 'migrate']).exitCode).toBe(0);
    expect(cli(['world', 'init', '--seed', '42']).exitCode).toBe(0);
    const started = cli([
      'world',
      'run',
      '--agent',
      'agent:rook',
      '--route',
      'route:yard-to-bridge',
    ]);
    expect(started.exitCode, started.stdout).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await db.drop();
  });

  it('мир доводит начатый путь до конца, пока база проекции недоступна', async () => {
    const before = await journalLength();
    expect(before).toBe(1); // только journey.started

    // Каноническая база исправна; база ПРОЕКЦИИ не существует.
    const brokenProjection = new URL(db.url);
    brokenProjection.pathname = '/zona_projection_database_which_does_not_exist';

    const worker: ChildProcess = spawn('node', [WORKER_ENTRY], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        PROJECTION_DATABASE_URL: brokenProjection.toString(),
        WORLD_MINUTES_PER_REAL_SECOND: '600',
        LOG_LEVEL: 'silent',
      },
    });

    let exitCode: number | null = null;
    worker.once('exit', (code) => {
      exitCode = code;
    });

    try {
      const deadline = Date.now() + 60_000;
      let after = before;
      while (Date.now() < deadline) {
        after = await journalLength();
        if (after > before) break;
        await sleep(250);
      }

      // Мир прожил journey.completed без единой команды и без работающей проекции.
      expect(after, 'мир не сдвинулся при недоступной проекции').toBeGreaterThan(before);
      // И процесс не «умер тихо»: он обязан быть жив, а не завершиться с ошибкой.
      expect(exitCode, 'worker завершился вместо того, чтобы работать без проекции').toBeNull();
    } finally {
      await killAndWait(worker);
    }
  }, 180_000);
});
