/**
 * C12 и C4 — свойства, а не сценарии (blocker и два major независимой проверки тестов I02B).
 *
 * `ACCEPTANCE.md` для C12 прямо говорит: «проверяется property-тестом на случайных
 * последовательностях, а не одним сценарием». Фактически были два примера. Расхождение не в
 * силе покрытия, а в том, что документ утверждал метод доказательства, которого не
 * существовало, — поэтому проверка написана, а не критерий смягчён.
 *
 * Для C4 та же проверка закрывает обе названные дыры: «тот же порядок при разных размерах
 * batch» не проверялся вообще, а сам порядок держался на двух агентах, где мутация «убрать
 * `entity_id` из `order by`» с большой вероятностью не покраснела бы — PostgreSQL вернул бы две
 * строки в физическом порядке, совпадающем с алфавитным.
 *
 * Здесь агенты ВСТАВЛЯЮТСЯ в порядке, обратном ожидаемому: без сортировки физический порядок
 * даст обратный результат, и тест упадёт.
 *
 * ## Что этот тест ловит и что НЕ ловит — проверено пробами, а не заявлено
 *
 * Порядок обеспечивают ТРИ слоя: индекс `scheduled_actions_due_idx`, `order by` в SQL и
 * пересортировка результата в JS (`returning` порядка не гарантирует). Они избыточны, и
 * измерено, что избыточность реальна:
 *
 * | Мутация | Результат |
 * | --- | --- |
 * | убрать `entity_id` из `order by` | тест ПРОХОДИТ — план всё равно идёт по индексу |
 * | убрать JS-сортировку | тест ПРОХОДИТ — порядок уже задан SQL |
 * | убрать и то, и другое, И `entity_id` из индекса | тест ПАДАЕТ: состав батча `z99,z98` вместо `z96,z97` |
 *
 * То есть тест доказывает СВОЙСТВО («порядок канонический»), но не позволяет обнаружить утрату
 * ОДНОГО из трёх слоёв. Это свойство реализации, а не слабость теста, и написать здесь
 * «обнаруживает удаление entity_id из ORDER BY» было бы неправдой.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { RUNTIME_ID_PREFIXES, compareByCodePoint, type Command } from '@zona/contracts';
import { DerivedIdFactory, testRulesetVersions, type WorldState } from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import type { DatabaseConnection } from './database.ts';
import { executeCommand } from './command-handler.ts';
import { claimDueActions, runWorldTick } from './scheduler.ts';
import { initializeWorld, loadWorldEvents, loadWorldState } from './world-repository.ts';

const WORLD = 'world:fixture';
const T0 = '2028-04-26T06:00:00.000Z';
const HORIZON = '2028-04-26T12:00:00.000Z';
/** Момент прибытия при travelMinutes = 15 от T0: он же срок действий по нуждам в смешанном тесте. */
const ARRIVAL = '2028-04-26T06:15:00.000Z';
const ids = new DerivedIdFactory('i02b-ordering');

/** Имена намеренно таковы, что алфавитный порядок ОБРАТЕН порядку вставки. */
const agentId = (index: number): string => `agent:z${String(99 - index).padStart(2, '0')}`;

const buildState = (travelMinutes: readonly number[]): WorldState => {
  const agents: WorldState['agents'] = {};
  const routes: WorldState['routes'] = {};
  const mutableAgents = agents as Record<string, WorldState['agents'][string]>;
  const mutableRoutes = routes as Record<string, WorldState['routes'][string]>;
  travelMinutes.forEach((minutes, index) => {
    const id = agentId(index);
    mutableAgents[id] = {
      id,
      locationId: 'loc:a',
      status: 'idle',
      routeId: null,
      needBaseline: { hunger: T0, fatigue: T0 },
      goal: 'idle',
      planId: null,
      caution: 1000,
      knownRoutes: {},
    };
    mutableRoutes[`route:${String(index)}`] = {
      id: `route:${String(index)}`,
      fromLocationId: 'loc:a',
      toLocationId: 'loc:b',
      travelMinutes: minutes,
      risk: 0,
    };
  });
  return {
    worldId: WORLD,
    worldVersion: 0,
    worldTime: T0,
    sequence: 0,
    agents,
    locations: {
      'loc:a': { id: 'loc:a', risk: 0 },
      'loc:b': { id: 'loc:b', risk: 0 },
    },
    routes,
    items: {},
    scheduledActions: {},
  };
};

const start = (index: number, version: number): Command => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: WORLD,
  type: 'journey.start',
  schema_version: 1,
  actor_id: agentId(index),
  issued_at_world_time: T0,
  expected_world_version: version,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: `route:${String(index)}` },
});

interface RunOutcome {
  readonly worldTimes: readonly string[];
  readonly completionOrder: readonly string[];
}

const runScenario = async (
  db: DatabaseConnection,
  travelMinutes: readonly number[],
  batchSize: number,
): Promise<RunOutcome> => {
  await truncateWorldData(db);
  await initializeWorld(db, {
    seed: 1,
    state: buildState(travelMinutes),
    versions: testRulesetVersions(),
    // Мир собран вручную, розыгрышей не было: позиции пусты ЯВНО (поле обязательное, см. B1).
    prngStreamPositions: {},
    content: {
      locations: [
        { id: 'loc:a', name: 'A', description: 'A' },
        { id: 'loc:b', name: 'B', description: 'B' },
      ],
      agentNames: Object.fromEntries(travelMinutes.map((_, i) => [agentId(i), `Z${String(i)}`])),
    },
  });

  for (const [index] of travelMinutes.entries()) {
    const result = await executeCommand(db, start(index, index));
    expect(result.outcome).toBe('accepted');
  }

  /**
   * Мир крутится, ПОКА ему есть что делать, а не заранее отмеренное число раундов.
   *
   * Прежняя редакция отводила `агентов + 2` раунда, и этого хватало ровно пока на один путь
   * приходилось одно действие. С I05-B прибытие порождает ещё и решение, и при `batchSize` 1
   * счётчик обрывал прогон на середине — а тест сравнивал ПОРЯДОК завершений, поэтому обрыв
   * читался как «порядок разошёлся», то есть указывал не туда, где причина.
   *
   * Потолок остаётся, но он страховка от зацикливания, а не часть утверждения: выход по нему
   * — это провал теста, а не тихо укороченный прогон.
   */
  const worldTimes: string[] = [];
  const maxRounds = travelMinutes.length * 8 + 8;
  let idle = false;
  for (let round = 0; round < maxRounds; round += 1) {
    const tick = await runWorldTick(db, {
      worldId: WORLD,
      owner: `w-${String(round)}`,
      horizon: HORIZON,
      batchSize,
    });
    worldTimes.push(tick.worldTime);
    if (tick.claimed === 0) {
      idle = true;
      break;
    }
  }
  expect(idle).toBe(true);

  const events = await loadWorldEvents(db, WORLD);
  return {
    worldTimes,
    completionOrder: events
      .filter((event) => event.type === 'journey.completed')
      .map((event) => event.actor_ids[0]!),
  };
};

describe('C12/C4 — монотонность времени и стабильный порядок как свойства', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('scheduler_ordering');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('C12: мировое время не убывает ни на одной случайной последовательности', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Длительности с повторами: одинаковые due_at обязаны встречаться, иначе свойство
        // «порядок разрешается следующим ключом» не проверяется вовсе.
        fc.array(fc.integer({ min: 5, max: 40 }), { minLength: 2, maxLength: 6 }),
        fc.integer({ min: 1, max: 4 }),
        async (travelMinutes, batchSize) => {
          const { worldTimes } = await runScenario(db, travelMinutes, batchSize);
          for (let i = 1; i < worldTimes.length; i += 1) {
            expect(compareByCodePoint(worldTimes[i]!, worldTimes[i - 1]!)).toBeGreaterThanOrEqual(
              0,
            );
          }
          const state = await loadWorldState(db, WORLD);
          // Время не обгоняет горизонт и не уходит за последний обработанный due_at.
          expect(compareByCodePoint(state!.worldTime, HORIZON)).toBeLessThanOrEqual(0);
        },
      ),
      { numRuns: 12 },
    );
  }, 300_000);

  it('C4: порядок завершений одинаков при РАЗНЫХ размерах batch', async () => {
    // Прямой ответ на «тот же порядок при разных batch» — часть критерия, не покрытая ничем.
    const travelMinutes = [20, 10, 20, 10, 30];
    const withBatchOne = await runScenario(db, travelMinutes, 1);
    const withBatchAll = await runScenario(db, travelMinutes, 32);
    expect(withBatchAll.completionOrder).toEqual(withBatchOne.completionOrder);
  }, 300_000);

  it('C4: СОСТАВ батча при равном due_at задан entity_id, а не физическим порядком строк', async () => {
    // Разделение наблюдений, без которого тест ничего не различает.
    //
    // Порядок обеспечивают ДВА слоя: `order by` в SQL и пересортировка результата в JS (потому
    // что `returning` порядка не гарантирует). Проба показала, что они маскируют друг друга:
    // снятие любого одного не роняет проверку итогового порядка обработки. Значит, наблюдать
    // надо РАЗНЫЕ следствия.
    //
    // Здесь наблюдается СОСТАВ батча под `limit`: он зависит только от SQL-порядка. Агенты
    // вставлены как z99, z98, z97, z96 — то есть физический порядок ОБРАТЕН алфавитному.
    // Без `order by entity_id` в батч попали бы два первых по вставке (z99, z98), а обязаны
    // попасть два первых по алфавиту (z96, z97).
    await truncateWorldData(db);
    await initializeWorld(db, {
      seed: 1,
      state: buildState([15, 15, 15, 15]),
      versions: testRulesetVersions(),
      // Мир собран вручную, розыгрышей не было: позиции пусты ЯВНО (поле обязательное, см. B1).
      prngStreamPositions: {},
      content: {
        locations: [
          { id: 'loc:a', name: 'A', description: 'A' },
          { id: 'loc:b', name: 'B', description: 'B' },
        ],
        agentNames: Object.fromEntries([0, 1, 2, 3].map((i) => [agentId(i), `Z${String(i)}`])),
      },
    });
    for (const index of [0, 1, 2, 3]) {
      await executeCommand(db, start(index, index));
    }

    const claimed = await claimDueActions(db, {
      worldId: WORLD,
      worldTime: HORIZON,
      owner: 'batch-composition',
      leaseMs: 60_000,
      batchSize: 2,
    });
    expect(claimed.map((a) => a.entityId)).toEqual([agentId(3), agentId(2)]);
  }, 300_000);

  it('I04: размер батча не меняет порядок и когда в расписании РАЗНЫЕ виды действий', async () => {
    // Существующие проверки C4 гоняют одно семейство действий, поэтому «порядок задан ключом»
    // они доказывают только для него. Нужды добавили второй вид с другим приоритетом — и
    // приоритет входит в ключ захвата ВТОРЫМ полем, сразу после срока. Проверяется, что
    // смешанное расписание разбирается тем же ключом и не зависит от того, сколько строк взято
    // за раз.
    await truncateWorldData(db);
    await initializeWorld(db, {
      seed: 1,
      state: buildState([15, 15, 15, 15]),
      versions: testRulesetVersions(),
      prngStreamPositions: {},
      content: {
        locations: [
          { id: 'loc:a', name: 'A', description: 'A' },
          { id: 'loc:b', name: 'B', description: 'B' },
        ],
        agentNames: Object.fromEntries([0, 1, 2, 3].map((i) => [agentId(i), `Z${String(i)}`])),
      },
    });
    for (const index of [0, 1, 2, 3]) {
      await executeCommand(db, start(index, index));
    }

    // Действия по нуждам с ТЕМ ЖЕ сроком, что и прибытия: только так проверяется, что их
    // разводит приоритет, а не удача.
    for (const index of [0, 1, 2, 3]) {
      await db
        .insertInto('scheduled_actions')
        .values({
          world_id: WORLD,
          action_id: `sched:need:${agentId(index)}:hunger:${ARRIVAL}`,
          kind: 'need.threshold',
          due_at: ARRIVAL,
          priority: 200,
          entity_id: agentId(index),
          route_id: null,
          need: 'hunger',
          to_level: 'warning',
          item_id: null,
          lease_owner: null,
          lease_until: null,
          completed_at: null,
        })
        .execute();
    }

    const claimAll = async (batchSize: number, owner: string): Promise<readonly string[]> => {
      const order: string[] = [];
      for (let step = 0; step < 20; step += 1) {
        const claimed = await claimDueActions(db, {
          worldId: WORLD,
          worldTime: HORIZON,
          owner,
          // Аренда ДЕРЖИТСЯ: захваченная строка не должна вернуться в следующий вызов, иначе
          // цикл с `batchSize: 1` восемь раз захватит одну и ту же первую строку. Так и вышло
          // при первой редакции теста — нулевая аренда дала «порядок» из восьми одинаковых id.
          leaseMs: 60_000,
          batchSize,
        });
        if (claimed.length === 0) break;
        order.push(...claimed.map((action) => action.actionId));
        if (order.length >= 8) break;
      }
      return order;
    };

    /** Снимает аренды между проходами: второй проход обязан видеть то же, что первый. */
    const releaseLeases = async (): Promise<void> => {
      await db
        .updateTable('scheduled_actions')
        .set({ lease_owner: null, lease_until: null })
        .where('world_id', '=', WORLD)
        .execute();
    };

    const byOne = await claimAll(1, 'mixed-one');
    await releaseLeases();
    const byAll = await claimAll(32, 'mixed-all');
    expect(byOne).toHaveLength(8);
    expect(byAll).toEqual(byOne);
    // Прибытия идут раньше пересечений при равном сроке: приоритет 100 против 200.
    expect(byOne.slice(0, 4).every((id) => !id.startsWith('sched:need:'))).toBe(true);
  }, 300_000);

  it('C4: ВОЗВРАЩАЕМЫЙ порядок отсортирован ключом, а не порядком returning', async () => {
    // Второе следствие того же требования, наблюдаемое отдельно: даже когда батч забирает всё,
    // порядок в результате обязан быть каноническим. Это слой JS-сортировки.
    const claimed = await claimDueActions(db, {
      worldId: WORLD,
      worldTime: HORIZON,
      owner: 'returned-order',
      leaseMs: 60_000,
      batchSize: 32,
    });
    const keys = claimed.map((a) => `${a.dueAt}|${String(a.priority)}|${a.entityId}|${a.actionId}`);
    expect(keys).toEqual([...keys].sort(compareByCodePoint));
  }, 300_000);

  it('C4: при равном due_at порядок обработки задан entity_id', async () => {
    // Агенты вставлены в порядке, ОБРАТНОМ алфавитному (`agent:z99`, `agent:z98`, …). Если
    // сортировка по `entity_id` исчезнет, вернётся порядок вставки — то есть обратный.
    const { completionOrder } = await runScenario(db, [15, 15, 15, 15], 32);
    expect(completionOrder).toEqual([...completionOrder].sort(compareByCodePoint));
    expect(completionOrder).toHaveLength(4);
  }, 300_000);
});
