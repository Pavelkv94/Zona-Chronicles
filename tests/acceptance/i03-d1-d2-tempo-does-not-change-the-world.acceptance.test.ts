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
import { killAndWait } from '../support/kill-child.ts';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';
import {
  assertCalmLocationsMatchMap,
  calmLegs,
  parseAgentLocations,
  type CalmLeg,
} from '../support/calm-routes.ts';

const WORKER_ENTRY = fileURLToPath(new URL('../../apps/worker/src/main.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORLD_ID = 'world:prototype';
const SEED = 42;

/** Один и тот же набор команд для всех трёх миров, с ФИКСИРОВАННЫМИ идентификаторами. */
/**
 * Команды выводятся из КАРТЫ и из расстановки, а не выписаны руками.
 *
 * Раньше пары «агент — маршрут» были фиксированы и держались на расстановке конкретного seed.
 * Расстановка меняется вместе с картой, и тест падал с `route_unavailable` — по причине, к
 * утверждению D1/D2 отношения не имеющей.
 *
 * Дороги берутся спокойные: с I06-C агент, попавший в опасное место, уходит сам, и тогда журнал
 * содержал бы не только то, что велел оператор. Для утверждения «темп ничего не меняет» это не
 * помеха, но лишний шум сравнивать труднее, а причину расхождения — искать дольше.
 *
 * Идентификаторы команд остаются ДЕТЕРМИНИРОВАННЫМИ: у обоих миров один seed, значит одна
 * расстановка, значит одни и те же команды с одними и теми же id.
 */
const commandsFor = (
  legs: readonly CalmLeg[],
): readonly { readonly agent: string; readonly route: string; readonly id: string }[] =>
  legs.map((leg, index) => ({
    agent: leg.agentId,
    route: leg.routeId,
    id: `cmd_D2FIXED000000000000000${String(index + 1)}`,
  }));

/** Всё, что делает событие событием, кроме отметки стенных часов записи. */
const canonicalShape = (event: WorldEvent) => {
  const { recorded_at: _recordedAt, ...rest } = event;
  return rest;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Мировой момент выдачи всех команд теста: стартовое время мира прототипа. */
const ISSUED_AT = '2028-04-26T06:00:00.000Z';

/**
 * Сравнивать журналы миров с разной скоростью можно только за ОДИНАКОВОЕ МИРОВОЕ время (I04).
 *
 * До нужд это было незаметно: события порождались только командами, поэтому быстрый мир за то же
 * реальное время проживал ровно те же восемь фактов. С нуждами само течение времени рождает
 * события, и мир при темпе 600 успевает прожить двое суток там, где мир при темпе 6 — два часа.
 * Лишние события у быстрого мира — не расхождение, а прожитая жизнь.
 *
 * Поэтому сравнивается ПРЕФИКС по мировому времени: оба мира прошли одни и те же моменты, и
 * утверждение «темп не меняет мир» проверяется там, где оно вообще имеет смысл.
 */
const upTo = (journal: readonly WorldEvent[], bound: string): readonly WorldEvent[] =>
  journal.filter((event) => event.world_time <= bound);

/** Последний мировой момент, до которого дошли ОБА сравниваемых мира. */
const commonBound = (journal: readonly WorldEvent[]): string => {
  const journeys = journal.filter((event) => event.type === 'journey.completed');
  const last = journeys.at(-1);
  if (last === undefined) throw new Error('журнал не содержит ни одного завершённого пути');
  return last.world_time;
};

describe('I03 D1/D2 — скорость мира не меняет канонический журнал', () => {
  const created: TestDatabase[] = [];

  /** Расстановка по выводу `world state` — тем же способом, каким её видит оператор. */
  const agentLocationsOf = (
    cli: (argv: readonly string[]) => { readonly stdout: string; readonly exitCode: number | null },
  ): Readonly<Record<string, string>> => {
    const state = cli(['world', 'state']);
    expect(state.exitCode, state.stdout).toBe(0);
    return parseAgentLocations(state.stdout);
  };

  /** Сколько команд оператор подал в каждый мир. Заполняется первым созданным миром. */
  let commandCount = 0;

  const makeWorld = async (label: string): Promise<TestDatabase> => {
    const db = await createTestDatabase(label);
    created.push(db);
    const cli = (argv: readonly string[]) =>
      spawnWorldCliDirect(argv, { env: { DATABASE_URL: db.url } });
    expect(cli(['world', 'migrate']).exitCode).toBe(0);
    expect(cli(['world', 'init', '--seed', String(SEED)]).exitCode).toBe(0);
    assertCalmLocationsMatchMap();
    const commands = commandsFor(calmLegs(agentLocationsOf(cli)));
    expect(commands.length, 'нужен хотя бы один агент в спокойном месте').toBeGreaterThan(0);
    commandCount = commands.length;
    for (const command of commands) {
      const started = cli([
        'world',
        'run',
        '--agent',
        command.agent,
        '--route',
        command.route,
        '--command-id',
        command.id,
        // Момент выдачи команды закреплён ЯВНО (I04). Он стал настоящим входом: мир штампует
        // внешнюю команду тем временем, до которого дошёл по разрешению темпа, а оно у миров с
        // разной скоростью разное. Без закрепления два мира разошлись бы ЗАКОННО, и тест
        // объявил бы нарушением детерминизма то, что им не является.
        '--at-world-time',
        ISSUED_AT,
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
      // started + completed + решение прибывшего на каждую команду (I05-B). Число обязано быть
      // ПОЛНЫМ: помощник убивает worker-а, как только счётчик достигнут, и заниженное ожидание
      // останавливает мир на середине — а сравнение двух миров потом объявляет это расхождением
      // темпов. Так этот тест и упал впервые.
      const expected = commandCount * 4;
      /**
       * Дедлайн — это СТРАЖ ЗАВИСАНИЯ, а не утверждение о скорости.
       *
       * Утверждение теста — «журналы двух темпов совпадают», и оно проверяется ниже сравнением
       * содержимого. Сколько реального времени понадобилось медленному миру, к утверждению
       * отношения не имеет, а под нагрузкой прежние 90 секунд кончались раньше мира. Найдено
       * независимым test-review I04-I06 (группа A) и подтверждено падением в цепочке gate.
       *
       * Поднято до четырёх минут, а не снято совсем: без дедлайна зависший worker дал бы не
       * падение, а вечный тест.
       */
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        if ((await journalOf(db)).length >= expected) return;
        await sleep(300);
      }
      throw new Error(`worker (темп ${String(tempo)}) не довёл мир до ${String(expected)} событий`);
    } finally {
      await killAndWait(worker);
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

    const bound = commonBound(slowJournal);
    const slowPrefix = upTo(slowJournal, bound);
    const fastPrefix = upTo(fastJournal, bound);

    // Четыре события на команду: старт, завершение, РАЗВЕДКА пройденной дороги (I06-B) и
    // решение прибывшего агента (I05-B). Пин остаётся точным числом, а не «не меньше»: он
    // страхует от сравнения пустых префиксов, и мягкая форма перестала бы это делать.
    expect(slowPrefix.length).toBe(commandCount * 4);
    expect(fastPrefix.map(canonicalShape)).toEqual(slowPrefix.map(canonicalShape));
  });

  it('D1: непрерывный ход даёт тот же журнал, что пошаговый world tick --advance', async () => {
    const liveJournal = await journalOf(slow);
    const stepJournal = await journalOf(stepwise);

    const bound = commonBound(liveJournal);
    const livePrefix = upTo(liveJournal, bound);
    const stepPrefix = upTo(stepJournal, bound);

    expect(stepPrefix.length).toBe(livePrefix.length);
    expect(stepPrefix.map(canonicalShape)).toEqual(livePrefix.map(canonicalShape));
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
