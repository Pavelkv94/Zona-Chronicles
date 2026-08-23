/**
 * apps/api — точка входа observer API (I03).
 *
 * Подключение идёт к ХРАНИЛИЩУ ПРОЕКЦИИ и под ролью `zona_api`: у неё есть `SELECT` только на
 * `projection_*`, поэтому попытка прочитать канонические таблицы отвергается базой, а не
 * отсутствием кода (D5). Тип `ProjectionDatabase` вдобавок их не выражает — два независимых слоя
 * одной границы.
 */
import pino from 'pino';
import {
  createProjectionDatabase,
  loadObserverEvents,
  loadObserverSnapshot,
  parseProjectionDatabaseUrl,
} from '@zona/projections';
import { ENVELOPE_SCHEMA_VERSION } from '@zona/contracts';
import { loadConfig } from './config.ts';
import { buildServer, type UptimePort } from './server.ts';

/** Real uptime port: `process.uptime()` is already process-start-relative, no Date.now() needed. */
const processUptime: UptimePort = {
  uptimeMs: () => Math.round(process.uptime() * 1000),
};

/**
 * Версия правил в `/health` остаётся заявленной операцией, а не прочитанной из мира: API не имеет
 * доступа к каноническим таблицам, где она хранится, и получать её через проекцию значило бы
 * добавить в observer-слой поле ради health-check.
 */
const RULES_VERSION_UNKNOWN = 'unknown-to-observer';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });

  const projection = createProjectionDatabase(
    parseProjectionDatabaseUrl(config.projectionDatabaseUrl),
  );

  const app = buildServer({
    deploymentId: config.deploymentId,
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    rulesVersion: RULES_VERSION_UNKNOWN,
    uptime: processUptime,
    observer: {
      worldId: config.worldId,
      observer: {
        loadSnapshot: async (worldId) => await loadObserverSnapshot(projection, worldId),
        loadEvents: async (worldId, options) =>
          await loadObserverEvents(projection, worldId, options),
      },
    },
  });

  await app.listen({ port: config.port, host: config.host });
  logger.info(
    { port: config.port, host: config.host, deploymentId: config.deploymentId },
    'api.listening',
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'api.shutdown.start');
    app
      .close()
      .then(async () => {
        await projection.destroy();
        logger.info({ signal }, 'api.shutdown.complete');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ signal, error }, 'api.shutdown.failed');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  // No logger available yet if parseConfig/buildServer threw before pino was constructed.
  console.error('api.startup.failed', error);
  process.exit(1);
});
