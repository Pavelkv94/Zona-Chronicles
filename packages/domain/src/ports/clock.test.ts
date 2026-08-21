import { describe, expect, it } from 'vitest';
import { isInstantError } from '@zona/contracts';
import { FixedClock } from './clock.ts';

describe('FixedClock', () => {
  it('всегда отдаёт один и тот же инъектированный момент', () => {
    const clock = new FixedClock('2034-05-17T18:20:00Z');
    const first = clock.now();
    const second = clock.now();
    expect(first).toStrictEqual(second);
    expect(first.iso).toBe('2034-05-17T18:20:00Z');
    expect(first.epochMs).toBeTypeOf('number');
  });

  it('отвергает невалидный ISO-момент на границе конструктора, а не в now()', () => {
    expect(() => new FixedClock('не время')).toThrow(/FixedClock/);
  });

  it('момент, отданный now(), — валидный Instant, а не InstantError', () => {
    const clock = new FixedClock('2034-05-17T18:20:00.500Z');
    expect(isInstantError(clock.now())).toBe(false);
  });
});
