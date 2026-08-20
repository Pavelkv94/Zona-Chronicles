import { describe, expect, it } from 'vitest';
import { COMMANDS, renderCommandList } from './commands.ts';

const KNOWN_ITERATIONS = /^I\d{2}[AB]?$/;

describe('COMMANDS registry', () => {
  it('lists the five documented world commands, all planned in I00', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      'world seed',
      'world run',
      'world replay',
      'world inspect',
      'world export',
    ]);
    for (const command of COMMANDS) {
      expect(command.status).toBe('planned');
    }
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
