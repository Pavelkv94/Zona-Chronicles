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
    // `world run` stays out of scope for I01 (PLAN §5); `world seed`/`world inspect` flipped to
    // 'available' when I01-T4 implemented them (was `runCli(['world', 'seed'])` in I00 — that
    // command is real now, see the tests below).
    const result = runCli(['world', 'run']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('world run');
    expect(result.stdout.toLowerCase()).toMatch(/not implemented|planned/);
    expect(result.stdout).toContain('I02A');
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
