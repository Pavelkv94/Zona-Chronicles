import type { WorldEvent } from '@zona/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureJourneyStartCommand, fixtureWorldState } from './__fixtures__/world.ts';
import { decide, type DraftWorldEvent } from './decide.ts';
import { evolve } from './evolve.ts';
import { FixedClock } from './ports/clock.ts';
import { SequentialIdFactory } from './ports/id-factory.ts';
import { DeterministicRandomSource } from './ports/random-source.ts';
import { testRuleset } from './ports/ruleset.ts';

/**
 * `recorded_at` — операционный wall clock, который домен не производит (см. `decide.ts`,
 * `evolve.ts`). Здесь его проставляет тест — ровно так, как в будущем это сделает адаптер
 * персистентности (I02A), — просто чтобы получить валидный `WorldEvent` для `evolve`.
 */
function stampRecordedAt(draft: DraftWorldEvent): WorldEvent {
  return { ...draft, recorded_at: '1970-01-01T00:00:00.000Z' };
}

/**
 * Replay determinism (SIM-01) на уровне decide/evolve: тот же seed и тот же world time дают
 * побайтово одинаковый batch событий и одинаковое следующее состояние — не «в одном процессе
 * повезло», а структурно, потому что decide/evolve — чистые функции над инъектированными
 * портами (A6). Полная A1 (100 процессов) проверяется в acceptance-наборе через CLI, а не
 * здесь: этот тест доказывает то же свойство на уровне доменного ядра, без CLI и без БД.
 */
describe('decide + evolve: replay determinism', () => {
  it('тот же seed/world time дают тот же event batch и то же следующее состояние', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 0, max: 200 }),
        (seed, extraMinutes) => {
          const isoWorldTime = `2034-05-17T18:${String(20 + (extraMinutes % 30)).padStart(2, '0')}:00Z`;
          const run = () => {
            const state = fixtureWorldState();
            const command = fixtureJourneyStartCommand();
            const context = {
              clock: new FixedClock(isoWorldTime),
              random: new DeterministicRandomSource(seed),
              ids: new SequentialIdFactory(seed),
              ruleset: testRuleset(),
            };
            const result = decide(state, command, context);
            if (result.kind !== 'accepted') {
              throw new Error('unreachable: fixture command is always accepted');
            }
            const nextStates = result.events.map((event) => evolve(state, stampRecordedAt(event)));
            return { events: result.events, nextStates };
          };

          const first = run();
          const second = run();
          expect(second).toStrictEqual(first);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('decide не меняет входное состояние (чистая функция)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000, max: 1_000 }), (seed) => {
        const state = fixtureWorldState();
        const before = JSON.parse(JSON.stringify(state)) as unknown;
        decide(state, fixtureJourneyStartCommand(), {
          clock: new FixedClock('2034-05-17T18:20:00Z'),
          random: new DeterministicRandomSource(seed),
          ids: new SequentialIdFactory(seed),
          ruleset: testRuleset(),
        });
        expect(JSON.parse(JSON.stringify(state))).toStrictEqual(before);
      }),
      { numRuns: 50 },
    );
  });
});
