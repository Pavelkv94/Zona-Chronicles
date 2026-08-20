/**
 * apps/worker — process entrypoint (I00 skeleton). Reads env once via `loadConfig`, wires real
 * Clock/Sleep ports around `createWorker`, starts it, and drains gracefully on SIGTERM/SIGINT.
 * No canonical scheduler logic yet (I02B) — `step` is an honest no-op, not a simulation of real
 * work.
 */
import pino from 'pino';
import { loadConfig } from './config.ts';
import { createWorker, type ClockPort, type SleepPort } from './worker.ts';

const POLL_INTERVAL_MS = 5000;

function main(): void {
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

  const worker = createWorker({
    clock,
    sleeper,
    pollIntervalMs: POLL_INTERVAL_MS,
    // I00: no canonical scheduler exists yet (I02B). This step intentionally does nothing.
    step: async () => {},
    logger: {
      info: (fields, msg) => {
        logger.info(fields, msg);
      },
    },
  });

  worker.start();
  logger.info(
    { pollIntervalMs: POLL_INTERVAL_MS, deploymentId: config.deploymentId },
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
  main();
} catch (error: unknown) {
  // No logger available yet if loadConfig threw before pino was constructed.
  console.error('worker.startup.failed', error);
  process.exit(1);
}
