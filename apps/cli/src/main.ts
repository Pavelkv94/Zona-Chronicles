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
import { runWorldInspectCommand, runWorldSeedCommand } from './world-cli.ts';

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

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}
