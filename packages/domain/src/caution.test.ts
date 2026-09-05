/**
 * Осторожность и цена незнания — две величины, которые ПЕРЕЖИЛИ свои первые тесты (I06, review).
 *
 * Независимое ревью поставило две мутации и не получило ни одного красного теста во всём наборе:
 *
 * - `caution` перестала умножать риск (`durationCost + perceived`) — 1032 unit/property/contract
 *   и 160 integration прошли;
 * - незнание стало считаться безопасностью (`perceivedRisk ?? 0`) — то же самое.
 *
 * Причина у обеих одна и та же, и она поучительна: КАЖДАЯ поведенческая фикстура пинила
 * `caution: 1000`, то есть ровно тот множитель, при котором осторожности не видно, — а миры, в
 * которых сравнивались дороги, были устроены так, что цена незнания сокращалась в сравнении.
 * Утверждения при этом стояли в плане (§4.4, §4.5), в отчёте (§2), в трассировке требований, в
 * миграции 0021 и во втором draw генезисного PRNG. Заявлено всюду, доказано нигде.
 *
 * Здесь эти два утверждения получают детекторы. Числа подобраны так, чтобы решение МЕНЯЛОСЬ —
 * проверяется поведение, а не арифметика.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from '@zona/contracts';
import { chooseGoal, chooseRoute, type GoalSituation, type TravelOption } from './goals.ts';
import {
  PROTOTYPE_CAUTION_RANGE,
  PROTOTYPE_GOAL_WEIGHTS,
  PROTOTYPE_REST_MINUTES,
} from './ports/ruleset.ts';
import { fixtureDecideContext, fixtureWorldState } from './__fixtures__/world.ts';
import { decide } from './decide.ts';
import type { WorldState } from './state.ts';

const W = PROTOTYPE_GOAL_WEIGHTS;

/**
 * Границы черты берутся ИЗ ПРАВИЛ: пробы обязаны стоять внутри диапазона, который мир реально
 * разыгрывает. Выписанные числами, они пережили бы сужение диапазона и проверяли бы агентов,
 * которых генезис больше не порождает.
 */
const BOLD = PROTOTYPE_CAUTION_RANGE.minPermille;
const CAUTIOUS = PROTOTYPE_CAUTION_RANGE.maxPermille;

const situation = (overrides: Partial<GoalSituation> = {}): GoalSituation => ({
  currentGoal: 'idle',
  needLevels: { hunger: 'normal', fatigue: 'normal' },
  hasFood: true,
  isIdle: true,
  restMinutes: PROTOTYPE_REST_MINUTES,
  locationRisk: 0,
  travelOptions: [],
  ...overrides,
});

describe('осторожность решает, а не украшает', () => {
  /**
   * Короткая скверная дорога против длинной спокойной. ОБЕ известны: пока обе безымянны,
   * воспринимаемый риск у них одинаков и в сравнении сокращается — характеру негде проявиться.
   *
   * Цены при коэффициентах прототипа: короткая 50 + 0.5·c, длинная 400 + 0.1·c. Пересечение
   * приходится на c = 875, то есть внутри разыгрываемого диапазона [500, 1500], и по обе
   * стороны от него стоят настоящие агенты, а не выдуманные.
   */
  const SHORT_RISKY: TravelOption = {
    routeId: 'route:short-risky',
    travelMinutes: 120,
    perceivedRisk: 500,
  };
  const LONG_SAFE: TravelOption = {
    routeId: 'route:long-safe',
    travelMinutes: 960,
    perceivedRisk: 100,
  };
  const options = [SHORT_RISKY, LONG_SAFE];

  it('смелый идёт коротким и скверным путём', () => {
    expect(chooseRoute(options, W, BOLD)?.routeId).toBe(SHORT_RISKY.routeId);
  });

  it('осторожный идёт длинным и спокойным', () => {
    // Два агента, различающиеся ТОЛЬКО чертой характера, уходят разными дорогами. Это и есть
    // утверждение §4.5 плана; до этого теста его не проверял никто.
    expect(chooseRoute(options, W, CAUTIOUS)?.routeId).toBe(LONG_SAFE.routeId);
  });

  it('осторожность меняет и само решение уйти, а не только дорогу', () => {
    // Опасность подобрана между двумя порогами: смелому уход окупается, осторожному — нет.
    // Дорога здесь НЕИЗВЕСТНА, и это важно: так осторожность видна даже в мире, где никто ещё
    // ничего не разведал, — то есть в первый же день прототипа.
    const unknownRoad = situation({
      locationRisk: 400,
      travelOptions: [{ routeId: 'route:out', travelMinutes: 60, perceivedRisk: null }],
    });
    expect(chooseGoal(unknownRoad, W, BOLD).goal).toBe('flee');
    expect(chooseGoal(unknownRoad, W, CAUTIOUS).goal).toBe('idle');
  });

  it('там, где не разведана ни одна дорога, характер выбор дороги НЕ меняет', () => {
    /**
     * Названный предел, а не забытый случай.
     *
     * Пока все дороги безымянны, воспринимаемый риск у них общий и в сравнении сокращается:
     * остаётся длительность. Ручная демонстрация мастер-плана «осторожный выбирает обход,
     * любопытный принимает риск» поэтому требует ЗНАНИЯ хотя бы об одной дороге, и записана
     * здесь исполняемым утверждением, чтобы не обещать её раньше времени.
     */
    const blind = [
      { routeId: 'route:a', travelMinutes: 60, perceivedRisk: null },
      { routeId: 'route:b', travelMinutes: 600, perceivedRisk: null },
    ];
    expect(chooseRoute(blind, W, BOLD)?.routeId).toBe('route:a');
    expect(chooseRoute(blind, W, CAUTIOUS)?.routeId).toBe('route:a');
  });
});

describe('незнание стоит ровно столько, во сколько его оценивает ruleset', () => {
  const UNKNOWN: TravelOption = {
    routeId: 'route:unknown',
    travelMinutes: 60,
    perceivedRisk: null,
  };

  it('известная дорога спокойнее предположения — и выигрывает у неизвестной', () => {
    // Прямое отрицание «незнание — это ноль»: при нулевой цене незнания неизвестная дорога
    // была бы дешевле ЛЮБОЙ известной с ненулевым риском, и разведка никогда бы не окупалась.
    const knownCalm: TravelOption = {
      routeId: 'route:known-calm',
      travelMinutes: 60,
      perceivedRisk: W.assumedUnknownRiskPermille - 200,
    };
    expect(chooseRoute([UNKNOWN, knownCalm], W, 1000)?.routeId).toBe(knownCalm.routeId);
  });

  it('известная дорога хуже предположения — и проигрывает неизвестной', () => {
    // Обратная сторона той же величины: незнание не запрет, а цена (§4.4). При бесконечной
    // цене незнания агент предпочёл бы заведомо скверную разведанную дорогу — лишь бы знакомую.
    const knownBad: TravelOption = {
      routeId: 'route:known-bad',
      travelMinutes: 60,
      perceivedRisk: W.assumedUnknownRiskPermille + 200,
    };
    expect(chooseRoute([UNKNOWN, knownBad], W, 1000)?.routeId).toBe(UNKNOWN.routeId);
  });

  it('цена незнания растёт с осторожностью, как и цена известной опасности', () => {
    // Иначе «неизвестность выражена предполагаемым риском» было бы неправдой: предполагаемый
    // риск обязан входить в цену тем же множителем, что и разведанный, а не мимо него.
    const bold = chooseRoute([UNKNOWN], W, BOLD)?.cost ?? 0;
    const cautious = chooseRoute([UNKNOWN], W, CAUTIOUS)?.cost ?? 0;
    expect(cautious).toBeGreaterThan(bold);
  });
});

/**
 * То же самое, но ЧЕРЕЗ `decide` — и это не дублирование.
 *
 * Тесты выше зовут `chooseRoute`/`chooseGoal` напрямую и передают осторожность аргументом.
 * Независимое test-review (дополнение к отчёту, мутация A′) показало, чего они не видят: если
 * черта не доходит до расчёта — `decide.ts` подставляет нейтральную тысячу вместо
 * `agent.caution` — весь набор остаётся зелёным, включая эти самые тесты. 1043 из 1043.
 *
 * Шов, в котором черта теряется, находится У ВЫЗЫВАЮЩЕГО, а не в формуле. Значит и проверять
 * его нужно там же: мир меняется ТОЛЬКО осторожностью агента, а сравнивается порождённый факт.
 * Ровно та же конструкция, которой правильно устроен `routes.property.test.ts`.
 */
describe('осторожность доходит до решения, а не только до формулы', () => {
  const BASE = '2034-05-17T18:00:00.000Z';
  const DANGER = 'loc:danger';
  const SHORT_RISKY = 'route:short-risky';
  const LONG_SAFE = 'route:long-safe';

  /** Мир, отличающийся от соседнего ТОЛЬКО чертой характера агента. */
  const worldWithCaution = (caution: number): WorldState =>
    fixtureWorldState({
      agents: {
        'agent:rook': {
          id: 'agent:rook',
          locationId: DANGER,
          status: 'idle',
          routeId: null,
          needBaseline: { hunger: BASE, fatigue: BASE },
          goal: 'flee',
          planId: 'plan:rook-flee-1',
          caution,
          // Обе дороги РАЗВЕДАНЫ: пока обе безымянны, воспринимаемый риск у них общий и в
          // сравнении сокращается — характеру негде проявиться (см. предел выше).
          knownRoutes: {
            [SHORT_RISKY]: { risk: 500, at: BASE, sourceEventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
            [LONG_SAFE]: { risk: 100, at: BASE, sourceEventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
          },
        },
      },
      locations: {
        [DANGER]: { id: DANGER, risk: 600 },
        'loc:near': { id: 'loc:near', risk: 0 },
        'loc:far': { id: 'loc:far', risk: 0 },
      },
      routes: {
        [SHORT_RISKY]: {
          id: SHORT_RISKY,
          fromLocationId: DANGER,
          toLocationId: 'loc:near',
          travelMinutes: 120,
          risk: 500,
        },
        [LONG_SAFE]: {
          id: LONG_SAFE,
          fromLocationId: DANGER,
          toLocationId: 'loc:far',
          travelMinutes: 960,
          risk: 100,
        },
      },
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

  const routeTakenBy = (caution: number): string => {
    const result = decide(worldWithCaution(caution), travelCommand(), fixtureDecideContext());
    if (result.kind !== 'accepted') return `rejected:${result.rejection.code}`;
    const [event] = result.events;
    return event?.type === 'journey.started'
      ? event.payload.route_id
      : `other:${String(event?.type)}`;
  };

  it('смелый и осторожный уходят РАЗНЫМИ дорогами из одного и того же мира', () => {
    expect(routeTakenBy(BOLD)).toBe(SHORT_RISKY);
    expect(routeTakenBy(CAUTIOUS)).toBe(LONG_SAFE);
  });
});
