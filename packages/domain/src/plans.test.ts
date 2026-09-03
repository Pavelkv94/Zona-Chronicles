/**
 * Срыв плана (I05-C, `07_MVP_MECHANICS_SPEC` §6).
 *
 * Событие `plan.invalidated` заморожено с I01 и до сих пор не имело ни одного производителя.
 * Здесь проверяется ровно то, ЧТО его порождает, и — не менее важно — что его НЕ порождает.
 *
 * Главное различие среза: невыполненное предусловие даёт срыв плана, когда план есть, и обычный
 * доменный отказ, когда его нет. Мир различает эти случаи по СОСТОЯНИЮ агента, а не по тому,
 * откуда пришла команда, — происхождения команда не несёт и нести не должна.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from '@zona/contracts';
import { fixtureDecideContext, fixtureWorldState } from './__fixtures__/world.ts';
import { decide } from './decide.ts';
import { evolve } from './evolve.ts';
import { planIdFor, type AgentState, type WorldState } from './state.ts';

const AGENT = 'agent:rook';
const NOW = '2034-05-17T18:20:00.000Z';

const agent = (overrides: Partial<AgentState> = {}): AgentState => ({
  id: AGENT,
  locationId: 'loc:quiet-yard',
  status: 'idle',
  routeId: null,
  needBaseline: { hunger: '2034-05-17T18:00:00.000Z', fatigue: '2034-05-17T18:00:00.000Z' },
  goal: 'idle',
  planId: null,
  ...overrides,
});

const worldWith = (state: AgentState, rest: Partial<WorldState> = {}): WorldState =>
  fixtureWorldState({ agents: { [AGENT]: state }, items: {}, scheduledActions: {}, ...rest });

const command = (type: 'agent.eat' | 'agent.rest', payload: object): Command =>
  ({
    command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    world_id: 'world:prototype',
    type,
    schema_version: 1,
    actor_id: AGENT,
    issued_at_world_time: NOW,
    correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    payload,
  }) as Command;

const eatMissing = command('agent.eat', { item_id: 'item:gone' });

describe('невыполненное предусловие шага: срыв плана или отказ — по состоянию агента', () => {
  it('у агента с планом получается СОБЫТИЕ о срыве, а не отказ', () => {
    const planned = agent({ goal: 'eat', planId: 'plan:rook-eat-7' });
    const result = decide(worldWith(planned), eatMissing, fixtureDecideContext());

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    const [event] = result.events;
    expect(event?.type).toBe('plan.invalidated');
    if (event?.type !== 'plan.invalidated') return;
    expect(event.payload.plan_id).toBe('plan:rook-eat-7');
    expect(event.payload.precondition_type).toBe('item.available_to_actor');
  });

  it('у агента БЕЗ плана остаётся обычный доменный отказ', () => {
    // Внешнее намерение оператора плана за собой не имеет: срывать нечего, и мир обязан сказать
    // «нельзя», а не сочинить факт о несуществующем плане.
    const result = decide(worldWith(agent()), eatMissing, fixtureDecideContext());

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.rejection.code).toBe('resource_unavailable');
  });

  it('шаг «лечь отдыхать» у занятого агента с планом тоже срывается, а не отвергается', () => {
    const planned = agent({
      status: 'traveling',
      routeId: 'route:yard-to-bridge',
      goal: 'rest',
      planId: 'plan:rook-rest-3',
    });
    const result = decide(worldWith(planned), command('agent.rest', {}), fixtureDecideContext());

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.events[0]?.type).toBe('plan.invalidated');
    if (result.events[0]?.type !== 'plan.invalidated') return;
    expect(result.events[0].payload.precondition_type).toBe('agent.is_idle');
  });
});

describe('срыв плана освобождает агента и возвращает его к решению', () => {
  const invalidated = (state: AgentState): WorldState =>
    evolve(worldWith(state), {
      event_id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      world_id: 'world:prototype',
      sequence: 1,
      world_time: NOW,
      type: 'plan.invalidated',
      schema_version: 1,
      rules_version: '0.4.0',
      content_version: '0.1.0',
      actor_ids: [AGENT],
      subject_ids: [],
      location_id: 'loc:quiet-yard',
      correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      caused_by: [],
      command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      random_audit: null,
      recorded_at: '2026-01-01T00:00:00.000Z',
      payload: { plan_id: 'plan:rook-rest-3', precondition_type: 'agent.not_in_emergency' },
    });

  it('прерванный отдых заканчивается ничем: усталость не снимается', () => {
    const resting = agent({ status: 'resting', goal: 'rest', planId: 'plan:rook-rest-3' });
    const next = invalidated(resting);
    const after = next.agents[AGENT];

    expect(after?.status).toBe('idle');
    expect(after?.goal).toBe('idle');
    expect(after?.planId).toBeNull();
    // Плата за работу, которой не было, — самая тихая из возможных ошибок: агент просыпается
    // отдохнувшим, не отдохнув.
    expect(after?.needBaseline.fatigue).toBe(resting.needBaseline.fatigue);
  });

  it('освободившийся агент получает новое решение', () => {
    const next = invalidated(
      agent({ status: 'resting', goal: 'rest', planId: 'plan:rook-rest-3' }),
    );
    expect(Object.values(next.scheduledActions).map((action) => action.kind)).toEqual([
      'agent.decide',
    ]);
  });
});

describe('emergency interrupt: предел нужды срывает чужой план', () => {
  /** Момент отсчёта, при котором нужда ровно к `NOW` достигает предела (0.75 от полного роста). */
  const HUNGER_AT_LIMIT = '2034-05-17T00:20:00.000Z';
  const FATIGUE_AT_LIMIT = '2034-05-17T06:20:00.000Z';

  const crossing = (
    need: 'hunger' | 'fatigue',
    toLevel: 'warning' | 'critical' = 'critical',
  ): Command => ({
    command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    world_id: 'world:prototype',
    type: 'need.threshold.cross',
    schema_version: 1,
    actor_id: AGENT,
    issued_at_world_time: NOW,
    correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    payload: { need, to_level: toLevel },
  });

  const resting = (overrides: Partial<AgentState> = {}): AgentState =>
    agent({
      status: 'resting',
      goal: 'rest',
      planId: 'plan:rook-rest-3',
      needBaseline: { hunger: HUNGER_AT_LIMIT, fatigue: FATIGUE_AT_LIMIT },
      ...overrides,
    });

  const typesOf = (state: WorldState, need: 'hunger' | 'fatigue'): readonly string[] => {
    const result = decide(state, crossing(need), fixtureDecideContext());
    expect(result.kind).toBe('accepted');
    return result.kind === 'accepted' ? result.events.map((event) => event.type) : [];
  };

  it('голод, дошедший до предела во сне, прерывает отдых', () => {
    expect(typesOf(worldWith(resting()), 'hunger')).toEqual([
      'need.threshold.crossed',
      'plan.invalidated',
    ]);
  });

  it('усталость, дошедшая до предела во сне, отдых НЕ прерывает', () => {
    // Поднимать спящего, чтобы отправить его спать, — это не чрезвычайное происшествие, а
    // испорченный сон. Прерывает та нужда, которую план не лечит.
    expect(typesOf(worldWith(resting()), 'fatigue')).toEqual(['need.threshold.crossed']);
  });

  it('у свободного агента прерывать нечего', () => {
    const idle = resting({ status: 'idle', goal: 'idle', planId: null });
    expect(typesOf(worldWith(idle), 'hunger')).toEqual(['need.threshold.crossed']);
  });

  it('переход в "warning" планов не срывает: предел — это предел', () => {
    const state = worldWith(
      resting({ needBaseline: { hunger: '2034-05-17T07:32:00.000Z', fatigue: FATIGUE_AT_LIMIT } }),
    );
    const result = decide(state, crossing('hunger', 'warning'), fixtureDecideContext());
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.events.map((event) => event.type)).toEqual(['need.threshold.crossed']);
  });
});

describe('тождество плана', () => {
  it('различает два последовательных плана одного агента с одной целью', () => {
    // Без номера решения «сорвался дважды» было бы неотличимо от «сорвались два разных».
    expect(planIdFor(AGENT, 'eat', 7)).not.toBe(planIdFor(AGENT, 'eat', 9));
  });

  it('годится как namespaced id: строчные буквы, цифры и дефисы', () => {
    expect(planIdFor(AGENT, 'rest', 12)).toMatch(
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/,
    );
  });
});
