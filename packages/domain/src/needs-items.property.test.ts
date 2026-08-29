/**
 * Свойства нужд и предметов (I04, PLAN §6).
 *
 * Три утверждения, каждое из которых должно быть верно для ЛЮБОГО прогона, а не для того,
 * который я придумал:
 *
 * - `bounded needs` — значение нужды всегда в `[0, 1]`;
 * - `conservation` — число предметов в мире меняется только стоком, и только вниз;
 * - «нельзя потратить дважды» — второй расход того же предмета отвергается ПО ПРИЧИНЕ, а не по
 *   совпадению.
 */
import { requireAddMinutes, requireInstant, type WorldEvent } from '@zona/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureWorldState } from './__fixtures__/world.ts';
import { decide, type DraftWorldEvent } from './decide.ts';
import { evolve } from './evolve.ts';
import { needValueAt, type NeedConfig } from './needs.ts';
import { FixedClock } from './ports/clock.ts';
import { SequentialIdFactory } from './ports/id-factory.ts';
import { DeterministicRandomSource } from './ports/random-source.ts';
import { testRuleset } from './ports/ruleset.ts';
import type { WorldState } from './state.ts';

const stamp = (draft: DraftWorldEvent): WorldEvent => ({
  ...draft,
  recorded_at: '1970-01-01T00:00:00.000Z',
});

const BASE = requireInstant('2028-04-26T06:00:00.000Z', 'стартовый момент теста');

/**
 * Момент «через N минут после стартового», посчитанный ТЕМИ ЖЕ средствами, что использует
 * продукт: правило `no-restricted-syntax` запрещает часы платформы и в тестах, и это не
 * формальность — тест, считающий время по-своему, проверял бы согласие с собственной арифметикой.
 */
const isoAt = (minutes: number): string => requireAddMinutes(BASE, minutes, 'сдвиг теста').iso;

describe('bounded needs: значение нужды не выходит из [0, 1] никогда', () => {
  it('ни при каком сдвиге времени и ни при каких коэффициентах', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100_000, max: 10_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (minutes, minutesToFull) => {
          const config: NeedConfig = {
            minutesToFull,
            warningAtPermille: 450,
            criticalAtPermille: 750,
          };
          const value = needValueAt(isoAt(0), isoAt(minutes), config);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          // И это ЧИСЛО, а не NaN: NaN тоже проходит оба сравнения выше как ложь, поэтому без
          // отдельной проверки свойство выполнялось бы «по недоразумению».
          expect(Number.isFinite(value)).toBe(true);
        },
      ),
    );
  });
});

/** Мир с одним агентом и заданным числом пайков у него. */
const worldWithFood = (count: number): WorldState => {
  const items: Record<string, { id: string; kind: 'food'; ownerId: string }> = {};
  for (let index = 0; index < count; index += 1) {
    const id = `item:ration-${String(index).padStart(2, '0')}`;
    items[id] = { id, kind: 'food', ownerId: 'agent:rook' };
  }
  return fixtureWorldState({ items });
};

const eatCommand = (itemId: string, commandId: string) =>
  ({
    command_id: commandId,
    world_id: 'world:prototype',
    type: 'agent.eat' as const,
    schema_version: 1,
    actor_id: 'agent:rook',
    issued_at_world_time: isoAt(0),
    correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    payload: { item_id: itemId },
  }) as const;

const context = (at: string) => ({
  clock: new FixedClock(at),
  random: new DeterministicRandomSource(1),
  ids: new SequentialIdFactory(1),
  ruleset: testRuleset(),
});

describe('conservation: предметы уходят из мира только стоком и только по одному', () => {
  it('после любой последовательности приёмов пищи число предметов равно числу событий стока', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (count) => {
        let state = worldWithFood(count);
        const initial = Object.keys(state.items).length;
        let sinkEvents = 0;

        for (const itemId of Object.keys(state.items)) {
          const result = decide(state, eatCommand(itemId, `cmd_${itemId}`), context(isoAt(1)));
          expect(result.kind).toBe('accepted');
          if (result.kind !== 'accepted') return;
          for (const draft of result.events) {
            const event = stamp(draft);
            if (event.type === 'agent.ate') sinkEvents += 1;
            state = evolve(state, event);
          }
        }

        // Ровно то, что требует §6: изменение числа предметов ОБЪЯСНЕНО событиями, а не просто
        // «стало меньше». Сравнение с числом фактов, а не с ожидаемым числом.
        expect(Object.keys(state.items)).toHaveLength(initial - sinkEvents);
        expect(sinkEvents).toBe(count);
      }),
    );
  });

  it('ни одно другое событие числа предметов не меняет', () => {
    // Отдых — единственное действие итерации, которое предметов не касается. Проверяется прямо:
    // «сток единственный» — это утверждение обо ВСЕХ событиях, а не только о съедении.
    const state = worldWithFood(3);
    const rest = decide(
      state,
      {
        ...eatCommand('item:ration-00', 'cmd_rest'),
        type: 'agent.rest' as const,
        payload: {},
      },
      context(isoAt(1)),
    );
    expect(rest.kind).toBe('accepted');
    if (rest.kind !== 'accepted') return;
    let next = state;
    for (const draft of rest.events) next = evolve(next, stamp(draft));
    expect(Object.keys(next.items)).toHaveLength(3);
  });
});

describe('нельзя потратить дважды', () => {
  it('второй расход того же предмета отвергается по названной причине', () => {
    let state = worldWithFood(2);
    const first = decide(state, eatCommand('item:ration-00', 'cmd_a'), context(isoAt(1)));
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') return;
    for (const draft of first.events) state = evolve(state, stamp(draft));

    const second = decide(state, eatCommand('item:ration-00', 'cmd_b'), context(isoAt(2)));
    expect(second.kind).toBe('rejected');
    if (second.kind !== 'rejected') return;
    // Причина названа, а не «просто отказ»: расход исчезнувшего предмета и расход чужого — это
    // разные ошибки, и различать их должен код отказа, а не читатель сообщения.
    expect(second.rejection.code).toBe('resource_unavailable');
    expect(second.rejection.message).toContain('item:ration-00');
  });

  it('чужой предмет не съедается: владелец ровно один', () => {
    const state = fixtureWorldState({
      items: { 'item:ration-00': { id: 'item:ration-00', kind: 'food', ownerId: 'agent:kite' } },
    });
    const result = decide(state, eatCommand('item:ration-00', 'cmd_c'), context(isoAt(1)));
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('resource_unavailable');
    expect(result.rejection.message).toContain('agent:kite');
  });
});
