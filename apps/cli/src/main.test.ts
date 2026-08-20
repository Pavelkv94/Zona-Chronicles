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

  it('reports a planned command as not implemented and exits 1, without simulating work', () => {
    const result = runCli(['world', 'seed']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('world seed');
    expect(result.stdout.toLowerCase()).toMatch(/not implemented|planned/);
    expect(result.stdout).toContain('I01');
  });

  it('reports an unknown command with a clear error and exits 2', () => {
    const result = runCli(['world', 'nonexistent']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toLowerCase()).toContain('unknown command');
  });
});
