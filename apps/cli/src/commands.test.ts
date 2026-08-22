import { describe, expect, it } from 'vitest';
import { COMMANDS, renderCommandList } from './commands.ts';

const KNOWN_ITERATIONS = /^I\d{2}[AB]?$/;

describe('COMMANDS registry', () => {
  it('lists the documented world commands in registry order', () => {
    // I02A добавила четыре команды над durable-миром (PLAN §4.9), I02B добавила `world tick`
    // (scheduler-шаг), `world snapshot` (точка восстановления, ACCEPTANCE C8/OPS-04) и `world
    // replay` (пересимуляция и сверка checksum, C9/C10, PLAN §2/§4.7). Список остаётся точным,
    // а не «хотя бы содержит», чтобы новая команда не появлялась в CLI без осознанной правки
    // теста.
    expect(COMMANDS.map((c) => c.name)).toEqual([
      'world seed',
      'world migrate',
      'world init',
      'world run',
      'world state',
      'world events',
      'world tick',
      'world snapshot',
      'world replay',
      'world inspect',
      'world export',
    ]);
  });

  it('I01 дал seed/inspect, I02A — durable-команды, I02B — tick/snapshot/replay; export planned', () => {
    const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c.status] as const));
    expect(byName['world seed']).toBe('available');
    expect(byName['world inspect']).toBe('available');
    expect(byName['world migrate']).toBe('available');
    expect(byName['world init']).toBe('available');
    expect(byName['world run']).toBe('available');
    expect(byName['world state']).toBe('available');
    expect(byName['world events']).toBe('available');
    expect(byName['world tick']).toBe('available');
    expect(byName['world snapshot']).toBe('available');
    expect(byName['world replay']).toBe('available');
    // I02B: `world export` остаётся planned — projections/HTTP API/UI это I03 (PLAN §5).
    expect(byName['world export']).toBe('planned');
  });

  it('ровно команды I02A + tick/snapshot/replay (I02B) помечены requiresDatabase', () => {
    const needsDb = COMMANDS.filter((c) => c.requiresDatabase === true).map((c) => c.name);
    expect(needsDb).toEqual([
      'world migrate',
      'world init',
      'world run',
      'world state',
      'world events',
      'world tick',
      'world snapshot',
      'world replay',
    ]);
    // In-memory команды I01 обязаны работать без базы вовсе (A10 остаётся в силе).
    const inMemory = COMMANDS.filter((c) => ['world seed', 'world inspect'].includes(c.name));
    expect(inMemory.every((c) => c.requiresDatabase !== true)).toBe(true);
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
