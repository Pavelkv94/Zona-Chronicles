/**
 * apps/cli — entrypoint (I00 skeleton, I01 real `world seed`/`world inspect`). `runCli` is a
 * pure function (no process/IO access) so it can be unit-tested without spawning a process.
 * `main()` is the only place that touches `process.argv`/`process.stdout`/`process.exitCode`,
 * and only runs when this file is executed directly (not when imported by `main.test.ts`).
 *
 * Command names are two tokens (`world seed`, `world inspect`, ...) matching `COMMANDS` in
 * `commands.ts`; everything after those two tokens is flags for that command (`--seed 42`).
 * Both acceptance-test invocation shapes land on the SAME argv here on purpose
 * (`tests/acceptance/support/spawn-world-cli.ts`):
 *
 * - `spawnWorldCliDirect` runs `node apps/cli/src/main.ts world seed --seed 42` — `argv` is
 *   `['world', 'seed', '--seed', '42']` already.
 * - `spawnWorldCliViaPnpm` runs `pnpm world seed --seed 42`; the root `"world"` script is
 *   `node apps/cli/src/main.ts world` (re-injecting the literal `world` token pnpm's script
 *   resolution consumes), so the process again sees `['world', 'seed', '--seed', '42']`. If the
 *   root script is ever defined without that trailing `world`, this file's parsing and A10 both
 *   need to change together.
 */
import { pathToFileURL } from 'node:url';
import { COMMANDS, type CliResult, renderCommandList } from './commands.ts';
import { loadCliConfig, type CliConfig } from './config.ts';
import { runWorldInspectCommand, runWorldSeedCommand } from './world-cli.ts';
import {
  connect,
  runWorldEventsCommand,
  runWorldInitCommand,
  runWorldMigrateCommand,
  runWorldRunCommand,
  runWorldStateCommand,
} from './world-db-cli.ts';

export type { CliResult } from './commands.ts';

const HELP_FLAGS = new Set(['--help', '-h']);

/** Pure: given argv (without the node/script prefix), returns what to print and the exit code. */
export function runCli(argv: readonly string[]): CliResult {
  if (argv.length === 0 || argv.some((arg) => HELP_FLAGS.has(arg))) {
    return { stdout: renderCommandList(), exitCode: 0 };
  }

  const commandName = argv.slice(0, 2).join(' ');
  const command = COMMANDS.find((c) => c.name === commandName);

  if (!command) {
    const requested = argv.join(' ');
    return {
      stdout: `Unknown command: "${requested}"\n\n${renderCommandList()}`,
      exitCode: 2,
    };
  }

  const commandArgs = argv.slice(2);

  switch (command.name) {
    case 'world seed':
      return runWorldSeedCommand(commandArgs);
    case 'world inspect':
      return runWorldInspectCommand(commandArgs);
    default:
      break;
  }

  if (command.requiresDatabase === true) {
    // Не «не реализовано»: команда реализована, но она асинхронна и требует подключения.
    // `runCli` обязан остаться чистым и синхронным, поэтому здесь — честное указание пути,
    // а не тихий возврат пустого результата.
    return {
      stdout:
        `"${command.name}" работает с базой и исполняется через runCliAsync ` +
        `(нужен DATABASE_URL); runCli остаётся чистым и синхронным.\n`,
      exitCode: 1,
    };
  }

  if (command.status === 'planned') {
    return {
      stdout: `"${command.name}" is planned for ${command.iteration} and not implemented yet.\n`,
      exitCode: 1,
    };
  }

  // Every currently-'available' command is wired above; reaching here would mean the registry
  // promised an implementation runCli does not have. Fail honestly instead of pretending to run.
  return {
    stdout: `"${command.name}" is registered as available but has no wired execution in this build.\n`,
    exitCode: 1,
  };
}

/**
 * I02A: команды над durable-миром асинхронны и требуют подключения. `runCli` намеренно остаётся
 * ЧИСТЫМ и синхронным — он по-прежнему решает всё, что решается без базы (help, неизвестная
 * команда, in-memory `world seed`/`world inspect`), и его юнит-тесты не поднимают PostgreSQL.
 * Асинхронный слой добавляется здесь и только для команд, помеченных `requiresDatabase`.
 *
 * Подключение открывается и закрывается вокруг ОДНОЙ команды: CLI — короткоживущий процесс, и
 * оставленный пул не давал бы ему завершиться (что и проверяет B9, порождая настоящие процессы).
 */
export async function runCliAsync(argv: readonly string[], config: CliConfig): Promise<CliResult> {
  const commandName = argv.slice(0, 2).join(' ');
  const command = COMMANDS.find((c) => c.name === commandName);
  if (command?.requiresDatabase !== true) return runCli(argv);

  // BL-2: миграции идут под ролью владельца схемы, всё остальное — под рантайм-ролью с
  // least privilege. Разделение ролей обязано существовать в РАБОТАЮЩЕМ пути, а не только
  // в миграции, которая их создаёт.
  const isMigration = command.name === 'world migrate';
  const databaseUrl = isMigration
    ? (config.migrationDatabaseUrl ?? config.databaseUrl)
    : config.databaseUrl;

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    return {
      stdout: `"${command.name}" требует ${
        isMigration ? 'MIGRATION_DATABASE_URL или DATABASE_URL' : 'DATABASE_URL'
      } (см. docker-compose.yml).\n`,
      exitCode: 2,
    };
  }

  const commandArgs = argv.slice(2);
  const db = connect(databaseUrl);
  try {
    switch (command.name) {
      case 'world migrate':
        return await runWorldMigrateCommand(
          db,
          databaseUrl,
          config.migrationDatabaseUrl === undefined,
          config.rolePassword,
        );
      case 'world init':
        return await runWorldInitCommand(db, commandArgs);
      case 'world run':
        return await runWorldRunCommand(db, commandArgs);
      case 'world state':
        return await runWorldStateCommand(db);
      case 'world events':
        return await runWorldEventsCommand(db);
      default:
        // Реестр пометил команду как требующую базу, но здесь её нет — честный отказ вместо
        // молчаливого падения в синхронный путь, который базу не откроет.
        return {
          stdout: `"${command.name}" помечена requiresDatabase, но не подключена в runCliAsync.\n`,
          exitCode: 1,
        };
    }
  } finally {
    await db.destroy();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  // M-5: без catch необработанная ошибка печатала стек, а стек `parseDatabaseConnectionUrl`
  // содержал строку подключения целиком — вместе с паролем. Сообщение печатается, стек нет.
  try {
    const result = await runCliAsync(process.argv.slice(2), loadCliConfig());
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    // N-1: рассогласование журнала миграций — не «что-то сломалось», а конкретная ситуация с
    // конкретным выходом. Без подсказки оператор видит только код ошибки и не знает, что
    // делать; с ней — знает, что база отстала от несовместимо изменившегося реестра.
    if (/MIGRATION_(NAME|CHECKSUM)_MISMATCH/.test(message)) {
      process.stderr.write(
        '\nЖурнал этой базы описывает миграцию, которая с тех пор изменилась несовместимо. ' +
          'Автоматического пути вперёд нет: применённая миграция неизменяема по построению.\n' +
          'Для одноразовой dev-базы — пересоздать её (`docker compose down -v` или ' +
          '`drop database`). Для базы с данными — восстановление по runbook, а не догадками.\n',
      );
    }
    process.exitCode = 1;
  }
}
