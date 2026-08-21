import { describe, expect, it } from 'vitest';
import { COMMANDS, renderCommandList } from './commands.ts';

const KNOWN_ITERATIONS = /^I\d{2}[AB]?$/;

describe('COMMANDS registry', () => {
  it('lists the five documented world commands', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      'world seed',
      'world run',
      'world replay',
      'world inspect',
      'world export',
    ]);
  });

  it('flips world seed/inspect to available in I01, leaves the rest planned (PLAN §5 scope)', () => {
    const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c.status] as const));
    expect(byName['world seed']).toBe('available');
    expect(byName['world inspect']).toBe('available');
    expect(byName['world run']).toBe('planned');
    expect(byName['world replay']).toBe('planned');
    expect(byName['world export']).toBe('planned');
  });

  it('gives every command a non-empty summary and a valid iteration id', () => {
    for (const command of COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(0);
      expect(command.iteration).toMatch(KNOWN_ITERATIONS);
    }
  });
});

describe('renderCommandList', () => {
  it('renders every command name, status, and iteration', () => {
    const output = renderCommandList();
    for (const command of COMMANDS) {
      expect(output).toContain(command.name);
      expect(output).toContain(command.status);
      expect(output).toContain(command.iteration);
    }
  });
});
