/**
 * apps/cli — команды над DURABLE миром (I02A, ACCEPTANCE B9 и demo из PLAN §2).
 *
 * Отличие от `world-cli.ts`: те команды строят мир в памяти и остаются чистыми функциями argv →
 * результат. Эти работают с PostgreSQL, поэтому асинхронны и принимают подключение аргументом.
 * `DATABASE_URL` читает `main.ts` — единственное место, которому разрешено трогать окружение;
 * сюда строка приходит явным параметром (ADR-003: оболочка снаружи, зависимости внутрь).
 */
import {
  CANONICAL_TRANSACTION_ISOLATION_LEVEL,
  RUNTIME_ID_PREFIXES,
  addMinutes,
  compareByCodePoint,
  isInstantError,
  parseInstant,
  requireChecksum,
  type Command,
  type Snapshot,
} from '@zona/contracts';
import { randomUUID } from 'node:crypto';
import { DerivedIdFactory } from '@zona/domain';
import { PROTOTYPE_WORLD } from '@zona/content';
import {
  createDatabase,
  executeCommand,
  initializeWorld,
  loadLatestSnapshot,
  loadWorldEvents,
  loadWorldMeta,
  loadWorldState,
  loadWorldsWithEmptyPrngPositions,
  migrations,
  parseDatabaseConnectionUrl,
  replayFromSnapshot,
  runMigrations,
  UnqualifiedRuntimeProfileError,
  repairWorldPrngPositions,
  UnqualifiedCanonicalWriterError,
  qualifyCanonicalWriter,
  runWorldTick,
  setWorldQualifiedProfile,
  writeSnapshot,
  applyGrants,
  ensureApplicationRoles,
  type DatabaseConnection,
  type Logger,
} from '@zona/persistence';
import type { CliResult } from './commands.ts';
import { describeDatabaseTarget } from './config.ts';
import {
  currentBundles,
  currentDeterministicRuntimeProfile,
  prototypeRulesetVersions,
  seedWorld,
} from './world.ts';

const SILENT_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const INTEGER_PATTERN = /^-?\d+$/;

const parseSeed = (args: readonly string[]): number | string => {
  const raw = flag(args, '--seed');
  if (raw === undefined) return 'отсутствует обязательный флаг --seed <N>';
  if (!INTEGER_PATTERN.test(raw))
    return `--seed ожидает целое число, получено ${JSON.stringify(raw)}`;
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed)) return `--seed вне безопасного диапазона целых: ${raw}`;
  return seed;
};

export const connect = (databaseUrl: string): DatabaseConnection =>
  createDatabase(parseDatabaseConnectionUrl(databaseUrl));

/**
 * `world migrate` — применяет неприменённые миграции общим runner-ом.
 *
 * Роль подключения называется в выводе: миграции обязаны идти под владельцем схемы, а рантайм —
 * под `zona_worker` (BL-2 аудита I02A). Если `MIGRATION_DATABASE_URL` не задана и команда
 * пошла под рантайм-строкой, это ГОВОРИТСЯ вслух, а не подразумевается.
 */
/**
 * Починка позиций PRNG у миров прежней поставки, которых не достаёт миграция 0010 (B1, второй
 * раунд верификации I02B).
 *
 * Миграция 0009 объявила позиции пустыми у всех существующих миров, обосновав это тем, что
 * команды розыгрышей не делали. Розыгрыши делает ГЕНЕЗИС: `seedAgents` распределяет агентов по
 * локациям, по розыгрышу на агента. 0010 восстанавливает то, что можно восстановить из снимка —
 * там позиции записаны фактом. Мир БЕЗ снимка чинится только здесь: его позиции детерминированная
 * функция seed, а `statements` миграции по контракту не имеет доступа к PRNG (`types.ts`).
 *
 * Живёт в `world migrate`, а не отдельной командой: оператору не с чего знать, что после
 * обновления нужен ещё один шаг, а забытый шаг оставил бы мир с неверными позициями молча.
 * Операция идемпотентна — записывает только там, где сейчас пусто, и печатает, что сделала.
 *
 * Пересчёт верен ровно потому, что до 0009 ни одна КОМАНДА розыгрыша сделать не могла
 * (`UnavailableRandomSource` бросал исключение): значит позиции такого мира и есть генезисные.
 * Для мира, созданного после 0009, условие «позиции пусты» не выполняется, и починка его не
 * тронет.
 */
const repairGenesisPrngPositions = async (db: DatabaseConnection): Promise<readonly string[]> => {
  const worlds = await loadWorldsWithEmptyPrngPositions(db);
  const repaired: string[] = [];
  for (const world of worlds) {
    if (world.worldId !== PROTOTYPE_WORLD.worldId) {
      // Пересчёт генезиса знает ровно один контент. Чужой мир не трогаем и молчать о нём тоже
      // нельзя: неверные позиции хуже честного «не починил».
      repaired.push(
        `ВНИМАНИЕ: у мира ${world.worldId} пустые позиции PRNG, но он не из контента ` +
          `${PROTOTYPE_WORLD.worldId} — пересчитать генезис нечем, позиции остаются пустыми.`,
      );
      continue;
    }
    const positions = seedWorld(world.seed).snapshot.prng_stream_positions;
    if (await repairWorldPrngPositions(db, world.worldId, positions)) {
      repaired.push(
        `Позиции PRNG мира ${world.worldId} восстановлены из генезиса seed=${String(world.seed)} ` +
          `(миграция 0009 обнулила их у миров прежней поставки).`,
      );
    }
  }
  return repaired;
};

export const runWorldMigrateCommand = async (
  db: DatabaseConnection,
  databaseUrl: string,
  usedRuntimeConnection: boolean,
  rolePassword: string | undefined,
): Promise<CliResult> => {
  const report = await runMigrations({ db, migrations, logger: SILENT_LOGGER });
  const applied = report.applied.map((entry) => `${entry.id}-${entry.name}`);
  const lines =
    applied.length === 0
      ? [`Схема уже на версии ${String(report.schemaVersion)}; применять нечего.`]
      : [`Применено: ${applied.join(', ')}`, `Версия схемы: ${String(report.schemaVersion)}`];

  // Роли и гранты применяются КАЖДЫЙ раз, а не один раз в журнале: они кластерные, а журнал
  // базовый, поэтому restore базы в чистый кластер иначе остался бы без прав и без сигнала
  // (M-8 аудита I02A, OPS-04). Операция идемпотентна.
  if (rolePassword !== undefined) {
    const roles = await ensureApplicationRoles(db, rolePassword);
    lines.push(
      roles.created.length === 0
        ? `Роли на месте: ${roles.existing.join(', ')}`
        : `Созданы роли: ${roles.created.join(', ')}`,
    );
  } else {
    lines.push(
      'ZONA_ROLE_PASSWORD не задан — роли не создавались; гранты применяются к уже ' +
        'существующим principals (в поставке роли заводит оператор из secret store).',
    );
  }
  await applyGrants(db);
  lines.push('Гранты применены.');

  lines.push(...(await repairGenesisPrngPositions(db)));

  lines.push(`Подключение: ${describeDatabaseTarget(databaseUrl)}`);
  if (usedRuntimeConnection) {
    lines.push(
      'MIGRATION_DATABASE_URL не задана — миграции применены рантайм-подключением. ' +
        'В поставке роли обязаны различаться (03_TECHNICAL_DESIGN §11).',
    );
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
};

/** `world init --seed N` — записывает детерминированно порождённый мир в базу. */
export const runWorldInitCommand = async (
  db: DatabaseConnection,
  args: readonly string[],
): Promise<CliResult> => {
  const seed = parseSeed(args);
  if (typeof seed === 'string') return { stdout: `world init: ${seed}\n`, exitCode: 2 };

  const seeded = seedWorld(seed);
  const { state } = seeded;
  const existing = await loadWorldState(db, state.worldId);
  if (existing !== null) {
    // Не идемпотентность, а защита истории: перезапись существующего мира стёрла бы его журнал.
    return {
      stdout: `world init: мир ${state.worldId} уже существует (версия ${String(existing.worldVersion)}).\n`,
      exitCode: 2,
    };
  }

  // m-6 аудита I02A: проверка выше — check-then-act. Конкурентный `world init` проигрывает на
  // первичном ключе, и это правильный исход; но он обязан быть СООБЩЕНИЕМ, а не стеком.
  /**
   * ВСЕ ТРИ записи — в ОДНОЙ транзакции. M4 независимого архитектурного аудита I03.
   *
   * Раньше `initializeWorld`, `setWorldQualifiedProfile` и `writeSnapshot` шли тремя отдельными
   * транзакциями. Обрыв между ними (падение процесса, потеря соединения, Ctrl+C) оставлял мир,
   * который:
   *   - не принимает команд, если не записан квалифицированный профиль (`canonical-writer`);
   *   - не даёт собрать проекцию, если не записан генезисный снимок (worker отказывается
   *     придумывать начальную расстановку);
   *   - не пересоздаётся — `world init` отвечает «создан параллельно другим процессом»;
   *   - и НЕ УДАЛЯЕТСЯ: команды drop/reset в CLI нет.
   *
   * То есть текст отказа советовал «пересоздайте мир» — действие, которого продукт не умеет.
   * Change request §10.2 сделал генезисный снимок несущей конструкцией, и создавалась она
   * неатомарно, без пути восстановления.
   *
   * Транзакция это снимает целиком: либо мир есть весь, либо его нет вовсе и `world init`
   * повторяется как ни в чём не бывало.
   */
  try {
    await db.transaction().execute(async (trx) => {
      await initializeWorld(trx, {
        seed,
        state,
        // Версия контента — из самого пакета контента, а не из тестовых умолчаний: иначе события
        // подписывались бы одной версией, а bundle снимка нёс бы другую (см. `world.ts`).
        versions: prototypeRulesetVersions(),
        // Генезис уже сделал розыгрыши, распределяя агентов по локациям: начать потоки с нуля
        // после этого значило бы выдать те же значения второй раз (M4).
        prngStreamPositions: seeded.snapshot.prng_stream_positions,
        content: {
          locations: PROTOTYPE_WORLD.locations.map((location) => ({
            id: location.id,
            name: location.name,
            description: location.description,
          })),
          agentNames: Object.fromEntries(PROTOTYPE_WORLD.agents.map((a) => [a.id, a.name])),
        },
      });

      // Мир квалифицируется профилем ТОГО процесса, который его создал (M-C). Дальше любой
      // писатель обязан пройти `qualifyCanonicalWriter` и совпасть с этим профилем.
      await setWorldQualifiedProfile(trx, state.worldId, currentDeterministicRuntimeProfile());

      // Генезисный снимок пишется СРАЗУ (I03). Три следствия, и все три нужны:
      //
      // 1. У мира есть точка восстановления с первого дня, а не с первого `world snapshot`
      //    (OPS-04).
      // 2. Начальная расстановка агентов становится ЧИТАЕМОЙ из базы. Вывести её из журнала
      //    нельзя — её сделал `initializeWorld` в обход событий, — и до сих пор единственным её
      //    источником был `seedWorld` в этом же процессе. Сборщику проекции она нужна, а он
      //    живёт в worker-е, и приложения не имеют права импортировать друг друга.
      // 3. `world replay` перестаёт нуждаться в особом случае «снимков не было, восстановим из
      //    seed».
      await writeSnapshot(trx, {
        worldId: state.worldId,
        lastSequence: state.sequence,
        worldTime: state.worldTime,
        bundles: currentBundles(),
        deterministicRuntimeProfile: currentDeterministicRuntimeProfile(),
        prngStreamPositions: seeded.snapshot.prng_stream_positions,
        canonicalState: state,
      });
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === '23505') {
      return {
        stdout: `world init: мир ${state.worldId} создан параллельно другим процессом.\n`,
        exitCode: 2,
      };
    }
    throw error;
  }

  return {
    stdout:
      `Мир ${state.worldId} создан из seed=${String(seed)}; версия ${String(state.worldVersion)}.\n` +
      `Записан генезисный снимок на sequence ${String(state.sequence)}.\n`,
    exitCode: 0,
  };
};

/**
 * `world run --agent <id> --route <id> [--command-id <id>]` — начинает путь.
 *
 * `command_id` — ключ идемпотентности, и его семантика здесь прямая: БЕЗ `--command-id` каждый
 * запуск это НОВАЯ попытка и получает свежий id; С `--command-id` это повтор ровно той попытки.
 *
 * Прежняя редакция выводила id из (мир, агент, маршрут, версия мира). M-9 аудита I02A показал,
 * чего это стоит: транзакция закоммитилась, процесс убит до вывода, оператор повторяет ту же
 * строку — версия мира уже другая, значит и `command_id` другой, journal повтора не находит, и
 * команда исполняется заново. То есть ровно тот сценарий OPS-01, ради которого journal и
 * существует, шёл мимо него. Дубликата не возникало только потому, что `journey.start` защищает
 * себя сам; для первой же команды с повторяемым предусловием это был бы генератор дублей.
 *
 * `correlation_id` выводится ИЗ `command_id`, а не независимым счётчиком: иначе повтор с тем же
 * `--command-id` давал бы другое тело команды (счётчик фабрики стартовал бы с другой позиции),
 * и проверка отпечатка (M-2) честно объявляла бы повтор подменой. Найдено исполнением при
 * закрытии M-2.
 */
const freshCommandId = (): string =>
  // `apps/cli` — императивная оболочка, ей случайность разрешена (в отличие от домена).
  new DerivedIdFactory(randomUUID()).next(RUNTIME_ID_PREFIXES.command);

/**
 * Отказ команде, если процесс не квалифицирован для мира (M-C). `null` — можно писать.
 *
 * Возвращает результат, а не бросает: для оператора это НЕ сбой программы, а состояние мира,
 * и он обязан прочитать причину, а не стек. Код возврата 3 — тот же, что у `world replay` при
 * несовместимом профиле: «сверка не выполнена / писать нельзя», в отличие от 1 («нарушено»).
 */
const refuseUnqualifiedWriter = async (
  db: DatabaseConnection,
  worldId: string,
  command: string,
): Promise<CliResult | null> => {
  try {
    await qualifyCanonicalWriter(db, worldId, currentDeterministicRuntimeProfile());
    return null;
  } catch (error) {
    if (error instanceof UnqualifiedCanonicalWriterError) {
      return { stdout: `${command}: ${error.message}\n`, exitCode: 3 };
    }
    throw error;
  }
};

export const runWorldRunCommand = async (
  db: DatabaseConnection,
  args: readonly string[],
): Promise<CliResult> => {
  const agentId = flag(args, '--agent');
  const routeId = flag(args, '--route');
  if (agentId === undefined || routeId === undefined) {
    return { stdout: 'world run: нужны флаги --agent <id> и --route <id>\n', exitCode: 2 };
  }

  const state = await loadWorldState(db, PROTOTYPE_WORLD.worldId);
  if (state === null) {
    return {
      stdout: `world run: мир ${PROTOTYPE_WORLD.worldId} не создан — сначала "world init --seed N".\n`,
      exitCode: 2,
    };
  }

  // M-C: писать канонические события можно только под квалифицированным профилем. Проверка
  // ОДИН РАЗ на команду CLI, а не на каждое обращение к базе: CLI — короткоживущий процесс,
  // и профиль внутри одного запуска не меняется.
  const unqualified = await refuseUnqualifiedWriter(db, state.worldId, 'world run');
  if (unqualified !== null) return unqualified;

  const commandId = flag(args, '--command-id') ?? freshCommandId();
  const command: Command = {
    command_id: commandId,
    world_id: state.worldId,
    type: 'journey.start',
    schema_version: prototypeRulesetVersions().schemaVersion,
    actor_id: agentId,
    issued_at_world_time: state.worldTime,
    expected_world_version: state.worldVersion,
    correlation_id: new DerivedIdFactory(`${commandId}:correlation`).next(
      RUNTIME_ID_PREFIXES.correlation,
    ),
    payload: { route_id: routeId },
  };

  const result = await executeCommand(db, command);
  const replayed = result.replayed ? ' (повтор: результат прочитан из journal)' : '';

  if (result.outcome === 'rejected') {
    return {
      stdout:
        `Команда ${result.commandId} отклонена${replayed}: ${result.rejectionCode}\n` +
        `  ${result.rejectionMessage}\n`,
      exitCode: 1,
    };
  }
  return {
    stdout:
      `Команда ${result.commandId} принята${replayed}.\n` +
      `  события: ${result.eventIds.join(', ')}\n` +
      `  версия мира: ${String(result.worldVersionBefore)} -> ${String(result.worldVersionAfter)}\n`,
    exitCode: 0,
  };
};

/**
 * Горизонт для `world tick`: `--advance <минуты>` ИЛИ `--until <ISO>`, не оба сразу.
 *
 * Без явного горизонта `runWorldTick` двигает мир только до УЖЕ наступившего мирового времени
 * (ACCEPTANCE C3) — это здесь выражено буквально: `horizon: undefined` в `TickOptions` и есть
 * дефолт «текущее мировое время», а не отдельная ветка кода, которая могла бы с ним разойтись.
 *
 * `--advance` считается сдвигом от ТЕКУЩЕГО мирового времени через `requireAddMinutes`
 * (`@zona/contracts`) — тем же путём, каким домен считает `expectedArrival` для `journey.start`
 * (`decide.ts`), а не арифметикой над ISO-строкой или `Date`: секунда, потерянная на округлении
 * здесь, разошлась бы с тем, что канонически посчитал бы домен для того же сдвига.
 */
type HorizonParseResult =
  | { readonly kind: 'ok'; readonly horizon: string | undefined }
  | { readonly kind: 'error'; readonly message: string };

const parseHorizon = (args: readonly string[], worldTime: string): HorizonParseResult => {
  const advanceRaw = flag(args, '--advance');
  const untilRaw = flag(args, '--until');

  if (advanceRaw !== undefined && untilRaw !== undefined) {
    return {
      kind: 'error',
      message:
        '--advance и --until взаимоисключающие — назовите ровно один горизонт, а не молчаливо ' +
        'предпочтите один из двух',
    };
  }
  if (advanceRaw === undefined && untilRaw === undefined) {
    return { kind: 'ok', horizon: undefined };
  }

  if (untilRaw !== undefined) {
    const parsed = parseInstant(untilRaw);
    if (isInstantError(parsed)) return { kind: 'error', message: `--until: ${parsed.error}` };
    return { kind: 'ok', horizon: parsed.iso };
  }

  // Дошли сюда — задан только --advance.
  if (!INTEGER_PATTERN.test(advanceRaw!)) {
    return {
      kind: 'error',
      message: `--advance ожидает целое число минут, получено ${JSON.stringify(advanceRaw)}`,
    };
  }
  const minutes = Number(advanceRaw);
  if (!Number.isSafeInteger(minutes)) {
    return { kind: 'error', message: `--advance вне безопасного диапазона целых: ${advanceRaw}` };
  }
  if (minutes < 0) {
    // C12: мировое время монотонно. Отрицательный сдвиг всегда даёт горизонт раньше текущего
    // мирового времени, а `runWorldTick` отверг бы его позже той же причиной, но менее по-
    // человечески — это флаговая ошибка, а не программная, и обязана остановиться здесь.
    return {
      kind: 'error',
      message: `--advance не может быть отрицательным: ${advanceRaw} (мир не идёт назад, C12)`,
    };
  }

  const base = parseInstant(worldTime);
  if (isInstantError(base)) {
    // Мировое время читается из БД и обязано быть каноническим по построению — это не ошибка
    // пользователя, а сигнал о повреждённых данных.
    throw new Error(`world tick: мировое время из БД неканонично: ${base.error}`);
  }
  const shifted = addMinutes(base, minutes);
  if (isInstantError(shifted)) return { kind: 'error', message: `--advance: ${shifted.error}` };
  return { kind: 'ok', horizon: shifted.iso };
};

/**
 * Метка владельца аренды для `runWorldTick` (`ClaimOptions.owner`, `packages/persistence/src/scheduler.ts`).
 *
 * Обязана быть различимой между запусками (ACCEPTANCE C5/C6 требуют РАЗНЫХ worker-ов), а не
 * константой вроде `'cli'`: два `world tick`, случайно запущенные одновременно на одном мире —
 * например оператором и cron-ом — иначе делили бы одну метку владельца, и по логам вокруг
 * зависшей аренды было бы не отличить, какой из процессов её держит. `pid` даёт то, что видно
 * в `ps`/логах ОС сразу; `randomUUID` — гарантию уникальности, если pid переиспользуется другим
 * процессом между двумя короткоживущими запусками CLI.
 */
const tickOwner = (): string => `cli:${String(process.pid)}:${randomUUID()}`;

/**
 * `world tick` — один шаг worker-а: захватить наступившие due actions и исполнить их.
 *
 * CLI, а не постоянный процесс (`apps/worker`) — здесь одна короткоживущая попытка сдвинуть мир,
 * ровно как задумано PLAN §2 (`pnpm world tick` между стартом journey и проверкой состояния).
 */
export const runWorldTickCommand = async (
  db: DatabaseConnection,
  args: readonly string[],
): Promise<CliResult> => {
  const state = await loadWorldState(db, PROTOTYPE_WORLD.worldId);
  if (state === null) {
    return {
      stdout: `world tick: мир ${PROTOTYPE_WORLD.worldId} не создан — сначала "world init --seed N".\n`,
      exitCode: 2,
    };
  }

  const unqualified = await refuseUnqualifiedWriter(db, state.worldId, 'world tick');
  if (unqualified !== null) return unqualified;

  const horizonResult = parseHorizon(args, state.worldTime);
  if (horizonResult.kind === 'error') {
    return { stdout: `world tick: ${horizonResult.message}\n`, exitCode: 2 };
  }

  const result = await runWorldTick(db, {
    worldId: state.worldId,
    owner: tickOwner(),
    ...(horizonResult.horizon === undefined ? {} : { horizon: horizonResult.horizon }),
  });

  if (result.claimed === 0) {
    return {
      stdout: `Нечего обрабатывать: наступивших действий нет (мировое время ${result.worldTime}).\n`,
      exitCode: 0,
    };
  }

  // M9 аудита: отвергнутое запланированное действие — это застрявший в мире путь, а не
  // рядовая строка вывода. Нулевой код возврата означал, что cron и оператор видят успех
  // ровно тогда, когда мир сломался.
  const rejected = result.executed.filter((outcome) => outcome.outcome === 'rejected');

  const lines = [`Захвачено действий: ${String(result.claimed)}`];
  for (const execution of result.executed) {
    if (execution.outcome === 'accepted') {
      lines.push(`  ${execution.commandId} принята: события ${execution.eventIds.join(', ')}`);
    } else {
      lines.push(
        `  ${execution.commandId} отклонена: ${execution.rejectionCode} — ${execution.rejectionMessage}`,
      );
    }
  }
  lines.push(`Мировое время: ${result.worldTime}`);

  if (rejected.length > 0) {
    lines.push(
      '',
      `ОТВЕРГНУТО ДЕЙСТВИЙ: ${String(rejected.length)}. Каждое помечено failed_at и в очередь ` +
        'больше не вернётся — соответствующий путь остался незавершённым и требует решения ' +
        'оператора. Автоматически исправить это мир не может.',
    );
    return { stdout: `${lines.join('\n')}\n`, exitCode: 1 };
  }

  return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
};

/** `world state` — каноническое состояние мира из базы (B9: переживает перезапуск процесса). */
export const runWorldStateCommand = async (db: DatabaseConnection): Promise<CliResult> => {
  const state = await loadWorldState(db, PROTOTYPE_WORLD.worldId);
  if (state === null) {
    return {
      stdout: `world state: мир ${PROTOTYPE_WORLD.worldId} не создан.\n`,
      exitCode: 2,
    };
  }
  const lines = [
    `Мир ${state.worldId}`,
    `Версия: ${String(state.worldVersion)}   sequence: ${String(state.sequence)}`,
    `Мировое время: ${state.worldTime}`,
    '',
    'Агенты:',
  ];
  for (const agent of Object.values(state.agents).sort((a, b) => compareByCodePoint(a.id, b.id))) {
    const route = agent.routeId === null ? '' : ` по маршруту ${agent.routeId}`;
    lines.push(`  ${agent.id.padEnd(14)} ${agent.status.padEnd(10)} в ${agent.locationId}${route}`);
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
};

/**
 * `world events` — канонический журнал в порядке sequence.
 *
 * Читает через `loadWorldEvents`, а не прямым `select` (n-11 аудита): оператор должен видеть
 * ПРОВЕРЕННЫЕ строки. Событие, чья форма разошлась с checksum, снятым при записи, обязано
 * остановить вывод громкой ошибкой, а не быть показанным как обычный факт.
 */
export const runWorldEventsCommand = async (db: DatabaseConnection): Promise<CliResult> => {
  const events = await loadWorldEvents(db, PROTOTYPE_WORLD.worldId);
  if (events.length === 0) return { stdout: 'Событий нет.\n', exitCode: 0 };

  const lines = [`Событий: ${String(events.length)}`];
  for (const event of events) {
    lines.push(
      `  ${String(event.sequence).padStart(4)}  ${event.type.padEnd(18)} ${event.world_time}  ` +
        `${event.actor_ids.join(',')}  ${event.event_id}`,
    );
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
};

/**
 * `world snapshot` — записывает точку восстановления ТЕКУЩЕГО состояния durable-мира (ACCEPTANCE
 * C8, OPS-04). Отдельная команда, а не флаг `world replay` — см. докстринг {@link runWorldReplayCommand}
 * про то, почему replay обязан оставаться read-only.
 */
export const runWorldSnapshotCommand = async (db: DatabaseConnection): Promise<CliResult> => {
  // M-D (второй раунд верификации I02B): состояние и метаданные читаются в ОДНОЙ транзакции.
  // Раньше это были два независимых чтения по разным соединениям пула под `read committed`, и
  // между ними могла закоммититься команда — тогда в снимок попадали `last_sequence` и
  // `canonical_state` версии N вместе с `prng_stream_positions` версии N+k. Перекос позиций, в
  // отличие от перекоса состояния, не ловится ничем: они не входят в `WorldState`, поэтому
  // сверка `world replay` их не видит, а checksum снимка их накрывает и потому остаётся
  // внутренне непротиворечивым с рассогласованной парой.
  //
  // Комментарий в `command-handler.ts` требует, чтобы позиция двигалась там же, где
  // `last_sequence`; здесь эта пара впервые ФОТОГРАФИРУЕТСЯ, и требование обязано выполняться
  // и на снимке тоже.
  //
  // Остаток долга: сам `loadWorldState` внутри делает четыре отдельных запроса (BLOCKER 2
  // первого раунда). Транзакция здесь их накрывает, но общий долг закрывается в I03 вместе с
  // проекциями, которые читают то же состояние.
  const snapshotSource = await db
    .transaction()
    .setIsolationLevel(CANONICAL_TRANSACTION_ISOLATION_LEVEL)
    .execute(async (trx) => {
      const state = await loadWorldState(trx, PROTOTYPE_WORLD.worldId);
      if (state === null) return null;
      const meta = await loadWorldMeta(trx, state.worldId);
      return { state, meta };
    });

  if (snapshotSource === null) {
    return {
      stdout: `world snapshot: мир ${PROTOTYPE_WORLD.worldId} не создан — сначала "world init --seed N".\n`,
      exitCode: 2,
    };
  }
  const { state, meta } = snapshotSource;
  if (meta === null) {
    // `loadWorldState` уже нашёл мир — строка `worlds` обязана существовать. Недостижимо на
    // практике, но рассогласование двух чтений одного мира не должно быть тихим.
    throw new Error(`world snapshot: мир ${state.worldId} есть в state, но не в meta`);
  }

  const bundles = currentBundles();
  const runtimeProfile = currentDeterministicRuntimeProfile();
  // Позиции PRNG берутся из САМОГО МИРА (M4, миграция 0009), а не восстанавливаются обходным
  // путём. Прежняя редакция брала их из последнего снимка, а при его отсутствии пересчитывала
  // `seedWorld(seed)` — и то, и другое верно ровно пока ни одна команда не бросает кости.
  // Допущение было записано честно, но оставалось допущением; теперь позиция двигается в
  // транзакции команды, и снимок её просто фотографирует.
  const prngStreamPositions = meta.prngStreamPositions;

  try {
    const snapshot = await writeSnapshot(db, {
      worldId: state.worldId,
      lastSequence: state.sequence,
      worldTime: state.worldTime,
      bundles,
      deterministicRuntimeProfile: runtimeProfile,
      prngStreamPositions,
      canonicalState: state,
    });
    return {
      stdout:
        `Снимок мира ${state.worldId} записан: sequence ${String(snapshot.last_sequence)}, ` +
        `checksum ${snapshot.checksum}\n`,
      exitCode: 0,
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === '23505') {
      // Первичный ключ `world_snapshots` — `(world_id, last_sequence)` (snapshot-store.ts):
      // состояние мира не сдвинулось с прошлого снимка — не отказ, а честное "снимать нечего".
      return {
        stdout: `world snapshot: снимок мира ${state.worldId} на sequence ${String(state.sequence)} уже существует.\n`,
        exitCode: 2,
      };
    }
    throw error;
  }
};

/**
 * `world replay` — пересимулирует мир из снимка и суффикса журнала и сверяет checksum с
 * НЕПРЕРЫВНЫМ прогоном (ACCEPTANCE C9/C10, PLAN §2 demo). Расхождение — доказательство нарушения
 * SIM-01, поэтому это ненулевой exit с явно напечатанными обоими checksum, а не справочная печать.
 *
 * Read-only НАМЕРЕННО: replay ничего не пишет в базу — ни новый снимок, ни что-либо ещё. Это тот
 * же довод, что уже есть у `replay.ts` (`replay — это свёртка, а не повторное решение», C10): если
 * бы `world replay` попутно снимал новый снимок, ПОСЛЕДУЮЩИЙ replay всегда сверялся бы с ПУСТЫМ
 * суффиксом (0 применённых событий) — то есть проверка стала бы тавтологией уже со второго
 * запуска. Отдельная команда {@link runWorldSnapshotCommand} — то место, где снимки берутся
 * оператором по его собственному решению (OPS-04: периодическая точка восстановления), а не
 * побочный эффект verification-команды.
 *
 * Снимков ещё может не быть вовсе (`world snapshot` ни разу не запускали) — тогда replay
 * восстанавливает GENESIS-снимок в ПАМЯТИ через `seedWorld(meta.seed)`, тем же путём, каким его
 * строил бы `world init`, и не пишет его в базу. Прежняя редакция ссылалась здесь на
 * `genesisPrngStreamPositions` — функцию, удалённую тем же коммитом, который эту ссылку оставил
 * (m-2 второго раунда). Ровно тот класс, что M6: ссылка на несуществующее хуже её отсутствия. Демо PLAN §2 заканчивается голым
 * `pnpm world replay` без предшествующего `world snapshot` именно поэтому — команде есть от чего
 * реплеить с первого дня жизни мира.
 */
export const runWorldReplayCommand = async (
  db: DatabaseConnection,
  args: readonly string[] = [],
): Promise<CliResult> => {
  // M-C второго раунда: явный флаг для квалификационного прогона §7. Без него сравнить replay на
  // старом и новом профиле невозможно — загрузка снимка бросает, то есть процедура, которой
  // ADR-010 обосновывает жёсткость проверки, через CLI недоступна. Флаг не умолчание и не тихий:
  // прогон под ним печатает предупреждение отдельной строкой.
  const acceptUnqualifiedProfile = args.includes('--accept-unqualified-profile');
  const state = await loadWorldState(db, PROTOTYPE_WORLD.worldId);
  if (state === null) {
    return {
      stdout: `world replay: мир ${PROTOTYPE_WORLD.worldId} не создан — сначала "world init --seed N".\n`,
      exitCode: 2,
    };
  }
  const meta = await loadWorldMeta(db, state.worldId);
  if (meta === null) {
    throw new Error(`world replay: мир ${state.worldId} есть в state, но не в meta`);
  }

  const bundles = currentBundles();
  // m-5 второго раунда: несовместимость профиля — НЕ то же, что расхождение checksum. Первое
  // означает «SIM-01 не проверен, текущий runtime не квалифицирован» (§7), второе — «SIM-01
  // нарушен, мир и журнал разошлись». Раньше оператор получал на оба один и тот же exit 1 и
  // стек вместо сообщения.
  let stored: Snapshot | null;
  try {
    stored = await loadLatestSnapshot(db, state.worldId, {
      bundles,
      runtimeProfile: currentDeterministicRuntimeProfile(),
      ...(acceptUnqualifiedProfile ? { acceptUnqualifiedProfile: true } : {}),
    });
  } catch (error) {
    if (error instanceof UnqualifiedRuntimeProfileError) {
      return {
        stdout:
          `world replay: сверка НЕ ВЫПОЛНЕНА — профиль выполнения не квалифицирован.\n${error.message}\n` +
          'Это не расхождение мира с журналом: мир цел, но текущий runtime ещё не прошёл ' +
          'compatibility suite (§7 07_MVP_MECHANICS_SPEC).\n' +
          'Для квалификационного прогона: world replay --accept-unqualified-profile.\n',
        exitCode: 3,
      };
    }
    throw error;
  }
  const bootstrapped = stored === null;
  const snapshot = stored ?? seedWorld(meta.seed).snapshot;

  const result = await replayFromSnapshot(db, state.worldId, snapshot);
  const continuousChecksum = requireChecksum(
    state,
    'world replay: текущее состояние мира (непрерывный прогон)',
  );

  const lines = [
    ...(acceptUnqualifiedProfile
      ? [
          'ВНИМАНИЕ: сверка выполняется под НЕКВАЛИФИЦИРОВАННЫМ профилем выполнения ' +
            '(--accept-unqualified-profile). Совпадение checksum здесь — вход в процедуру ' +
            'квалификации §7, а не её результат.',
        ]
      : []),
    `Снимок: sequence ${String(snapshot.last_sequence)}` +
      (bootstrapped ? ' (в базе снимков не было — восстановлен из seed)' : ''),
    `Применено событий суффикса: ${String(result.appliedEventCount)}`,
    `Checksum replay:                ${result.checksum}`,
    `Checksum непрерывного прогона:  ${continuousChecksum}`,
  ];

  if (result.checksum !== continuousChecksum) {
    lines.push(
      'РАСХОЖДЕНИЕ: checksum replay не совпадает с непрерывным прогоном — нарушение SIM-01.',
    );
    return { stdout: `${lines.join('\n')}\n`, exitCode: 1 };
  }

  lines.push('checksum совпадает.');
  return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
};
