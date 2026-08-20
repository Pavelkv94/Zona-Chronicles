/**
 * apps/api — единственное место, читающее окружение процесса (I00 skeleton).
 *
 * `parseConfig` — чистая функция: она принимает уже прочитанный `Record<string, string | undefined>`
 * (обычно `process.env`), поэтому её можно протестировать без реального процесса. Никакие секреты
 * не читаются и не пробрасываются: allowlist ниже — исчерпывающий список поддерживаемых ключей,
 * остальные переменные окружения молча игнорируются.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type Config = {
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly deploymentId: string;
};

const DEFAULTS = {
  port: 3000,
  host: '0.0.0.0',
  logLevel: 'info' as LogLevel,
  deploymentId: 'local-dev',
};

const MIN_PORT = 1;
const MAX_PORT = 65535;

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULTS.port;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid config: PORT must be an integer, got ${JSON.stringify(raw)}.`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(
      `Invalid config: PORT must be between ${MIN_PORT} and ${MAX_PORT}, got ${parsed}.`,
    );
  }
  return parsed;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) {
    return DEFAULTS.logLevel;
  }
  if (!isLogLevel(raw)) {
    throw new Error(
      `Invalid config: LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(raw)}.`,
    );
  }
  return raw;
}

/**
 * Разбирает и валидирует окружение процесса в `Config`.
 * Читает только `PORT`, `HOST`, `LOG_LEVEL`, `DEPLOYMENT_ID` — все остальные ключи игнорируются.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  return {
    port: parsePort(env['PORT']),
    host: env['HOST'] ?? DEFAULTS.host,
    logLevel: parseLogLevel(env['LOG_LEVEL']),
    deploymentId: env['DEPLOYMENT_ID'] ?? DEFAULTS.deploymentId,
  };
}
