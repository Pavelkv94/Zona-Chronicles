/**
 * apps/api — process entrypoint (I00 skeleton). Reads env once via `parseConfig`, builds the
 * Fastify instance, listens, and shuts down gracefully on SIGTERM/SIGINT.
 */
import pino from 'pino';
import { loadConfig } from './config.ts';
import { buildServer, type UptimePort } from './server.ts';

/** Real uptime port: `process.uptime()` is already process-start-relative, no Date.now() needed. */
const processUptime: UptimePort = {
  uptimeMs: () => Math.round(process.uptime() * 1000),
};

/** I00 placeholders: real schema/rules versioning is introduced in I01/I02B (@zona/contracts). */
const SCHEMA_VERSION_PLACEHOLDER = 0;
const RULES_VERSION_PLACEHOLDER = '0.0.0-unset';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });

  const app = buildServer({
    deploymentId: config.deploymentId,
    schemaVersion: SCHEMA_VERSION_PLACEHOLDER,
    rulesVersion: RULES_VERSION_PLACEHOLDER,
    uptime: processUptime,
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
      .then(() => {
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
