/**
 * I05-B — агент выбирает цель сам, и выбор становится действием (PLAN §2, §7).
 *
 * Проверяется на настоящей базе, потому что проверяется не арифметика выбора (она покрыта
 * свойствами в домене), а ЦЕПОЧКА: факт → решение → шаг → факт. Она проходит через расписание,
 * очередь и транзакцию — то есть ровно через те места, где домен и оболочка могут разойтись.
 *
 * Главное утверждение итерации выражено здесь буквально: за всё время прогона НЕТ НИ ОДНОЙ
 * команды человека. Мир двигают горизонт и собственные факты агента.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NEED_KINDS, requireAddMinutes, requireInstant, type WorldEvent } from '@zona/contracts';
import {
  PROTOTYPE_NEEDS,
  PROTOTYPE_REST_MINUTES,
  SCHEDULED_ACTION_PRIORITY,
  needThresholdActionId,
  nextThresholdCrossing,
  type ScheduledAction,
} from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_OTHER_AGENT_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import { runWorldTick } from './scheduler.ts';
import { initializeWorld, loadWorldEvents, loadWorldState } from './world-repository.ts';

/** Момент «через N минут после старта мира», посчитанный средствами продукта. */
const at = (minutes: number): string =>
  requireAddMinutes(requireInstant(FIXTURE_WORLD_TIME, 'старт мира'), minutes, 'сдвиг теста').iso;

/**
 * Пороги прототипа, пересчитанные здесь ЯВНО, чтобы сценарий читался числами, а не намёками:
 * усталость доходит до `warning` за 432 минуты (0.45 от 960), голод — за 648 (0.45 от 1440).
 */
const FATIGUE_WARNING_AT = at(432);
const HUNGER_WARNING_AT = at(648);

/** Двое суток мира: заведомо больше, чем нужно всей цепочке. */
const HORIZON = at(2880);

/**
 * Первые пересечения порогов — то, что настоящему миру ставит генезис (`world-generation.ts`).
 *
 * Фикстура персистентности собрана вручную и расписания не имеет вовсе: она заводилась под путь,
 * где всё начинается с команды человека. Здесь начинается НЕ с команды, поэтому первые пороги
 * приходится поставить самим — ТОЙ ЖЕ функцией, которой их ставит мир. Вторым способом их
 * посчитать нельзя: разойдясь, он дал бы тест, проверяющий согласие мира с арифметикой теста.
 */
const initialNeedSchedule = (agentIds: readonly string[]): Record<string, ScheduledAction> =>
  initialNeedScheduleFrom(
    Object.fromEntries(
      agentIds.map((id) => [
        id,
        { needBaseline: { hunger: FIXTURE_WORLD_TIME, fatigue: FIXTURE_WORLD_TIME } },
      ]),
    ),
  );

/** То же, но от РЕАЛЬНЫХ моментов отсчёта агентов: сценарий может начинать мир не с сытости. */
const initialNeedScheduleFrom = (
  agents: Readonly<Record<string, { readonly needBaseline: Readonly<Record<string, string>> }>>,
): Record<string, ScheduledAction> => {
  const scheduled: Record<string, ScheduledAction> = {};
  for (const [agentId, agent] of Object.entries(agents)) {
    for (const need of NEED_KINDS) {
      const baseline = agent.needBaseline[need] ?? FIXTURE_WORLD_TIME;
      const crossing = nextThresholdCrossing(baseline, 'normal', PROTOTYPE_NEEDS[need]);
      if (crossing === null) continue;
      const id = needThresholdActionId(agentId, need, crossing.at);
      scheduled[id] = {
        id,
        kind: 'need.threshold',
        dueAt: crossing.at,
        priority: SCHEDULED_ACTION_PRIORITY['need.threshold'],
        entityId: agentId,
        need,
        toLevel: crossing.level,
      };
    }
  }
  return scheduled;
};

const withFood = (owners: readonly string[]) =>
  Object.fromEntries(
    owners.map((ownerId, index) => {
      const id = `item:ration-${String(index)}`;
      return [id, { id, kind: 'food' as const, ownerId }];
    }),
  );

/**
 * Крутит мир, пока ему есть что делать, и возвращает число тактов.
 *
 * Потолок — страховка от зацикливания, а НЕ часть утверждения: выход по нему проваливает тест.
 * Так проверяется §4.3 плана — «доля бесконечных replans = 0»: мир, который перепланирует без
 * конца, до тишины не доходит вовсе.
 */
const runUntilQuiet = async (
  migrated: MigratedDatabase,
  horizon: string = HORIZON,
  maxTicks = 200,
): Promise<number> => {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const result = await runWorldTick(migrated.db, {
      worldId: FIXTURE_WORLD_ID,
      owner: `t-${String(tick)}`,
      horizon,
    });
    if (result.claimed === 0) return tick;
  }
  throw new Error('мир не пришёл в тишину: похоже на бесконечное перепланирование');
};

const typesOf = (events: readonly WorldEvent[], actorId: string): readonly string[] =>
  events.filter((event) => event.actor_ids.includes(actorId)).map((event) => event.type);

describe('I05-B — выбор цели без единой команды человека', () => {
  let migrated: MigratedDatabase;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i05_goals');
  });

  afterAll(async () => {
    await migrated.close();
  });

  beforeEach(async () => {
    await truncateWorldData(migrated.db);
  });

  it('уставший ложится отдыхать сам, а проснувшись — ест', async () => {
    const init = fixtureInitialization();
    await initializeWorld(migrated.db, {
      ...init,
      state: {
        ...init.state,
        items: withFood([FIXTURE_AGENT_ID, FIXTURE_OTHER_AGENT_ID]),
        scheduledActions: initialNeedSchedule([FIXTURE_AGENT_ID, FIXTURE_OTHER_AGENT_ID]),
      },
    });

    await runUntilQuiet(migrated);

    const events = await loadWorldEvents(migrated.db, FIXTURE_WORLD_ID);
    const mine = events.filter((event) => event.actor_ids.includes(FIXTURE_AGENT_ID));

    // История читается подряд, а не по составу: устал → решил → лёг → (пока спал, проголодался
    // и вымотался) → встал → отдохнул от усталости → решил → поел. Ни одной команды человека в
    // прогоне не было вовсе.
    expect(
      mine.slice(0, 9).map((event) => `${event.world_time.slice(11, 16)} ${event.type}`),
    ).toEqual([
      '13:12 need.threshold.crossed',
      '13:12 goal.chosen',
      '13:12 rest.started',
      '16:48 need.threshold.crossed',
      '18:00 need.threshold.crossed',
      '21:12 agent.rested',
      '21:12 need.threshold.crossed',
      '21:12 goal.chosen',
      '21:12 agent.ate',
    ]);

    // Решение и его шаг происходят в ОДИН момент мира, а не «когда дойдут руки». Утверждение
    // отдельное: до перехода такта на волны по моментам мир решал поесть в 16:48, а ел в 00:00
    // следующих суток — и обе строки по отдельности выглядели правдоподобно.
    const chosen = mine.filter((event) => event.type === 'goal.chosen');
    expect(chosen[0]?.world_time).toBe(FATIGUE_WARNING_AT);
    expect(mine.find((event) => event.type === 'rest.started')?.world_time).toBe(
      FATIGUE_WARNING_AT,
    );
    // Голод перешёл порог, пока агент спал, — и решения ему это не принесло: занятый доводит
    // начатое до конца.
    expect(
      mine.find(
        (event) =>
          event.type === 'need.threshold.crossed' && event.world_time === HUNGER_WARNING_AT,
      ),
    ).toBeDefined();
  });

  it('решение объяснимо: разбор называет все цели и их слагаемые', async () => {
    const init = fixtureInitialization();
    await initializeWorld(migrated.db, {
      ...init,
      state: {
        ...init.state,
        items: withFood([FIXTURE_AGENT_ID]),
        scheduledActions: initialNeedSchedule([FIXTURE_AGENT_ID, FIXTURE_OTHER_AGENT_ID]),
      },
    });
    await runUntilQuiet(migrated);

    const events = await loadWorldEvents(migrated.db, FIXTURE_WORLD_ID);
    const chosen = events.find(
      (event) => event.type === 'goal.chosen' && event.actor_ids.includes(FIXTURE_AGENT_ID),
    );
    expect(chosen?.type).toBe('goal.chosen');
    if (chosen?.type !== 'goal.chosen') return;

    expect(chosen.payload.goal).toBe('rest');
    expect(chosen.payload.previous_goal).toBe('idle');
    // Разбор объясняет и ОТВЕРГНУТОЕ: без строки про еду нельзя отличить «еды не было» от «еда
    // была, но отдых оказался важнее».
    // Четвёртая строка — «уйти» (I06-C). Она в разборе есть всегда, даже когда уходить незачем:
    // объяснение обязано называть и отвергнутое.
    expect(chosen.payload.trace.candidates.map((line) => line.goal)).toEqual([
      'idle',
      'eat',
      'rest',
      'flee',
    ]);
    const eat = chosen.payload.trace.candidates.find((line) => line.goal === 'eat');
    expect(eat?.feasible).toBe(true);
    expect(eat?.urgency).toBe(0);
  });

  it('разбор безедового агента отличает «нечем» от «не захотелось»', async () => {
    const init = fixtureInitialization();
    await initializeWorld(migrated.db, {
      ...init,
      state: {
        ...init.state,
        items: withFood([FIXTURE_AGENT_ID]),
        scheduledActions: initialNeedSchedule([FIXTURE_AGENT_ID, FIXTURE_OTHER_AGENT_ID]),
      },
    });
    await runUntilQuiet(migrated);

    const events = await loadWorldEvents(migrated.db, FIXTURE_WORLD_ID);
    const hungryDecision = events.find((event) => {
      if (event.type !== 'goal.chosen') return false;
      if (!event.actor_ids.includes(FIXTURE_OTHER_AGENT_ID)) return false;
      const eat = event.payload.trace.candidates.find((line) => line.goal === 'eat');
      return (eat?.urgency ?? 0) > 0;
    });
    expect(hungryDecision?.type).toBe('goal.chosen');
    if (hungryDecision?.type !== 'goal.chosen') return;

    const eat = hungryDecision.payload.trace.candidates.find((line) => line.goal === 'eat');
    // Срочность высокая, а цель не выбрана — и разбор говорит почему: шага нет. Это и есть
    // различие между «цель без адресата» и «цель, проигравшая по оценке».
    expect(eat?.feasible).toBe(false);
    expect(eat?.score).toBeGreaterThan(0);
    expect(hungryDecision.payload.goal).not.toBe('eat');
  });

  it('число решений не превышает числа фактов, которые агента касаются', async () => {
    const init = fixtureInitialization();
    await initializeWorld(migrated.db, {
      ...init,
      state: {
        ...init.state,
        items: withFood([FIXTURE_AGENT_ID, FIXTURE_OTHER_AGENT_ID]),
        scheduledActions: initialNeedSchedule([FIXTURE_AGENT_ID, FIXTURE_OTHER_AGENT_ID]),
      },
    });
    await runUntilQuiet(migrated);

    const events = await loadWorldEvents(migrated.db, FIXTURE_WORLD_ID);
    for (const agentId of [FIXTURE_AGENT_ID, FIXTURE_OTHER_AGENT_ID]) {
      const mine = typesOf(events, agentId);
      const decisions = mine.filter((type) => type === 'goal.chosen').length;
      const facts = mine.length - decisions;
      // Строгое «меньше либо равно», а не «конечно»: конечность уже доказана тем, что прогон
      // дошёл до тишины. Здесь проверяется, что решения не размножаются от собственных
      // результатов — иначе `goal.chosen` порождал бы новое решение и мир крутился бы, не
      // производя ничего.
      expect(decisions).toBeLessThanOrEqual(facts);
      expect(decisions).toBeGreaterThan(0);
    }
  });

  it('голод, дошедший до предела во сне, будит агента — и он ест, а не спит дальше', async () => {
    /**
     * Момент отсчёта голода сдвинут В ПРОШЛОЕ на 200 минут, и это не подкрутка результата.
     *
     * На коэффициентах прототипа усталость доходит до порога раньше голода, поэтому агент,
     * начинающий сытым, успевает поесть до того, как ляжет. Чтобы проверить emergency interrupt,
     * нужен агент, который лёг спать УЖЕ проголодавшимся — то есть история, начавшаяся не с
     * сытости. Сдвиг момента отсчёта — единственный способ её задать: значение нужды в этом мире
     * не хранится вовсе, оно вычисляется из момента.
     *
     * Числа: отдых идёт с 432-й по 912-ю минуту, предел голода наступает на 880-й — внутри сна.
     */
    const hungryBaseline = requireAddMinutes(
      requireInstant(FIXTURE_WORLD_TIME, 'старт мира'),
      -200,
      'сдвиг голода в прошлое',
    ).iso;
    const init = fixtureInitialization();
    const agents = Object.fromEntries(
      Object.entries(init.state.agents).map(([id, agent]) => [
        id,
        { ...agent, needBaseline: { ...agent.needBaseline, hunger: hungryBaseline } },
      ]),
    );
    await initializeWorld(migrated.db, {
      ...init,
      state: {
        ...init.state,
        agents,
        items: withFood([FIXTURE_AGENT_ID]),
        scheduledActions: initialNeedScheduleFrom(agents),
      },
    });

    /**
     * Мир останавливается РОВНО на моменте прерывания, а потом идёт дальше.
     *
     * Двухфазный прогон нужен ради одного утверждения: расписание сразу после срыва. Прогон «до
     * конца» его увидеть не может, и первая редакция теста этого не увидела — мутация «срыв не
     * снимает ждущие шаги» прошла её дважды подряд, в том числе через проверку по журналу.
     * Уцелевшее завершение отдыха срабатывает позже и закрывает СЛЕДУЮЩИЙ отдых, а по журналу
     * это читается как исправная пара «лёг — отдохнул»: причинность у неё настоящая, украден
     * только сон.
     */
    await runUntilQuiet(migrated, at(880));
    const atInterrupt = await loadWorldState(migrated.db, FIXTURE_WORLD_ID);
    const pending = Object.values(atInterrupt?.scheduledActions ?? {}).filter(
      (action) => action.entityId === FIXTURE_AGENT_ID && action.kind === 'rest.complete',
    );
    // Ровно одно завершение — от НОВОГО отдыха, начатого после еды. Прерванный сон своего
    // завершения за собой не оставил.
    expect(pending.map((action) => action.dueAt)).toEqual([at(880 + PROTOTYPE_REST_MINUTES)]);

    await runUntilQuiet(migrated);

    const events = await loadWorldEvents(migrated.db, FIXTURE_WORLD_ID);
    const mine = events
      .filter((event) => event.actor_ids.includes(FIXTURE_AGENT_ID))
      .map((event) => `${event.world_time.slice(11, 16)} ${event.type}`);

    // Сон прерван пределом голода, и прерван ИМЕННО им: следом идёт решение и еда, а не
    // продолжение отдыха. `agent.rested` в этой цепочке нет вовсе — отдых не состоялся.
    const start = mine.indexOf('13:12 rest.started');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(mine.slice(start, start + 7)).toEqual([
      '13:12 rest.started',
      // Во сне голод переходит в «голоден», а усталость — в «вымотан». Ни то, ни другое сна не
      // прерывает: первое ещё не предел, второе лечится тем самым сном.
      '13:28 need.threshold.crossed',
      '18:00 need.threshold.crossed',
      // А это предел голода — и он будит.
      '20:40 need.threshold.crossed',
      '20:40 plan.invalidated',
      '20:40 goal.chosen',
      '20:40 agent.ate',
    ]);

    // Прерванный отдых закончился НИЧЕМ: события «отдохнул» в этот момент нет, а значит нет и
    // снятия усталости. Платить за работу, которой не было, — самая тихая из возможных ошибок:
    // агент просыпался бы отдохнувшим, не отдохнув. (Точное утверждение о моменте отсчёта —
    // в `plans.test.ts`, где состояние видно целиком.)
    expect(mine.filter((line) => line === '20:40 agent.rested')).toEqual([]);

    /**
     * Ни одно запланированное действие не закончилось отказом.
     *
     * Это утверждение о том, что срыв плана СНЯЛ ждущее завершение отдыха, а не просто поднял
     * агента. Первая редакция теста этого не проверяла, и мутация «не снимать ждущие шаги»
     * прошла её целиком: видимая цепочка событий от неё не меняется. Последствие при этом
     * тяжёлое — уцелевшее завершение срабатывает позже и закрывает СЛЕДУЮЩИЙ отдых, отдавая
     * агенту полное восстановление за полчаса сна.
     *
     * Отказ здесь и есть след такого хвоста: устаревшее завершение отвергается доменом.
     */
    const failed = await migrated.db
      .selectFrom('scheduled_actions')
      .select(['kind', 'failure_code'])
      .where('failed_at', 'is not', null)
      .execute();
    expect(failed).toEqual([]);

    /**
     * И ни один отдых не закончился раньше своего срока: полное восстановление стоит ровно
     * столько мировых минут, сколько объявлено в ruleset.
     */
    const rests = events.filter(
      (event) => event.actor_ids.includes(FIXTURE_AGENT_ID) && event.type === 'rest.started',
    );
    for (const started of rests) {
      // Пара ищется ПО ПРИЧИНЕ, а не по «первому следующему»: прерванный отдых конца не имеет
      // вовсе, и поиск по времени приписал бы ему конец СЛЕДУЮЩЕГО — то есть тест сам сочинил бы
      // ту связь, наличие которой проверяет.
      const ended = events.find(
        (event) => event.type === 'agent.rested' && event.caused_by.includes(started.event_id),
      );
      if (ended === undefined) continue;
      if (started.type !== 'rest.started') continue;
      expect(ended.world_time).toBe(started.payload.expected_end);
    }
  });

  it('голод не наступает у мира: он наступает у агента, и запас у каждого свой', async () => {
    // Еда только у одного. Второй агент доходит до предела голода и остаётся с ним: цель
    // «поесть» для него не кандидат, а не низко оценённый кандидат.
    const init = fixtureInitialization();
    await initializeWorld(migrated.db, {
      ...init,
      state: {
        ...init.state,
        items: withFood([FIXTURE_AGENT_ID]),
        scheduledActions: initialNeedSchedule([FIXTURE_AGENT_ID, FIXTURE_OTHER_AGENT_ID]),
      },
    });
    await runUntilQuiet(migrated);

    const events = await loadWorldEvents(migrated.db, FIXTURE_WORLD_ID);
    expect(typesOf(events, FIXTURE_AGENT_ID)).toContain('agent.ate');
    expect(typesOf(events, FIXTURE_OTHER_AGENT_ID)).not.toContain('agent.ate');

    const state = await loadWorldState(migrated.db, FIXTURE_WORLD_ID);
    // Мир пришёл в тишину, и ни один агент не остался с непотреблённой целью: цель, которую
    // некому исполнить, — это застрявший агент.
    for (const agent of Object.values(state?.agents ?? {})) {
      expect(agent.goal).toBe('idle');
    }
    expect(HUNGER_WARNING_AT > FATIGUE_WARNING_AT).toBe(true);
  });
});
