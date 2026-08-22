/**
 * apps/cli — команды над DURABLE миром (I02A, ACCEPTANCE B9 и demo из PLAN §2).
 *
 * Отличие от `world-cli.ts`: те команды строят мир в памяти и остаются чистыми функциями argv →
 * результат. Эти работают с PostgreSQL, поэтому асинхронны и принимают подключение аргументом.
 * `DATABASE_URL` читает `main.ts` — единственное место, которому разрешено трогать окружение;
 * сюда строка приходит явным параметром (ADR-003: оболочка снаружи, зависимости внутрь).
 */
import { RUNTIME_ID_PREFIXES, compareByCodePoint, type Command } from '@zona/contracts';
import { DerivedIdFactory, testRulesetVersions } from '@zona/domain';
import { PROTOTYPE_WORLD } from '@zona/content';
import {
  createDatabase,
  executeCommand,
  initializeWorld,
  loadWorldState,
  migrations,
  parseDatabaseConnectionUrl,
  requireSafeInteger,
  runMigrations,
  type DatabaseConnection,
  type Logger,
} from '@zona/persistence';
import type { CliResult } from './commands.ts';
import { seedWorld } from './world.ts';

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

/** `world migrate` — применяет неприменённые миграции общим runner-ом. */
export const runWorldMigrateCommand = async (db: DatabaseConnection): Promise<CliResult> => {
  const report = await runMigrations({ db, migrations, logger: SILENT_LOGGER });
  const applied = report.applied.map((entry) => `${entry.id}-${entry.name}`);
  const lines =
    applied.length === 0
      ? [`Схема уже на версии ${String(report.schemaVersion)}; применять нечего.`]
      : [`Применено: ${applied.join(', ')}`, `Версия схемы: ${String(report.schemaVersion)}`];
  return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
};

/** `world init --seed N` — записывает детерминированно порождённый мир в базу. */
export const runWorldInitCommand = async (
  db: DatabaseConnection,
  args: readonly string[],
): Promise<CliResult> => {
  const seed = parseSeed(args);
  if (typeof seed === 'string') return { stdout: `world init: ${seed}\n`, exitCode: 2 };

  const { state } = seedWorld(seed);
  const existing = await loadWorldState(db, state.worldId);
  if (existing !== null) {
    // Не идемпотентность, а защита истории: перезапись существующего мира стёрла бы его журнал.
    return {
      stdout: `world init: мир ${state.worldId} уже существует (версия ${String(existing.worldVersion)}).\n`,
      exitCode: 2,
    };
  }

  await initializeWorld(db, {
    seed,
    state,
    versions: testRulesetVersions(),
    content: {
      locations: PROTOTYPE_WORLD.locations.map((location) => ({
        id: location.id,
        name: location.name,
        description: location.description,
      })),
      agentNames: Object.fromEntries(PROTOTYPE_WORLD.agents.map((a) => [a.id, a.name])),
    },
  });

  return {
    stdout: `Мир ${state.worldId} создан из seed=${String(seed)}; версия ${String(state.worldVersion)}.\n`,
    exitCode: 0,
  };
};

/**
 * `world run --agent <id> --route <id> [--command-id <id>]` — начинает путь.
 *
 * Без `--command-id` он выводится из (мир, агент, маршрут, текущая версия мира). Это не
 * украшение: повтор ТОЙ ЖЕ команды при неизменившемся мире даёт тот же `command_id`, поэтому
 * идемпотентность (B3) наблюдается прямо в demo, без ручного копирования id.
 */
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

  const intentKey = `${state.worldId}:${agentId}:${routeId}:${String(state.worldVersion)}`;
  const ids = new DerivedIdFactory(intentKey);
  const command: Command = {
    command_id: flag(args, '--command-id') ?? ids.next(RUNTIME_ID_PREFIXES.command),
    world_id: state.worldId,
    type: 'journey.start',
    schema_version: testRulesetVersions().schemaVersion,
    actor_id: agentId,
    issued_at_world_time: state.worldTime,
    expected_world_version: state.worldVersion,
    correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
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

/** `world events` — канонический журнал в порядке sequence. */
export const runWorldEventsCommand = async (db: DatabaseConnection): Promise<CliResult> => {
  const rows = await db
    .selectFrom('world_events')
    .select(['event_id', 'sequence', 'type', 'world_time', 'actor_ids'])
    .where('world_id', '=', PROTOTYPE_WORLD.worldId)
    .orderBy('sequence')
    .execute();

  if (rows.length === 0) return { stdout: 'Событий нет.\n', exitCode: 0 };

  const lines = [`Событий: ${String(rows.length)}`];
  for (const row of rows) {
    const sequence = requireSafeInteger(row.sequence, 'world_events.sequence');
    lines.push(
      `  ${String(sequence).padStart(4)}  ${row.type.padEnd(18)} ${row.world_time}  ` +
        `${row.actor_ids.join(',')}  ${row.event_id}`,
    );
  }
  return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
};
