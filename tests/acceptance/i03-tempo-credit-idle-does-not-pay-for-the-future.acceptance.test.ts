/**
 * Кредит темпа: простой не оплачивает будущее. Живой мир, настоящий worker, настоящая база.
 *
 * ## Что это доказывает и почему модульного теста мало
 *
 * `world-step.test.ts` проверяет решение о горизонте на инъектированных часах — там простой
 * задаётся числом, а не проживается. Из этого не следует, что связка «worker → расписание →
 * команда, проштампованная СОХРАНЁННЫМ мировым временем» ведёт себя так же: дефект жил именно
 * в стыке. Он и проявился в стыке — на E2E-сценарии D13, где выглядел поломкой сценария.
 *
 * ## Устройство пробы
 *
 * Темп 4 минуты мира за секунду: маршрут `route:yard-to-bridge` длиной 40 мировых минут занимает
 * десять реальных секунд — достаточно, чтобы отличить его от нуля, и достаточно мало для набора.
 *
 * Мир простаивает двенадцать секунд ДО первой команды. При старой конструкции за это время
 * горизонт уходил на 48 мировых минут вперёд неподвижного мирового времени, то есть больше длины
 * маршрута: путь планировался в прошлом мира и завершался первым же опросом. Измерено ревьюером
 * на живом мире: 45 секунд тишины → `journey.completed` через одну реальную секунду.
 *
 * Измеряется РЕАЛЬНОЕ время от команды до появления `journey.completed` в каноническом журнале.
 * Разделение между дефектом и починкой — на порядок: около секунды против десяти.
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
import {
  assertCalmLocationsMatchMap,
  calmLegs,
  parseAgentLocations,
} from '../support/calm-routes.ts';

const WORKER_ENTRY = fileURLToPath(new URL('../../apps/worker/src/main.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORLD_ID = 'world:prototype';

/**
 * Минут мира за секунду реального.
 *
 * Ожидаемая длительность пути ВЫВОДИТСЯ из длины выбранной дороги, а не выписана числом: дорога
 * с I06-C выбирается из спокойных, а они разной длины. Число, закреплённое под одну карту,
 * измеряло бы карту, а не темп.
 */
const TEMPO = 4;
/** Тишина ДО команды. Заведомо больше длины любой дороги в мировых минутах, делённой на темп. */
const IDLE_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('кредит темпа: тишина не сокращает путь', () => {
  let db: TestDatabase;
  let worker: ChildProcess | null = null;
  let elapsedMs = 0;
  /** Сколько реального времени должна занять выбранная дорога при этом темпе. */
  let travelRealMs = 0;

  const journal = async () => {
    const connection = createDatabase(parseDatabaseConnectionUrl(db.url));
    try {
      return await loadWorldEvents(connection, WORLD_ID);
    } finally {
      await connection.destroy();
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase('acceptance_i03_tempo_credit');
    const cli = (argv: readonly string[]) =>
      spawnWorldCliDirect(argv, { env: { DATABASE_URL: db.url } });
    expect(cli(['world', 'migrate']).exitCode).toBe(0);
    expect(cli(['world', 'init', '--seed', '42']).exitCode).toBe(0);

    worker = spawn('node', [WORKER_ENTRY], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        WORLD_MINUTES_PER_REAL_SECOND: String(TEMPO),
        LOG_LEVEL: 'silent',
        // Проекция здесь ни при чём: измеряется канонический журнал.
        PROJECTION_DATABASE_URL: '',
      },
    });

    // Мир идёт и молчит: расписание пусто, событий нет, реальное время течёт.
    await sleep(IDLE_MS);
    expect(await journal()).toHaveLength(0);

    /**
     * Дорога берётся СПОКОЙНАЯ и выводится из расстановки, а не выписана руками.
     *
     * С I06-C агент, пришедший в опасное место, немедленно решает уйти, и журнал перестал бы
     * состоять только из того, что велел оператор, — а этот тест утверждает про его состав.
     * Расстановка же меняется вместе с картой, и жёсткая пара «агент — маршрут» упиралась бы в
     * `route_unavailable`.
     */
    assertCalmLocationsMatchMap();
    const state = cli(['world', 'state']);
    expect(state.exitCode, state.stdout).toBe(0);
    const [leg] = calmLegs(parseAgentLocations(state.stdout));
    expect(leg, 'ни один агент не стоит в спокойном месте').toBeDefined();
    if (leg === undefined) return;

    const startedAt = Date.now();
    const started = cli(['world', 'run', '--agent', leg.agentId, '--route', leg.routeId]);
    expect(started.exitCode, started.stdout).toBe(0);

    const deadline = startedAt + 60_000;
    while (Date.now() < deadline) {
      if ((await journal()).some((event) => event.type === 'journey.completed')) break;
      await sleep(200);
    }
    elapsedMs = Date.now() - startedAt;
    travelRealMs = (leg.travelMinutes / TEMPO) * 1000;
  }, 300_000);

  afterAll(async () => {
    if (worker !== null) await killAndWait(worker);
    await db.drop();
  });

  it('путь завершился, и только событиями', async () => {
    const events = await journal();
    // Третье событие — РЕШЕНИЕ прибывшего агента (I05-B): дошедший свободен, и мир немедленно
    // даёт ему выбрать, что делать дальше. Перечислено явно, а не отфильтровано: утверждение
    // «только событиями» требует знать ВСЁ, что мир произвёл, включая то, чего не ждали.
    expect(events.map((event) => event.type)).toEqual([
      'journey.started',
      'journey.completed',
      // I06-B: пройденная дорога стала известной. Разведка идёт прежде решения — агент сначала
      // приходит и видит, и только потом решает, что делать дальше.
      'risk.observed',
      'goal.chosen',
    ]);
  });

  it('путь занял своё время, а не сгорел накопленным кредитом', () => {
    /**
     * Нижняя граница с запасом на команду CLI и опрос: важно отличить «десять секунд» от «ноль»,
     * а не измерить их точно. При дефекте здесь была одна секунда.
     */
    expect(elapsedMs).toBeGreaterThanOrEqual(travelRealMs * 0.8);
    // Верхняя граница: тишина не имеет права и ЗАМЕДЛИТЬ путь.
    expect(elapsedMs).toBeLessThanOrEqual(travelRealMs * 2);
  });
});
