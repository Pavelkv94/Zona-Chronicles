/**
 * I05 — отдых занимает мировое время (PLAN §5).
 *
 * В I04 отдых был мгновенным, и это было названо упрощением: у мгновенного действия нет цены,
 * а без цены выбор между «поесть» и «отдохнуть» вырождается в сравнение одной величины.
 *
 * Проверяется на настоящей базе, потому что проверяется не только домен: занятость агента,
 * запланированное завершение и снятие действия живут в персистентности, и разойтись они могут
 * только там.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUNTIME_ID_PREFIXES, requireAddMinutes, requireInstant } from '@zona/contracts';
import { DerivedIdFactory, PROTOTYPE_REST_MINUTES } from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import { executeCommand } from './command-handler.ts';
import { runWorldTick } from './scheduler.ts';
import { initializeWorld, loadWorldState } from './world-repository.ts';

const ids = new DerivedIdFactory('i05-rest');

/** Момент конца отдыха, посчитанный ТЕМ ЖЕ коэффициентом, что использует мир. */
const REST_END = requireAddMinutes(
  requireInstant(
    requireAddMinutes(
      requireInstant(FIXTURE_WORLD_TIME, 'FIXTURE_WORLD_TIME'),
      120,
      'начало отдыха',
    ).iso,
    'REST_START',
  ),
  PROTOTYPE_REST_MINUTES,
  'restMinutes',
).iso;

/**
 * Отдых начинается ПОЗЖЕ старта мира, и это не декорация.
 *
 * Проба мутации показала: если начать отдых в тот же момент, что создан мир, утверждение
 * «момент отсчёта усталости не сдвинулся» неотличимо от «сдвинулся на сейчас» — обе величины
 * совпадают. Разведённые моменты делают проверку способной различать.
 */
const REST_START = requireAddMinutes(
  requireInstant(FIXTURE_WORLD_TIME, 'FIXTURE_WORLD_TIME'),
  120,
  'начало отдыха',
).iso;

const restCommand = () => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'agent.rest' as const,
  schema_version: 1,
  actor_id: FIXTURE_AGENT_ID,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: {},
});

describe('I05 — отдых занимает мировое время', () => {
  let migrated: MigratedDatabase;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i05_rest');
  });

  afterAll(async () => {
    await migrated.close();
  });

  beforeEach(async () => {
    await truncateWorldData(migrated.db);
    await initializeWorld(migrated.db, fixtureInitialization());
  });

  it('команда НАЧИНАЕТ отдых: агент занят, а усталость ещё не снята', async () => {
    const result = await executeCommand(migrated.db, restCommand(), { worldTime: REST_START });
    expect(result.outcome).toBe('accepted');

    const state = await loadWorldState(migrated.db, FIXTURE_WORLD_ID);
    const agent = state?.agents[FIXTURE_AGENT_ID];
    expect(agent?.status).toBe('resting');
    // Момент отсчёта усталости НЕ сдвинулся: агент лёг, но ещё не отдохнул. Сдвинуть его здесь
    // значило бы снять усталость авансом — за отдых, которого не было.
    expect(agent?.needBaseline.fatigue).toBe(FIXTURE_WORLD_TIME);

    const scheduled = Object.values(state?.scheduledActions ?? {});
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.kind).toBe('rest.complete');
    expect(scheduled[0]?.dueAt).toBe(REST_END);
  });

  it('до конца отдыха мир его не завершает', async () => {
    await executeCommand(migrated.db, restCommand(), { worldTime: REST_START });

    const early = requireAddMinutes(
      requireInstant(REST_END, 'REST_END'),
      -1,
      'минута до конца отдыха',
    ).iso;
    const tick = await runWorldTick(migrated.db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'test',
      horizon: early,
    });
    expect(tick.claimed).toBe(0);

    const state = await loadWorldState(migrated.db, FIXTURE_WORLD_ID);
    expect(state?.agents[FIXTURE_AGENT_ID]?.status).toBe('resting');
  });

  it('в конце отдыха агент свободен, усталость отсчитывается заново, действие снято', async () => {
    await executeCommand(migrated.db, restCommand(), { worldTime: REST_START });

    const tick = await runWorldTick(migrated.db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'test',
      horizon: REST_END,
    });
    expect(tick.claimed).toBe(1);

    const state = await loadWorldState(migrated.db, FIXTURE_WORLD_ID);
    const agent = state?.agents[FIXTURE_AGENT_ID];
    expect(agent?.status).toBe('idle');
    expect(agent?.needBaseline.fatigue).toBe(REST_END);

    // Завершение отдыха снято, но расписание НЕ пусто — и это правильно: за восемь часов агент
    // успел устать до `warning`, отдых снял усталость, и мир тут же запланировал следующее
    // пересечение от нового момента отсчёта. Проверять «ноль действий» значило бы требовать
    // мира, который перестал жить.
    const scheduled = Object.values(state?.scheduledActions ?? {});
    expect(scheduled.map((action) => action.kind)).toEqual(['need.threshold']);
    expect(scheduled[0]?.dueAt).toBe(
      requireAddMinutes(requireInstant(REST_END, 'REST_END'), 432, 'следующий порог усталости').iso,
    );
  });

  it('отдыхать во время отдыха нельзя: второе занятие, не закончив первое', async () => {
    await executeCommand(migrated.db, restCommand(), { worldTime: REST_START });
    const second = await executeCommand(migrated.db, restCommand(), { worldTime: REST_START });

    expect(second.outcome).toBe('rejected');
    if (second.outcome !== 'rejected') return;
    expect(second.rejectionCode).toBe('precondition_failed');
    expect(second.rejectionMessage).toContain('resting');
  });
});
