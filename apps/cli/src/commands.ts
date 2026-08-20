/**
 * apps/cli — command registry as data (I00).
 *
 * `docs/10_ITERATION_MASTER_PLAN.md` names `world seed` and `world inspect` explicitly under I01
 * ("CLI in-memory `world seed` и `world inspect`") and `world replay` explicitly under I02B
 * ("replay/resimulation CLI"). `world run` (starting a journey, I02A: "CLI начинает путь") and
 * `world export` (exporting a replay/projection view, alongside I02B replay tooling) are not
 * literally named commands in the master plan; their iteration below is the closest documented
 * scope and should be corrected once those iterations define the CLI surface precisely.
 *
 * No implementation is simulated here: every command in I00 is `status: 'planned'` and `runCli`
 * (apps/cli/src/main.ts) reports that honestly with exit code 1 instead of pretending to run.
 */

export type CommandStatus = 'planned' | 'available';

export type CliCommand = {
  readonly name: string;
  readonly summary: string;
  readonly status: CommandStatus;
  /** Iteration id from `docs/10_ITERATION_MASTER_PLAN.md` that introduces this command. */
  readonly iteration: string;
};

export const COMMANDS: readonly CliCommand[] = [
  {
    name: 'world seed',
    summary: 'Create a new in-memory canonical world from a seed.',
    status: 'planned',
    iteration: 'I01',
  },
  {
    name: 'world run',
    summary: 'Start a journey/command against the running world.',
    status: 'planned',
    iteration: 'I02A',
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
    status: 'planned',
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
    lines.push(
      `  ${command.name.padEnd(16)} [${command.status}, ${command.iteration}]  ${command.summary}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
