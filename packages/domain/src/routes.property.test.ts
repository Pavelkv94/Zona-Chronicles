/**
 * Свойства выбора дороги (I06-C, PLAN §7).
 *
 * Главное здесь — первое: **изменение канонической опасности дорог, о которых агент ничего не
 * знает, не меняет его выбора**. Это прямая проверка STOP-условия итерации, и она устроена
 * единственным способом, который что-то доказывает: канон МЕНЯЕТСЯ, а решение сравнивается до и
 * после. Проверка вида «в аргументах нет канона» доказывала бы форму вызова, а не поведение.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { GOAL_SCORE_UNIT } from '@zona/contracts';
import {
  chooseRoute,
  requireValidGoalWeights,
  type GoalWeights,
  type TravelOption,
} from './goals.ts';
import type { Command } from '@zona/contracts';
import { fixtureDecideContext, fixtureWorldState } from './__fixtures__/world.ts';
import { decide } from './decide.ts';
import type { WorldState } from './state.ts';

/** Три дороги из одной локации: одну агент прошёл, о двух других не знает ничего. */
const ROUTE_IDS = ['route:out-a', 'route:out-b', 'route:out-c'] as const;
const BASE = '2034-05-17T18:00:00.000Z';

const permille = fc.integer({ min: 0, max: 1000 });

const weightsArb: fc.Arbitrary<GoalWeights> = fc
  .tuple(permille, permille, permille)
  .map(([timeCost, margin, unknownRisk]) =>
    requireValidGoalWeights(
      {
        urgencyPermille: { normal: 0, warning: 400, critical: 900 },
        timeCostPermillePerHour: timeCost,
        switchMarginPermille: margin,
        assumedUnknownRiskPermille: unknownRisk,
      },
      'property',
    ),
  );

/** Дорога, о которой агент ЗНАЕТ. */
const knownArb: fc.Arbitrary<TravelOption> = fc.record({
  routeId: fc.constantFrom('route:known-a', 'route:known-b'),
  travelMinutes: fc.integer({ min: 1, max: 600 }),
  perceivedRisk: permille,
});

/** Дорога, о которой агент НЕ знает: воспринимаемого риска у неё нет вовсе. */
const unknownArb: fc.Arbitrary<TravelOption> = fc.record({
  routeId: fc.constantFrom('route:unknown-a', 'route:unknown-b'),
  travelMinutes: fc.integer({ min: 1, max: 600 }),
  perceivedRisk: fc.constant(null),
});

const cautionArb = fc.integer({ min: 0, max: 2000 });

describe('canonical risk неизвестных дорог на выбор не влияет (STOP-условие I06)', () => {
  /**
   * Проверяется на `decide`, а не на `chooseRoute`, и это существенно.
   *
   * `chooseRoute` канона не видит по своей сигнатуре — доказывать на ней «утечки нет» значило бы
   * доказывать форму вызова. Утечь канон может ровно в одном месте: при сборке ситуации из
   * состояния мира. Поэтому здесь меняется САМ МИР — опасность дорог, которых агент не проходил,
   * — и сравнивается решение до и после.
   *
   * Первая редакция этого теста строила две «версии мира» одинаковыми и потому не проверяла
   * ничего: канонические значения в неё передавались и не использовались.
   */
  const worldWith = (
    canonicalRisks: Readonly<Record<string, number>>,
    known: Readonly<Record<string, number>>,
  ): WorldState =>
    fixtureWorldState({
      agents: {
        'agent:rook': {
          id: 'agent:rook',
          locationId: 'loc:quiet-yard',
          status: 'idle',
          routeId: null,
          needBaseline: { hunger: BASE, fatigue: BASE },
          goal: 'flee',
          planId: 'plan:rook-flee-1',
          caution: 1000,
          knownRoutes: Object.fromEntries(
            Object.entries(known).map(([routeId, risk]) => [
              routeId,
              { risk, at: BASE, sourceEventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
            ]),
          ),
        },
      },
      locations: { 'loc:quiet-yard': { id: 'loc:quiet-yard', risk: 600 } },
      routes: Object.fromEntries(
        ROUTE_IDS.map((routeId, index) => [
          routeId,
          {
            id: routeId,
            fromLocationId: 'loc:quiet-yard',
            toLocationId: `loc:out-${String(index)}`,
            travelMinutes: 30 + index * 10,
            risk: canonicalRisks[routeId] ?? 0,
          },
        ]),
      ),
      items: {},
      scheduledActions: {},
    });

  const travelCommand = (): Command => ({
    command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    world_id: 'world:prototype',
    type: 'agent.travel',
    schema_version: 1,
    actor_id: 'agent:rook',
    issued_at_world_time: BASE,
    correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    payload: {},
  });

  const chosenRouteOf = (state: WorldState): string => {
    const result = decide(state, travelCommand(), fixtureDecideContext());
    if (result.kind !== 'accepted') return `rejected:${result.rejection.code}`;
    const [event] = result.events;
    return event?.type === 'journey.started'
      ? event.payload.route_id
      : `other:${String(event?.type)}`;
  };

  it('какой бы ни была настоящая опасность непройденных дорог, агент уходит одной и той же', () => {
    fc.assert(
      fc.property(
        // Знание — только о ПЕРВОЙ дороге; об остальных агент не знает ничего.
        permille,
        fc.tuple(permille, permille),
        fc.tuple(permille, permille),
        (knownRisk, canonA, canonB) => {
          const known = { [ROUTE_IDS[0] as string]: knownRisk };
          const a = worldWith(
            { [ROUTE_IDS[1] as string]: canonA[0], [ROUTE_IDS[2] as string]: canonA[1] },
            known,
          );
          const b = worldWith(
            { [ROUTE_IDS[1] as string]: canonB[0], [ROUTE_IDS[2] as string]: canonB[1] },
            known,
          );
          expect(chosenRouteOf(a)).toBe(chosenRouteOf(b));
        },
      ),
    );
  });

  it('а изменение того, что агент ЗНАЕТ, выбор менять может', () => {
    // Контрольное утверждение: без него первое проходило бы и на функции, которая всегда
    // возвращает одно и то же.
    const safeKnown = worldWith({}, { [ROUTE_IDS[0] as string]: 0 });
    const dangerousKnown = worldWith({}, { [ROUTE_IDS[0] as string]: 1000 });
    expect(chosenRouteOf(safeKnown)).toBe(ROUTE_IDS[0]);
    expect(chosenRouteOf(dangerousKnown)).not.toBe(ROUTE_IDS[0]);
  });
});

describe('цена дороги конечна, целая и ограничена', () => {
  it('при любых коэффициентах, любой осторожности и любом знании', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(knownArb, unknownArb), { minLength: 1, maxLength: 4 }),
        weightsArb,
        cautionArb,
        (options, weights, caution) => {
          const best = chooseRoute(options, weights, caution);
          expect(best).not.toBeNull();
          // Конечность проверяется ОТДЕЛЬНО: `NaN` проходит оба сравнения границ как ложь.
          expect(Number.isFinite(best?.cost ?? Number.NaN)).toBe(true);
          expect(Number.isInteger(best?.cost ?? Number.NaN)).toBe(true);
          expect(best?.cost).toBeGreaterThanOrEqual(0);
          expect(best?.cost).toBeLessThanOrEqual(GOAL_SCORE_UNIT.max);
        },
      ),
    );
  });
});

describe('идти некуда — это исход, а не ошибка', () => {
  it('пустой набор дорог даёт null, а не бесконечную цену', () => {
    fc.assert(
      fc.property(weightsArb, cautionArb, (weights, caution) => {
        expect(chooseRoute([], weights, caution)).toBeNull();
      }),
    );
  });
});

describe('ничья решается ключом дороги, а не порядком перебора', () => {
  it('перестановка списка не меняет выбранную дорогу', () => {
    const weights = requireValidGoalWeights(
      {
        urgencyPermille: { normal: 0, warning: 400, critical: 900 },
        timeCostPermillePerHour: 25,
        switchMarginPermille: 100,
        assumedUnknownRiskPermille: 300,
      },
      'tie',
    );
    const a: TravelOption = { routeId: 'route:a', travelMinutes: 40, perceivedRisk: 200 };
    const b: TravelOption = { routeId: 'route:b', travelMinutes: 40, perceivedRisk: 200 };
    expect(chooseRoute([a, b], weights, 1000)?.routeId).toBe('route:a');
    expect(chooseRoute([b, a], weights, 1000)?.routeId).toBe('route:a');
  });
});
