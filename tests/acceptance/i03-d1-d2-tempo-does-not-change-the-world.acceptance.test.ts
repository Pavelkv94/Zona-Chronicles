/**
 * D1/D2 — темп мира меняет КОГДА, но не ЧТО (`ACCEPTANCE.md` итерации I03).
 *
 * ## Что здесь проверяется и почему этого не было
 *
 * Критерии заканчиваются самыми сильными и самыми проверяемыми утверждениями итерации:
 *
 *   D1: «журнал тот же, что при пошаговом `world tick --advance` на ту же длительность»;
 *   D2: «два прогона с РАЗНОЙ скоростью мира и одинаковым seed → канонический журнал побайтово
 *        одинаков, и скорость НЕ входит в `deterministic_runtime_profile`».
 *
 * До этого теста ни одно из них не исполнялось. `world-tempo.test.ts` проверял арифметику
 * горизонта, наличие версии у темпа и отказ на неположительном коэффициенте — свойства модуля
 * темпа. Из них не следует, что мир, прожитый быстро, совпадает с миром, прожитым медленно:
 * именно это и есть SIM-01, и именно это могло бы сломаться незаметно.
 *
 * ## Три мира, а не два
 *
 * A — worker с темпом 6 минут мира за секунду;
 * B — worker с темпом 600, в сто раз быстрее;
 * C — БЕЗ worker-а вовсе: `world tick --advance` шагами оператора.
 *
 * Третий мир закрывает последнюю строку D1: непрерывный ход обязан совпасть с пошаговым. Без
 * него сравнивались бы два worker-а между собой, то есть одна и та же ветка кода с собой же.
 *
 * ## Что сравнивается и что исключено
 *
 * Сравниваются ВСЕ поля события, кроме `recorded_at`: это отметка стенных часов записи, и она
 * различна по определению — мир, проживший то же самое в другое реальное время, записал это в
 * другую секунду. Исключение ровно одно, и оно названо; всё остальное, включая `event_checksum`,
 * `command_id`, `correlation_id` и `payload`, обязано совпасть.
 *
 * Чтобы совпадение вообще было достижимо, командам задан ЯВНЫЙ `--command-id`. Без него CLI
 * генерирует его от `randomUUID` на каждый вызов, и журналы разошлись бы из-за разных команд
 * оператора, а не из-за темпа — это доказывало бы не то. `correlation_id` и `event_id` выводятся
 * из `command_id`, поэтому фиксации одного достаточно.
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
  loadLatestSnapshot,
  loadWorldEvents,
  parseDatabaseConnectionUrl,
} from '../../packages/persistence/src/index.ts';
import type { WorldEvent } from '../../packages/contracts/src/index.ts';
import { currentBundles, currentDeterministicRuntimeProfile } from '../../apps/cli/src/world.ts';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';

const WORKER_ENTRY = fileURLToPath(new URL('../../apps/worker/src/main.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORLD_ID = 'world:prototype';
const SEED = 42;

/** Один и тот же набор команд для всех трёх миров, с ФИКСИРОВАННЫМИ идентификаторами. */
const COMMANDS: readonly { readonly agent: string; readonly route: string; readonly id: string }[] =
  [
    { agent: 'agent:rook', route: 'route:yard-to-bridge', id: 'cmd_D2FIXED0000000000000001' },
    { agent: 'agent:kite', route: 'route:yard-to-bridge', id: 'cmd_D2FIXED0000000000000002' },
    {
      agent: 'agent:finch',
      route: 'route:bridge-to-checkpoint',
      id: 'cmd_D2FIXED0000000000000003',
    },
  ];

/** Всё, что делает событие событием, кроме отметки стенных часов записи. */
const canonicalShape = (event: WorldEvent) => {
  const { recorded_at: _recordedAt, ...rest } = event;
  return rest;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('I03 D1/D2 — скорость мира не меняет канонический журнал', () => {
  const created: TestDatabase[] = [];

  const makeWorld = async (label: string): Promise<TestDatabase> => {
    const db = await createTestDatabase(label);
    created.push(db);
    const cli = (argv: readonly string[]) =>
      spawnWorldCliDirect(argv, { env: { DATABASE_URL: db.url } });
    expect(cli(['world', 'migrate']).exitCode).toBe(0);
    expect(cli(['world', 'init', '--seed', String(SEED)]).exitCode).toBe(0);
    for (const command of COMMANDS) {
      const started = cli([
        'world',
        'run',
        '--agent',
        command.agent,
        '--route',
        command.route,
        '--command-id',
        command.id,
      ]);
      expect(started.exitCode, started.stdout).toBe(0);
    }
    return db;
  };

  const journalOf = async (db: TestDatabase): Promise<readonly WorldEvent[]> => {
    const connection = createDatabase(parseDatabaseConnectionUrl(db.url));
    try {
      return await loadWorldEvents(connection, WORLD_ID);
    } finally {
      await connection.destroy();
    }
  };

  const runtimeProfileOf = async (db: TestDatabase) => {
    const connection = createDatabase(parseDatabaseConnectionUrl(db.url));
    try {
      const snapshot = await loadLatestSnapshot(connection, WORLD_ID, {
        bundles: currentBundles(),
        runtimeProfile: currentDeterministicRuntimeProfile(),
      });
      return snapshot?.deterministic_runtime_profile ?? null;
    } finally {
      await connection.destroy();
    }
  };

  /** Гоняет настоящий worker до тех пор, пока журнал не перестанет расти. */
  const liveUntilQuiet = async (db: TestDatabase, tempo: number): Promise<void> => {
    const worker: ChildProcess = spawn('node', [WORKER_ENTRY], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        WORLD_MINUTES_PER_REAL_SECOND: String(tempo),
        LOG_LEVEL: 'silent',
        // Проекция здесь ни при чём: проверяется КАНОНИЧЕСКИЙ журнал.
        PROJECTION_DATABASE_URL: '',
      },
    });
    try {
      const expected = COMMANDS.length * 2; // started + completed на каждую команду
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if ((await journalOf(db)).length >= expected) return;
        await sleep(300);
      }
      throw new Error(`worker (темп ${String(tempo)}) не довёл мир до ${String(expected)} событий`);
    } finally {
      worker.kill('SIGKILL');
      await new Promise((resolve) => worker.once('exit', resolve));
    }
  };

  let slow: TestDatabase;
  let fast: TestDatabase;
  let stepwise: TestDatabase;

  beforeAll(async () => {
    slow = await makeWorld('acceptance_i03_d2_slow');
    fast = await makeWorld('acceptance_i03_d2_fast');
    stepwise = await makeWorld('acceptance_i03_d2_stepwise');

    await liveUntilQuiet(slow, 6);
    await liveUntilQuiet(fast, 600);

    // Третий мир не видел worker-а вовсе: время двигает оператор.
    const tick = spawnWorldCliDirect(['world', 'tick', '--advance', '120'], {
      env: { DATABASE_URL: stepwise.url },
    });
    expect(tick.exitCode, tick.stdout).toBe(0);
  }, 300_000);

  afterAll(async () => {
    for (const db of created) await db.drop();
  });

  it('D2: сто крат разницы в темпе не меняют ни одного поля журнала, кроме отметки записи', async () => {
    const slowJournal = await journalOf(slow);
    const fastJournal = await journalOf(fast);

    expect(slowJournal.length).toBe(COMMANDS.length * 2);
    expect(fastJournal.map(canonicalShape)).toEqual(slowJournal.map(canonicalShape));
  });

  it('D1: непрерывный ход даёт тот же журнал, что пошаговый world tick --advance', async () => {
    const liveJournal = await journalOf(slow);
    const stepJournal = await journalOf(stepwise);

    expect(stepJournal.length).toBe(liveJournal.length);
    expect(stepJournal.map(canonicalShape)).toEqual(liveJournal.map(canonicalShape));
  });

  it('D2: темп не входит в deterministic_runtime_profile — ни значением, ни ключом', async () => {
    const slowProfile = await runtimeProfileOf(slow);
    const fastProfile = await runtimeProfileOf(fast);

    expect(slowProfile).not.toBeNull();
    expect(fastProfile).toEqual(slowProfile);

    // Отдельно от равенства: профиль вообще не содержит понятия скорости. Равенство двух
    // профилей могло бы держаться на том, что оба прогона случайно шли одинаково.
    const serialized = JSON.stringify(slowProfile);
    for (const forbidden of ['tempo', 'speed', 'minutes_per', 'real_second']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
