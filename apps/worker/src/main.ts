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
  qualifyCanonicalWriter,
  runWorldTick,
} from '@zona/persistence';
import {
  createProjectionDatabase,
  loadProjectionCursor,
  parseProjectionDatabaseUrl,
  type ProjectionDatabase,
} from '@zona/projections';
import { loadConfig } from './config.ts';
import {
  createProjectionAtGenesis,
  genesisFromSnapshot,
  rebuildProjection,
  runProjectionStep,
  type ProjectionBuilderDeps,
} from './projection-builder.ts';
import { worldBundles, worldRuntimeProfile } from './world-bundles.ts';
import { createWorldStep } from './world-step.ts';
import { createWorker, type ClockPort, type SleepPort } from './worker.ts';

/**
 * Как часто worker спрашивает мир, не созрело ли действие. Секунда — компромисс: реакция
 * достаточно быстрая, чтобы зритель не заметил задержки, и достаточно редкая, чтобы холостой
 * опрос не был заметен в нагрузке. На СКОРОСТЬ мира не влияет.
 */
const POLL_INTERVAL_MS = 1000;

/**
 * Начальная расстановка агентов из генезисного снимка. Отказ громкий: мир, созданный до I03,
 * снимка не имеет, и собирать проекцию не из чего — придумывать историю сборщик не имеет права.
 */
const requireGenesis = async (db: ReturnType<typeof createDatabase>, worldId: string) => {
  const genesis = await genesisFromSnapshot(db, worldId, worldBundles(), worldRuntimeProfile());
  if (genesis === null) {
    throw new Error(
      `worker: у мира ${worldId} нет генезисного снимка (sequence 0). Он пишется при "world ` +
        'init" начиная с I03; мир, созданный раньше, обязан быть пересоздан либо получить снимок ' +
        'вручную — начальную расстановку агентов вывести из журнала невозможно.',
    );
  }
  return genesis;
};

/**
 * Открывает хранилище проекции и создаёт проекцию, если её ещё нет.
 *
 * `null` — `PROJECTION_DATABASE_URL` не задан: worker двигает мир, но ленты и карты не будет.
 * Об этом ГОВОРИТСЯ в логе запуска: молча не собирать проекцию значило бы, что зритель видит
 * замерший мир и не знает почему.
 */
const openProjection = async (
  projectionDatabaseUrl: string | undefined,
  db: ReturnType<typeof createDatabase>,
  worldId: string,
  logger: {
    warn: (fields: Record<string, unknown>, msg: string) => void;
    info: (fields: Record<string, unknown>, msg: string) => void;
  },
): Promise<{ deps: ProjectionBuilderDeps; close: () => Promise<void> } | null> => {
  if (projectionDatabaseUrl === undefined) {
    logger.warn(
      { worldId },
      'projection.disabled: PROJECTION_DATABASE_URL не задан — карта и лента собираться не будут',
    );
    return null;
  }

  const store: ProjectionDatabase = createProjectionDatabase(
    parseProjectionDatabaseUrl(projectionDatabaseUrl),
  );
  const deps: ProjectionBuilderDeps = {
    canonical: db,
    projection: store,
    worldId,
    now: () => new Date(),
    logger: { info: (fields, msg) => logger.info(fields, msg) },
  };

  const cursor = await loadProjectionCursor(store, worldId);
  if (cursor === null) {
    await createProjectionAtGenesis(deps, await requireGenesis(db, worldId));
  }

  return { deps, close: async () => await store.destroy() };
};

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

  // M-C: worker — второй канонический писатель, и он проходит тот же шлюз, что CLI. Проверка
  // при старте: профиль процесса не меняется, пока процесс жив, а отказ на старте видно сразу,
  // тогда как отказ на первом же тике выглядел бы как «мир почему-то не идёт».
  await qualifyCanonicalWriter(db, config.worldId, worldRuntimeProfile());

  const workerOwner = `worker:${config.deploymentId}:${String(process.pid)}`;

  const projection = await openProjection(config.projectionDatabaseUrl, db, config.worldId, logger);

  // Пересборка — отдельный режим, а не побочный эффект запуска: стереть проекцию мира, потому
  // что «процесс всё равно стартует», однажды сотрёт её у того, кто этого не хотел (D7).
  if (process.argv.includes('--rebuild-projection')) {
    if (projection === null) {
      throw new Error(
        'worker: --rebuild-projection требует PROJECTION_DATABASE_URL — пересобирать нечего.',
      );
    }
    const genesis = await requireGenesis(db, config.worldId);
    const result = await rebuildProjection(projection.deps, genesis);
    logger.info({ applied: result.applied, worldId: config.worldId }, 'projection.rebuilt');
    await projection.close();
    await db.destroy();
    return;
  }

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
        // Проекция догоняется ПОСЛЕ шага мира, в том же цикле. Отдельный процесс дал бы вторую
        // точку отказа и вторую задержку между фактом и его видимостью, а выигрыша не дал бы:
        // писатель проекции всё равно один.
        if (projection !== null) await runProjectionStep(projection.deps);
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
      projection: projection === null ? 'disabled' : 'enabled',
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
