/**
 * Поднимает ВЕСЬ стек мира для одного E2E-прогона и убирает его за собой (I03, D13).
 *
 * Своя база, свой мир, свои процессы. Прогон против чужого запущенного мира доказывал бы только
 * «страница что-то показывает»: неизвестно, чьи это события и не остались ли они от прошлого раза.
 *
 * Порты и имя базы включают PID — по той же причине, по которой это сделано для тестовых баз
 * (второй раунд верификации I02B): два одновременных прогона иначе уничтожают состояние друг
 * друга, и падает не тот тест, который сломан.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../../packages/persistence/src/__fixtures__/test-database.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ROLE_PASSWORD = 'zona_local_dev_only';

/**
 * База берётся ГОТОВОЙ фикстурой, а не своим клиентом `pg`.
 *
 * Первая редакция подключалась сама и потребовала `pg` в корневых зависимостях — и это МОЛЧА
 * ослабило контроль границ: с `pg`, доступным из корня, фикстура `core-has-no-adapter-dependencies`
 * перестала ловить импорт `pg` из `packages/simulation`. Тест границ покраснел, и это его работа.
 * Заодно `createTestDatabase` уже умеет то, что пришлось бы повторить: PID в имени и уборку баз
 * мёртвых процессов.
 */
const databaseUrlFor = (url: string, user: string, password: string): string => {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
};

export interface WorldStack {
  readonly webUrl: string;
  /**
   * Строка подключения к КАНОНИЧЕСКОЙ базе этого прогона, под ролью владельца.
   *
   * Нужна съёмке evidence-пакета: она обязана читать канонический журнал, а не проекцию —
   * иначе «увиденное совпадает с журналом» доказывалось бы сверкой проекции с самой собой.
   * Сценариям D13 она не нужна и там не используется.
   */
  readonly databaseUrl: string;
  /** Адрес observer API этого прогона — съёмке evidence нужен ответ API рядом с журналом. */
  readonly apiUrl: string;
  /** Выполняет команду `world ...` тем же CLI, что и оператор. */
  readonly cli: (args: readonly string[]) => { stdout: string; exitCode: number };
  readonly stop: () => Promise<void>;
}

const waitFor = async (
  probe: () => Promise<boolean>,
  what: string,
  attempts = 120,
): Promise<void> => {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`e2e: не дождались ${what}`);
};

const reachable = (url: string) => async (): Promise<boolean> => {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
};

export interface WorldStackOptions {
  /**
   * Минут мирового времени за секунду реального.
   *
   * Умолчание 60 выбрано для скорости прогона, и у него есть цена, обнаруженная съёмкой
   * evidence-пакета: при таком темпе горизонт одного тика (секунда реального времени = 60 минут
   * мира) ПЕРЕКРЫВАЕТ сорокаминутный путь целиком. `journey.started` и `journey.completed`
   * рождаются в одном тике, и промежуточное состояние «в пути» не существует ни в одном
   * наблюдаемом моменте. Сценарий этого не замечал: он сверяет ленту, а не карту.
   *
   * Поэтому темп стал параметром. Съёмка ставит 6 — путь укладывается примерно в семь секунд
   * наблюдения, но проходит через состояние «в пути», которое и обязан показать кадр.
   */
  readonly worldMinutesPerRealSecond?: number;
}

/**
 * Убирает процессы стека, пережившие ЖЁСТКОЕ завершение предыдущего прогона.
 *
 * `stop()` в `finally` не выполняется, когда убивают весь процесс-дерево: три процесса стека
 * (worker, api, next) остаются жить, держат соединения к базе и жгут процессор. Это не теория —
 * в I03 три осиротевших `apps/api` подняли load average до восьми, и acceptance-тест
 * детерминизма потратил 18 секунд на порождение процесса вместо 0.8. Диагноз «тест сломался»
 * напрашивался сам и был бы неверен.
 *
 * Тот же приём, что `createTestDatabase` применяет к базам мёртвых PID, и по той же причине:
 * уборка в `finally` не переживает `SIGKILL`, поэтому уборка нужна и НА ВХОДЕ.
 *
 * Убиваются только процессы ЭТОГО репозитория и только известных стеку видов — чужой `next` или
 * `node` в системе не трогается.
 */
const sweepStaleStackProcesses = (): void => {
  const patterns = [
    `${REPO_ROOT}apps/worker/src/main.ts`,
    `${REPO_ROOT}apps/api/src/main.ts`,
    `${REPO_ROOT}apps/web/node_modules/.bin/next`,
  ];
  for (const pattern of patterns) {
    // `pkill -f` по полному пути: совпадение по абсолютному пути этого репозитория исключает
    // чужие процессы с похожим именем.
    spawnSync('pkill', ['-f', pattern], { stdio: 'ignore' });
  }
};

export const startWorldStack = async (
  label: string,
  options: WorldStackOptions = {},
): Promise<WorldStack> => {
  sweepStaleStackProcesses();

  const apiPort = 3200 + (process.pid % 200);
  const webPort = 3400 + (process.pid % 200);
  const testDb: TestDatabase = await createTestDatabase(`e2e_${label}`);
  const databaseUrl = testDb.url;

  const cli = (args: readonly string[]) => {
    const result = spawnSync('node', ['apps/cli/src/main.ts', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        MIGRATION_DATABASE_URL: databaseUrl,
        ZONA_ROLE_PASSWORD: ROLE_PASSWORD,
      },
    });
    return { stdout: `${result.stdout}${result.stderr}`, exitCode: result.status ?? -1 };
  };

  const migrate = cli(['world', 'migrate']);
  if (migrate.exitCode !== 0) throw new Error(`e2e: world migrate упал: ${migrate.stdout}`);
  const init = cli(['world', 'init', '--seed', '42']);
  if (init.exitCode !== 0) throw new Error(`e2e: world init упал: ${init.stdout}`);

  const children: ChildProcess[] = [];
  const spawnChild = (command: string, args: readonly string[], env: Record<string, string>) => {
    const child = spawn(command, [...args], {
      cwd: command.endsWith('/next')
        ? fileURLToPath(new URL('../../../apps/web', import.meta.url))
        : REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    children.push(child);
  };

  /**
   * Worker поднимается ПЕРВЫМ, до API и экрана, — и это ПРОБА, а не удобство.
   *
   * Ровно на этом порядке сценарий D13 падал: простаивающий worker копил неизрасходованное время
   * темпа, и к моменту команды горизонт уходил дальше сорока мировых минут — длины маршрута.
   * Путь завершался мгновенно, состояние «в пути» не существовало ни в один наблюдаемый момент,
   * а падал при этом не тот тест, который проверял переход.
   *
   * Кредит починен (`apps/worker/src/world-step.ts`), и порядок возвращён нарочно: он делает
   * сценарий ЧУВСТВИТЕЛЬНЫМ к возврату дефекта. Worker, поднятый последним, отличить починку от
   * дефекта уже не мог бы — обход перестал бы быть обходом и стал бы слепым пятном.
   */
  spawnChild('node', ['apps/worker/src/main.ts'], {
    DATABASE_URL: databaseUrl,
    PROJECTION_DATABASE_URL: databaseUrlFor(databaseUrl, 'zona_projection', ROLE_PASSWORD),
    // Быстрый темп: сценарий не должен ждать сорок секунд реального времени, чтобы увидеть
    // завершение пути. На то, КАКИМИ будут события, это не влияет (D2) — только на «когда».
    WORLD_MINUTES_PER_REAL_SECOND: String(options.worldMinutesPerRealSecond ?? 60),
    LOG_LEVEL: 'silent',
  });

  spawnChild('node', ['apps/api/src/main.ts'], {
    PROJECTION_DATABASE_URL: databaseUrlFor(databaseUrl, 'zona_api', ROLE_PASSWORD),
    PORT: String(apiPort),
    ALLOWED_ORIGINS: `http://localhost:${String(webPort)}`,
    LOG_LEVEL: 'silent',
  });

  await waitFor(reachable(`http://localhost:${String(apiPort)}/health`), 'observer API');

  // `next` запускается напрямую, а не через `pnpm --filter`: скрипт пакета уже несёт `--port`,
  // и добавленный вторым аргумент зависел бы от того, какой из двух победит. Порт обязан быть
  // единственным — параллельные прогоны иначе делят один.
  spawnChild(
    fileURLToPath(new URL('../../../apps/web/node_modules/.bin/next', import.meta.url)),
    ['start', '--port', String(webPort)],
    {
      ZONA_API_BASE_URL: `http://localhost:${String(apiPort)}`,
    },
  );

  const webUrl = `http://localhost:${String(webPort)}`;
  await waitFor(reachable(webUrl), 'экран наблюдателя');

  return {
    webUrl,
    databaseUrl,
    apiUrl: `http://localhost:${String(apiPort)}`,
    cli,
    stop: async () => {
      for (const child of children) child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const child of children) if (!child.killed) child.kill('SIGKILL');
      await testDb.drop();
    },
  };
};
