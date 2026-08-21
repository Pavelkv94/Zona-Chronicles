/**
 * apps/cli — `world seed`/`world inspect` command implementations (I01, ACCEPTANCE A1/A2/A3/A9/A10).
 *
 * Pure functions of argv -> `{ stdout, exitCode }`, the same shape `runCli` (`main.ts`) already
 * uses for every other command: no `process.stdout`/`process.exitCode` access here, so both stay
 * unit-testable without spawning a process. `main.ts` is still the only place that touches real
 * process I/O.
 */
import {
  type Snapshot,
  canonicalize,
  compareByCodePoint,
  isCanonicalizationError,
} from '@zona/contracts';
import type { WorldDefinition } from '@zona/content';
import type { WorldState } from '@zona/domain';
import type { CliResult } from './commands.ts';
import { seedWorld } from './world.ts';

type SeedParseResult =
  | { readonly kind: 'ok'; readonly seed: number }
  | { readonly kind: 'error'; readonly message: string };

const SEED_FLAG = '--seed';
const INTEGER_PATTERN = /^-?\d+$/;

/** Разбирает `--seed <N>`. Единственный обязательный флаг обеих команд (ACCEPTANCE A10). */
function parseSeedArg(args: readonly string[]): SeedParseResult {
  const index = args.indexOf(SEED_FLAG);
  if (index === -1) {
    return { kind: 'error', message: `отсутствует обязательный флаг ${SEED_FLAG} <N>` };
  }
  const raw = args[index + 1];
  if (raw === undefined) {
    return { kind: 'error', message: `${SEED_FLAG} требует значение` };
  }
  if (!INTEGER_PATTERN.test(raw)) {
    return {
      kind: 'error',
      message: `${SEED_FLAG} ожидает целое число, получено ${JSON.stringify(raw)}`,
    };
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed)) {
    return { kind: 'error', message: `${SEED_FLAG} вне безопасного диапазона целых: ${raw}` };
  }
  return { kind: 'ok', seed };
}

/** Каноническая JSON-строка снимка — самодостаточна, checksum это её собственное поле (A9). */
function canonicalSnapshotJson(snapshot: Snapshot): string {
  const result = canonicalize(snapshot);
  if (isCanonicalizationError(result)) {
    // Программная ошибка: снимок построен `seedWorld` из собственных детерминированных данных
    // и обязан быть канонически сериализуем — если это не так, дело не во входе пользователя.
    throw new Error(`world seed: снимок неканоничен в ${result.path}: ${result.error}`);
  }
  return result.json;
}

export function runWorldSeedCommand(args: readonly string[]): CliResult {
  const parsed = parseSeedArg(args);
  if (parsed.kind === 'error') {
    return { stdout: `world seed: ${parsed.message}\n`, exitCode: 2 };
  }
  const { snapshot } = seedWorld(parsed.seed);
  // Одна строка на stdout: canonical JSON снимка, включая checksum (ACCEPTANCE A9/A10 — форма
  // вывода `world seed`, решение lead-а). Отдельной строки с checksum нет.
  return { stdout: `${canonicalSnapshotJson(snapshot)}\n`, exitCode: 0 };
}

function sortedBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareByCodePoint(key(a), key(b)));
}

function renderLocations(content: WorldDefinition): string {
  const lines = [`Локации (${String(content.locations.length)}):`];
  for (const location of sortedBy(content.locations, (l) => l.id)) {
    lines.push(`  ${location.id.padEnd(20)} ${location.name}`);
  }
  return lines.join('\n');
}

function renderRoutes(content: WorldDefinition): string {
  const lines = [`Маршруты (${String(content.routes.length)}):`];
  for (const route of sortedBy(content.routes, (r) => r.id)) {
    lines.push(
      `  ${route.id.padEnd(28)} ${route.fromLocationId} -> ${route.toLocationId} (${String(route.travelMinutes)} мин)`,
    );
  }
  return lines.join('\n');
}

function renderAgents(content: WorldDefinition, state: WorldState): string {
  const lines = [`Агенты (${String(content.agents.length)}):`];
  for (const agentDef of sortedBy(content.agents, (a) => a.id)) {
    const agent = state.agents[agentDef.id];
    const where = agent === undefined ? 'неизвестно где' : `${agent.status} at ${agent.locationId}`;
    lines.push(`  ${agentDef.id.padEnd(14)} ${agentDef.name.padEnd(10)} ${where}`);
  }
  return lines.join('\n');
}

export function runWorldInspectCommand(args: readonly string[]): CliResult {
  const parsed = parseSeedArg(args);
  if (parsed.kind === 'error') {
    return { stdout: `world inspect: ${parsed.message}\n`, exitCode: 2 };
  }
  const { seed, content, state } = seedWorld(parsed.seed);
  const lines = [
    `Мир ${state.worldId} (seed=${String(seed)})`,
    `Мировое время: ${state.worldTime}`,
    '',
    renderLocations(content),
    '',
    renderRoutes(content),
    '',
    renderAgents(content, state),
  ];
  return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
}
