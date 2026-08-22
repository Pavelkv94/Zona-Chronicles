/**
 * apps/cli — command registry as data (I00).
 *
 * `docs/10_ITERATION_MASTER_PLAN.md` names `world seed` and `world inspect` explicitly under I01
 * ("CLI in-memory `world seed` и `world inspect`") and `world replay` explicitly under I02B
 * ("replay/resimulation CLI"). `world run` (starting a journey, I02A: "CLI начинает путь"),
 * `world tick` (worker step, I02B PLAN §2 demo: "pnpm world tick") and `world export` (exporting
 * a replay/projection view, alongside I02B replay tooling) are not literally named commands in
 * the master plan; their iteration below is the closest documented scope and should be corrected
 * once those iterations define the CLI surface precisely.
 *
 * No implementation is simulated here: every command in I00 is `status: 'planned'` and `runCli`
 * (apps/cli/src/main.ts) reports that honestly with exit code 1 instead of pretending to run.
 *
 * I01 lands real implementations for `world seed`/`world inspect` (ACCEPTANCE A1/A2/A3/A10,
 * `apps/cli/src/world-cli.ts`) — their `status` flips to `'available'` here; `runCli` still
 * consults this registry for name/iteration lookup and to decide whether an unimplemented
 * command should say "planned" honestly. `world run`/`world tick`/`world replay`/`world export`
 * stay `'planned'` through I01: out of scope for that iteration (PLAN §5).
 */

/**
 * Shared result shape for `runCli` (`main.ts`) and every per-command implementation
 * (`world-cli.ts`, ...). Lives here rather than in `main.ts` so command modules don't need to
 * import `main.ts` for a type — that import direction would create a real import cycle
 * (`main.ts` -> `world-cli.ts` -> `main.ts`), caught by `pnpm boundaries:check`
 * (`no-circular`) even though the import is type-only and erased at runtime.
 */
export type CliResult = {
  readonly stdout: string;
  readonly exitCode: number;
};

export type CommandStatus = 'planned' | 'available';

export type CliCommand = {
  readonly name: string;
  readonly summary: string;
  readonly status: CommandStatus;
  /** Iteration id from `docs/10_ITERATION_MASTER_PLAN.md` that introduces this command. */
  readonly iteration: string;
  /**
   * I02A: the command talks to PostgreSQL, so it is async and needs `DATABASE_URL`. Kept as
   * DATA here rather than as a check inside each command, so `main.ts` can decide once whether
   * to open a connection at all — and so `--help` can say which commands need a database.
   */
  readonly requiresDatabase?: boolean;
};

export const COMMANDS: readonly CliCommand[] = [
  {
    name: 'world seed',
    summary: 'Create a new in-memory canonical world from a seed.',
    status: 'available',
    iteration: 'I01',
  },
  {
    name: 'world migrate',
    summary: 'Apply pending database migrations.',
    status: 'available',
    iteration: 'I02A',
    requiresDatabase: true,
  },
  {
    name: 'world init',
    summary: 'Create a durable world in the database from a seed.',
    status: 'available',
    iteration: 'I02A',
    requiresDatabase: true,
  },
  {
    name: 'world run',
    summary: 'Start a journey/command against the running world.',
    status: 'available',
    iteration: 'I02A',
    requiresDatabase: true,
  },
  {
    name: 'world state',
    summary: 'Print the durable canonical state stored in the database.',
    status: 'available',
    iteration: 'I02A',
    requiresDatabase: true,
  },
  {
    name: 'world events',
    summary: 'Print the durable canonical event log.',
    status: 'available',
    iteration: 'I02A',
    requiresDatabase: true,
  },
  {
    name: 'world tick',
    summary: 'Run one worker step: claim and execute due scheduled actions.',
    status: 'available',
    iteration: 'I02B',
    requiresDatabase: true,
  },
  {
    name: 'world replay',
    summary: 'Resimulate a world from its canonical event log.',
    status: 'planned',
    iteration: 'I02B',
  },
  {
    name: 'world inspect',
    summary: 'Print the current canonical state of a world.',
    status: 'available',
    iteration: 'I01',
  },
  {
    name: 'world export',
    summary: 'Export a world projection/replay artifact to disk.',
    status: 'planned',
    iteration: 'I02B',
  },
];

/** Renders the command registry as human-readable text for `--help` and no-argument invocations. */
export function renderCommandList(): string {
  const lines = ['Available commands:', ''];
  for (const command of COMMANDS) {
    const database = command.requiresDatabase === true ? ' (needs DATABASE_URL)' : '';
    lines.push(
      `  ${command.name.padEnd(16)} [${command.status}, ${command.iteration}]  ${command.summary}${database}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
