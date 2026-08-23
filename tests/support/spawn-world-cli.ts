/**
 * Spawns `apps/cli` as a separate OS process, twice over.
 *
 * A1 (`docs/iterations/I01-deterministic-domain-core/ACCEPTANCE.md`) is explicit that "same
 * result inside one process" does not count: it does not rule out dependence on module-init
 * order or accumulated state. That is why every function here uses `node:child_process`
 * (`spawnSync`), never an in-process `import` of `apps/cli`.
 *
 * Two entry points, for two different reasons:
 *
 * - `spawnWorldCliDirect` runs `node apps/cli/src/main.ts <argv>` directly — Node's native
 *   TypeScript support, no build step, matching how the CLI actually executes. It is fast
 *   enough to spawn 100+ times per test (see A1/A2/A3).
 * - `spawnWorldCliViaPnpm` runs `pnpm world <argv>`, exactly as ACCEPTANCE A10's Given/When/Then
 *   and the manual demo literally write it. It is reserved for the small number of invocations
 *   that must prove the `pnpm world` entrypoint itself exists and works — pnpm's workspace
 *   resolution overhead makes it unfit for a 100-process sweep.
 *
 * Right now (before I01-T4) both fail — the first because `apps/cli` has no argument parser for
 * `world seed --seed <N>` yet (only bare `world seed` is a registered, still-`planned` command),
 * the second because no root `world` script exists at all. Both failure modes are exercised and
 * asserted on by the acceptance tests, not hidden here.
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI_ENTRY = fileURLToPath(new URL('../../apps/cli/src/main.ts', import.meta.url));

/**
 * Собранные `dist` рабочих пакетов, без которых порождённый CLI не стартует.
 *
 * BL-1 (аудит I02A): у порождённого процесса нет alias-ов `vitest.config.ts`, поэтому
 * `@zona/persistence` он резолвит по `exports` пакета — в `dist/index.js`. `dist` не в git и
 * не собирается lifecycle-скриптом, так что на чистом дереве вместо осмысленного падения
 * получался `ERR_MODULE_NOT_FOUND` из недр Node. Проверка ниже превращает это в названную
 * причину: acceptance зависит от `pnpm build`, и это должно быть видно сразу.
 */
const REQUIRED_DIST_ENTRIES = ['contracts', 'domain', 'content', 'persistence'].map((name) =>
  fileURLToPath(new URL(`../../packages/${name}/dist/index.js`, import.meta.url)),
);

let distChecked = false;

function requireBuiltPackages(): void {
  if (distChecked) return;
  const missing = REQUIRED_DIST_ENTRIES.filter((entry) => !existsSync(entry));
  if (missing.length > 0) {
    throw new Error(
      'Acceptance порождает CLI отдельным процессом, который резолвит @zona/* в dist, а не в ' +
        `src. Не собрано: ${missing.join(', ')}. Запустите "pnpm build" перед "pnpm ` +
        'test:acceptance" (в CI build стоит до тест-шагов — см. .github/workflows/ci.yml).',
    );
  }
  distChecked = true;
}

/** Environment variables set to unroutable/refusing values, so an accidental network or DB
 *  connection attempt is forced to either hang (caught by `timeoutMs`) or fail loudly, instead
 *  of silently succeeding against a database that happens to be reachable on the test host.
 *  `203.0.113.0/24` is TEST-NET-3 (RFC 5737): reserved for documentation, never routed. */
export const POISONED_NETWORK_ENV: Readonly<Record<string, string>> = Object.freeze({
  DATABASE_URL: 'postgres://poison:poison@203.0.113.1:59999/poison',
  PGHOST: '203.0.113.1',
  PGPORT: '59999',
  PGUSER: 'poison',
  PGPASSWORD: 'poison',
  PGDATABASE: 'poison',
});

export interface CliInvocationOptions {
  /** Extra/overriding environment variables. Merged over a minimal baseline (see below), never
   *  over the full `process.env` of the test runner — a test asserting "works without X" must
   *  not accidentally inherit X from whoever happens to run it. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

export interface CliInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
  /** `null` when the process was killed (timeout or signal) instead of exiting normally. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Baseline environment every invocation gets unless explicitly overridden: a deterministic,
 *  UTC/C process plus PATH (needed to resolve `node`/`pnpm`) and HOME (pnpm reads it for its
 *  store). Anything else must be requested explicitly by the test — that is the whole point of
 *  A3 and of the no-network check. */
function baselineEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'PNPM_HOME']) {
    const value = process.env[key];
    if (value !== undefined) {
      inherited[key] = value;
    }
  }
  return { ...inherited, TZ: 'UTC', LC_ALL: 'C' };
}

function run(
  command: string,
  args: readonly string[],
  options: CliInvocationOptions,
): CliInvocationResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: Record<string, string> = { ...baselineEnv() };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  requireBuiltPackages();

  const startedAt = Date.now();
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    // No shell: argv is passed as an array, so seeds/flags never need shell-escaping and can
    // never be reinterpreted by a shell.
    shell: false,
  });
  const durationMs = Date.now() - startedAt;

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
    signal: result.signal,
    timedOut:
      result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
    durationMs,
  };
}

/** `node apps/cli/src/main.ts <argv>` — a fresh OS process, no pnpm overhead. */
export function spawnWorldCliDirect(
  argv: readonly string[],
  options: CliInvocationOptions = {},
): CliInvocationResult {
  return run(process.execPath, [CLI_ENTRY, ...argv], options);
}

/** `pnpm world <argv>` — the literal invocation ACCEPTANCE A10 and the manual demo specify. */
export function spawnWorldCliViaPnpm(
  argv: readonly string[],
  options: CliInvocationOptions = {},
): CliInvocationResult {
  return run('pnpm', ['world', ...argv], options);
}
