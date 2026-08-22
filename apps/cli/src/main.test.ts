import { decodeSnapshot, isValidationFailure } from '@zona/contracts';
import { describe, expect, it } from 'vitest';
import { runCli } from './main.ts';
import { COMMANDS } from './commands.ts';

describe('runCli', () => {
  it('prints the command list and exits 0 with no arguments', () => {
    const result = runCli([]);
    expect(result.exitCode).toBe(0);
    for (const command of COMMANDS) {
      expect(result.stdout).toContain(command.name);
    }
  });

  it('prints the command list and exits 0 with --help', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('world seed');
  });

  it('reports a still-planned command as not implemented and exits 1, without simulating work', () => {
    // Раньше здесь стояла `world run`, потом `world replay` — обе реализованы (I02A, I02B).
    // Тест переехал на `world export`, которая ДЕЙСТВИТЕЛЬНО ещё не реализована (I03: projections/
    // HTTP API/UI, PLAN §5), а не был ослаблен под новое поведение.
    const result = runCli(['world', 'export']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('world export');
    expect(result.stdout.toLowerCase()).toMatch(/not implemented|planned/);
    expect(result.stdout).toContain('I02B');
  });

  it('команда с базой не исполняется синхронным runCli и говорит об этом прямо', () => {
    const result = runCli(['world', 'run']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('runCliAsync');
    expect(result.stdout).toContain('DATABASE_URL');
    // Именно НЕ «не реализовано»: команда реализована, просто путь исполнения другой.
    expect(result.stdout.toLowerCase()).not.toMatch(/not implemented|planned/);
  });

  it('reports an unknown command with a clear error and exits 2', () => {
    const result = runCli(['world', 'nonexistent']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toLowerCase()).toContain('unknown command');
  });

  // I01 ACCEPTANCE A1/A2/A9/A10 — full end-to-end coverage (100 separate OS processes,
  // TZ/locale invariance, `pnpm world` entrypoint) lives in `tests/acceptance/**`, not here;
  // these are the fast in-process sanity checks that belong to `apps/cli`'s own unit suite.
  describe('world seed', () => {
    it('prints one line of canonical JSON snapshot and exits 0', () => {
      const result = runCli(['world', 'seed', '--seed', '42']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
      const decoded = decodeSnapshot(JSON.parse(result.stdout.trim()) as unknown);
      expect(isValidationFailure(decoded), JSON.stringify(decoded)).toBe(false);
    });

    it('same seed gives identical output; different seed gives a different checksum', () => {
      const first = runCli(['world', 'seed', '--seed', '42']);
      const same = runCli(['world', 'seed', '--seed', '42']);
      const other = runCli(['world', 'seed', '--seed', '43']);
      expect(same.stdout).toBe(first.stdout);
      expect(other.stdout).not.toBe(first.stdout);
    });

    it('reports a usage error and exits 2 when --seed is missing', () => {
      const result = runCli(['world', 'seed']);
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toLowerCase()).toContain('--seed');
    });

    it('reports a usage error and exits 2 when --seed is not an integer', () => {
      const result = runCli(['world', 'seed', '--seed', 'not-a-number']);
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toLowerCase()).toContain('--seed');
    });
  });

  describe('world inspect', () => {
    it('prints agents, locations and routes, and exits 0', () => {
      const result = runCli(['world', 'inspect', '--seed', '42']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('agent:rook');
      expect(result.stdout).toContain('loc:quiet-yard');
      expect(result.stdout).toContain('route:yard-to-bridge');
    });

    it('reports a usage error and exits 2 when --seed is missing', () => {
      const result = runCli(['world', 'inspect']);
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toLowerCase()).toContain('--seed');
    });
  });
});
