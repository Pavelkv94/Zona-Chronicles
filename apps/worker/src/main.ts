/**
 * apps/worker — точка входа процесса, который ДВИГАЕТ МИР (I03).
 *
 * До I03 здесь был скелет I00: `step` — честный no-op, а расписание разбирал `world tick`,
 * запускаемый оператором. Из-за этого трассировка PR-04 утверждала больше доказанного (M8 аудита
 * I02B): «мир существует и меняется без открытого браузера» держалось на человеке у терминала.
 *
 * Теперь шаг вычисляет горизонт по темпу мира и отдаёт его `runWorldTick`. Ни один вход этого
 * вычисления не зависит от зрителя — это решение владельца, выраженное конструкцией.
 *
 * Опрос идёт чаще, чем мир меняется, и это НЕ влияет на скорость мира: горизонт растёт от
 * реального времени, а не от числа опросов (`world-step.test.ts`). `POLL_INTERVAL_MS` определяет
 * только задержку реакции на созревшее действие.
 */
import pino from 'pino';
import {
  createDatabase,
  loadWorldState,
  parseDatabaseConnectionUrl,
  runWorldTick,
} from '@zona/persistence';
import { loadConfig } from './config.ts';
import { createWorldStep } from './world-step.ts';
import { createWorker, type ClockPort, type SleepPort } from './worker.ts';

/**
 * Как часто worker спрашивает мир, не созрело ли действие. Секунда — компромисс: реакция
 * достаточно быстрая, чтобы зритель не заметил задержки, и достаточно редкая, чтобы холостой
 * опрос не был заметен в нагрузке. На СКОРОСТЬ мира не влияет.
 */
const POLL_INTERVAL_MS = 1000;

async function main(): Promise<void> {
  // §12 03_TECHNICAL_DESIGN: fails closed if NODE_ENV=production and DEPLOYMENT_ID is missing —
  // see apps/worker/src/config.ts.
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });

  const clock: ClockPort = { now: () => Date.now() };
  const sleeper: SleepPort = {
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };

  const db = createDatabase(parseDatabaseConnectionUrl(config.databaseUrl));

  // Точка отсчёта темпа — мировое время НА МОМЕНТ СТАРТА. Мир, простоявший ночь, продолжается с
  // того момента, где остановился, а не проматывает пропущенное залпом (см. `world-step.ts`).
  const startState = await loadWorldState(db, config.worldId);
  if (startState === null) {
    throw new Error(
      `worker: мир ${config.worldId} не создан. Сначала "pnpm world init --seed N" — двигать ` +
        'несуществующий мир нечем, и притворяться работающим процессу нельзя.',
    );
  }

  const workerOwner = `worker:${config.deploymentId}:${String(process.pid)}`;

  const worker = createWorker({
    clock,
    sleeper,
    pollIntervalMs: POLL_INTERVAL_MS,
    step: createWorldStep({
      startWorldTime: startState.worldTime,
      realNowMs: () => clock.now(),
      tempo: { worldMinutesPerRealSecond: config.worldMinutesPerRealSecond },
      tick: async ({ horizon }) => {
        const result = await runWorldTick(db, {
          worldId: config.worldId,
          owner: workerOwner,
          horizon,
        });
        return { claimed: result.claimed, worldTime: result.worldTime };
      },
      logger: {
        info: (fields, msg) => {
          logger.info(fields, msg);
        },
      },
    }),
    logger: {
      info: (fields, msg) => {
        logger.debug(fields, msg);
      },
    },
  });

  worker.start();
  logger.info(
    {
      pollIntervalMs: POLL_INTERVAL_MS,
      deploymentId: config.deploymentId,
      worldId: config.worldId,
      worldMinutesPerRealSecond: config.worldMinutesPerRealSecond,
      startWorldTime: startState.worldTime,
      owner: workerOwner,
    },
    'worker.started',
  );

  let shuttingDown = false;
  function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'worker.shutdown.start');
    worker
      .stop()
      .then(() => {
        logger.info({ signal }, 'worker.shutdown.complete');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ signal, error }, 'worker.shutdown.failed');
        process.exit(1);
      });
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

try {
  await main();
} catch (error: unknown) {
  // No logger available yet if loadConfig threw before pino was constructed.
  console.error('worker.startup.failed', error);
  process.exit(1);
}
