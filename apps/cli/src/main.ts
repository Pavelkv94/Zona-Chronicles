/**
 * apps/cli — entrypoint (I00 skeleton). `runCli` is a pure function (no process/IO access) so it
 * can be unit-tested without spawning a process. `main()` is the only place that touches
 * `process.argv`/`process.stdout`/`process.exitCode`, and only runs when this file is executed
 * directly (not when imported by `main.test.ts`).
 */
import { pathToFileURL } from 'node:url';
import { COMMANDS, renderCommandList } from './commands.ts';

export type CliResult = {
  readonly stdout: string;
  readonly exitCode: number;
};

const HELP_FLAGS = new Set(['--help', '-h']);

/** Pure: given argv (without the node/script prefix), returns what to print and the exit code. */
export function runCli(argv: readonly string[]): CliResult {
  if (argv.length === 0 || argv.some((arg) => HELP_FLAGS.has(arg))) {
    return { stdout: renderCommandList(), exitCode: 0 };
  }

  const requested = argv.join(' ');
  const command = COMMANDS.find((c) => c.name === requested);

  if (!command) {
    return {
      stdout: `Unknown command: "${requested}"\n\n${renderCommandList()}`,
      exitCode: 2,
    };
  }

  if (command.status === 'planned') {
    return {
      stdout: `"${command.name}" is planned for ${command.iteration} and not implemented yet.\n`,
      exitCode: 1,
    };
  }

  // No 'available' command is registered in I00; reaching here would mean the registry promised
  // an implementation runCli does not have. Fail honestly instead of pretending to execute it.
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
