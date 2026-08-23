/**
 * apps/worker — единственное место, читающее окружение процесса.
 *
 * `parseConfig` — чистая функция: она принимает уже прочитанный `Record<string, string | undefined>`
 * (обычно `process.env`), поэтому её можно протестировать без реального процесса. Никакие секреты
 * не читаются и не пробрасываются: allowlist ниже — исчерпывающий список поддерживаемых ключей,
 * остальные переменные окружения молча игнорируются.
 *
 * `loadConfig()` — единственное место во всём apps/worker, где встречается литеральное
 * `process.env` (см. блок про apps-приложения в eslint.config.mjs): `main.ts` вызывает
 * `loadConfig()`, а не `parseConfig(process.env)` напрямую.
 */

import { DEFAULT_WORLD_TEMPO } from './world-tempo.ts';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const NODE_ENVS = ['production', 'development', 'test'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

export type Config = {
  readonly logLevel: LogLevel;
  readonly nodeEnv: NodeEnv;
  /**
   * Immutable deployment identifier (§12 03_TECHNICAL_DESIGN) — обязателен при `NODE_ENV=production`
   * (см. `parseDeploymentId`). Вне production, если ключ не задан, это видимо помеченное локальное
   * значение (`LOCAL_DEPLOYMENT_ID`), а не молчаливый прод-похожий дефолт.
   */
  readonly deploymentId: string;
  /**
   * Подключение к каноническому хранилищу (I03). Обязательно: worker без базы не может двигать
   * мир, и запускаться «вхолостую» ему нельзя — молчащий процесс неотличим от работающего.
   */
  readonly databaseUrl: string;
  /**
   * Идентификатор мира, который двигает этот worker. Один worker — один мир (PLAN §5 I02B:
   * несколько миров одновременно вне scope).
   */
  readonly worldId: string;
  /** Минут мирового времени за секунду реального; по умолчанию — `DEFAULT_WORLD_TEMPO`. */
  readonly worldMinutesPerRealSecond: number;
};

const LOCAL_DEPLOYMENT_ID = 'local-dev-unset';

const DEFAULTS = {
  logLevel: 'info' as LogLevel,
  nodeEnv: 'development' as NodeEnv,
  worldId: 'world:prototype',
};

/**
 * Темп читается из окружения, но ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ живёт не здесь, а в `world-tempo.ts`
 * вместе со своей версией: окружение может его переопределить, но не определяет (PLAN §10).
 */
function parseWorldTempo(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_WORLD_TEMPO.worldMinutesPerRealSecond;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid config: WORLD_MINUTES_PER_REAL_SECOND must be a finite positive number, got ` +
        `${JSON.stringify(raw)}. Остановившийся или пятящийся мир — это не темп, а поломка.`,
    );
  }
  return parsed;
}

function parseDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(
      'Invalid config: DATABASE_URL is required. Worker без базы не может двигать мир, а ' +
        'молчащий процесс неотличим от работающего — поэтому это отказ запуска, а не дефолт.',
    );
  }
  return raw;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENVS as readonly string[]).includes(value);
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

function parseNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === undefined) {
    return DEFAULTS.nodeEnv;
  }
  if (!isNodeEnv(raw)) {
    throw new Error(
      `Invalid config: NODE_ENV must be one of ${NODE_ENVS.join(', ')}, got ${JSON.stringify(raw)}.`,
    );
  }
  return raw;
}

/**
 * §12 03_TECHNICAL_DESIGN требует immutable deployment identifier в health/telemetry, иначе
 * production-инцидент невозможно воспроизвести. Поэтому в production отсутствующий/пустой
 * `DEPLOYMENT_ID` — явная ошибка запуска, а не молчаливый дефолт. Вне production дефолт остаётся,
 * но он видимо помечен как локальный (`LOCAL_DEPLOYMENT_ID`), чтобы его нельзя было спутать с
 * настоящим deployment id.
 */
function parseDeploymentId(raw: string | undefined, nodeEnv: NodeEnv): string {
  if (raw !== undefined && raw.trim().length > 0) {
    return raw;
  }
  if (nodeEnv === 'production') {
    throw new Error(
      'Invalid config: DEPLOYMENT_ID is required when NODE_ENV=production. §12 03_TECHNICAL_DESIGN ' +
        'requires an immutable deployment identifier in health/telemetry so a production incident can ' +
        'be reproduced. Set DEPLOYMENT_ID to a value that uniquely identifies this build/deploy (e.g. ' +
        'release tag or commit SHA + deploy sequence).',
    );
  }
  return LOCAL_DEPLOYMENT_ID;
}

/**
 * Разбирает и валидирует окружение процесса в `Config`.
 * Читает только `LOG_LEVEL`, `NODE_ENV`, `DEPLOYMENT_ID`, `DATABASE_URL`, `WORLD_ID` и
 * `WORLD_MINUTES_PER_REAL_SECOND` — все остальные ключи игнорируются.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const nodeEnv = parseNodeEnv(env['NODE_ENV']);
  return {
    logLevel: parseLogLevel(env['LOG_LEVEL']),
    nodeEnv,
    deploymentId: parseDeploymentId(env['DEPLOYMENT_ID'], nodeEnv),
    databaseUrl: parseDatabaseUrl(env['DATABASE_URL']),
    worldId:
      (env['WORLD_ID']?.trim() ?? '').length > 0 ? env['WORLD_ID']!.trim() : DEFAULTS.worldId,
    worldMinutesPerRealSecond: parseWorldTempo(env['WORLD_MINUTES_PER_REAL_SECOND']),
  };
}

/**
 * Читает `process.env` и возвращает валидированный `Config`. Это единственное место в apps/worker,
 * где напрямую встречается `process.env` — `main.ts` обязан вызывать `loadConfig()`, а не
 * `parseConfig(process.env)`, иначе `eslint.config.mjs` (правило для файлов приложений) это отклонит.
 */
export function loadConfig(): Config {
  return parseConfig(process.env);
}
