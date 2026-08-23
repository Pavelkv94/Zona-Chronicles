/**
 * apps/api — единственное место, читающее окружение процесса (I00 skeleton).
 *
 * `parseConfig` — чистая функция: она принимает уже прочитанный `Record<string, string | undefined>`
 * (обычно `process.env`), поэтому её можно протестировать без реального процесса. Никакие секреты
 * не читаются и не пробрасываются: allowlist ниже — исчерпывающий список поддерживаемых ключей,
 * остальные переменные окружения молча игнорируются.
 *
 * `loadConfig()` — единственное место во всём apps/api, где встречается литеральное `process.env`
 * (см. блок про apps-приложения в eslint.config.mjs): `main.ts` вызывает `loadConfig()`,
 * а не `parseConfig(process.env)` напрямую.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const NODE_ENVS = ['production', 'development', 'test'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

export type Config = {
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly nodeEnv: NodeEnv;
  /**
   * Immutable deployment identifier (§12 03_TECHNICAL_DESIGN) — обязателен при `NODE_ENV=production`
   * (см. `parseDeploymentId`). Вне production, если ключ не задан, это видимо помеченное локальное
   * значение (`LOCAL_DEPLOYMENT_ID`), а не молчаливый прод-похожий дефолт.
   */
  readonly deploymentId: string;
  /**
   * Подключение к хранилищу ПРОЕКЦИИ (I03). Та же физическая база, что каноническая, но ходить
   * туда API обязан под ролью `zona_api`, у которой есть `SELECT` только на `projection_*`.
   * Отдельная переменная, а не переиспользование `DATABASE_URL`, именно поэтому: одинаковая
   * строка подключения означала бы одинаковую роль, и граница D5 держалась бы на честном слове.
   */
  readonly projectionDatabaseUrl: string;
  /** Мир, который показывает этот экземпляр API. */
  readonly worldId: string;
  /**
   * Origin-ы, которым разрешено читать API из браузера (I03).
   *
   * Список ЯВНЫЙ, а не `*`. Публичные данные мира и так доступны любому, кто откроет адрес, —
   * но `*` означал бы, что любая страница в интернете может читать этот API от имени браузера
   * посетителя, и в тот день, когда у API появится хоть какая-то персонализация, запрет придётся
   * вводить задним числом. Дешевле объявить сейчас.
   */
  readonly allowedOrigins: readonly string[];
};

const LOCAL_DEPLOYMENT_ID = 'local-dev-unset';

const DEFAULTS = {
  port: 3000,
  host: '0.0.0.0',
  logLevel: 'info' as LogLevel,
  nodeEnv: 'development' as NodeEnv,
  worldId: 'world:prototype',
  /** Экран наблюдателя в локальной разработке (`pnpm web`). */
  allowedOrigins: ['http://localhost:3100'] as readonly string[],
};

const MIN_PORT = 1;
const MAX_PORT = 65535;

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENVS as readonly string[]).includes(value);
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
 * Читает только `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV`, `DEPLOYMENT_ID` — все остальные ключи
 * игнорируются.
 */
/**
 * Подключение к проекции. Обязательно: API без проекции показать нечего, а отвечающий пустотой
 * сервис неотличим от работающего с пустым миром.
 */
function parseProjectionDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(
      'Invalid config: PROJECTION_DATABASE_URL is required. Отдельная переменная от DATABASE_URL ' +
        'намеренно: API обязан ходить под ролью zona_api, у которой нет прав на канонические ' +
        'таблицы (D5). Одинаковая строка означала бы одинаковую роль.',
    );
  }
  return raw;
}

/**
 * Разбирает список origin-ов через запятую. Пустое значение — дефолт для локальной разработки,
 * а не «разрешить всё»: молчаливый `*` в конфиге — классический способ уехать в поставку.
 */
function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) return DEFAULTS.allowedOrigins;
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0) return DEFAULTS.allowedOrigins;
  if (origins.includes('*')) {
    throw new Error(
      'Invalid config: ALLOWED_ORIGINS не принимает "*". Перечислите origin-ы явно — ' +
        'подстановочный список однажды уедет в поставку вместе с конфигом.',
    );
  }
  return origins;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const nodeEnv = parseNodeEnv(env['NODE_ENV']);
  return {
    port: parsePort(env['PORT']),
    host: env['HOST'] ?? DEFAULTS.host,
    logLevel: parseLogLevel(env['LOG_LEVEL']),
    nodeEnv,
    deploymentId: parseDeploymentId(env['DEPLOYMENT_ID'], nodeEnv),
    projectionDatabaseUrl: parseProjectionDatabaseUrl(env['PROJECTION_DATABASE_URL']),
    worldId:
      (env['WORLD_ID']?.trim() ?? '').length > 0 ? env['WORLD_ID']!.trim() : DEFAULTS.worldId,
    allowedOrigins: parseAllowedOrigins(env['ALLOWED_ORIGINS']),
  };
}

/**
 * Читает `process.env` и возвращает валидированный `Config`. Это единственное место в apps/api,
 * где напрямую встречается `process.env` — `main.ts` обязан вызывать `loadConfig()`, а не
 * `parseConfig(process.env)`, иначе `eslint.config.mjs` (правило для файлов приложений) это отклонит.
 */
export function loadConfig(): Config {
  return parseConfig(process.env);
}
