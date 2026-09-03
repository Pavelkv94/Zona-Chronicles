/**
 * I06-B — субъективная карта риска: знание с provenance (PLAN §4.3, §7; SIM-05).
 *
 * Проверяется на настоящей базе, потому что проверяется не форма записи, а три её свойства,
 * которые живут в разных слоях: знание появляется ФАКТОМ, оно принадлежит агенту, а не миру, и
 * оно восстанавливается пересимуляцией журнала.
 *
 * Восстановление пересимуляцией проверяется там, где уже стоит вся оснастка для replay, —
 * в `replay.integration.test.ts`. Заводить её здесь во второй раз значило бы получить два
 * набора снимков и bundle-ов, которые однажды разойдутся.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUNTIME_ID_PREFIXES, type Command } from '@zona/contracts';
import { DerivedIdFactory } from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_BACK_ROUTE_ID,
  FIXTURE_OTHER_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import { executeCommand } from './command-handler.ts';
import { runWorldTick } from './scheduler.ts';
import { initializeWorld, loadWorldEvents, loadWorldState } from './world-repository.ts';

const ids = new DerivedIdFactory('i06-knowledge');
const ARRIVAL = '2028-04-26T06:40:00.000Z';

const startJourney = (agentId: string, expectedVersion: number): Command => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: agentId,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: expectedVersion,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
});

describe('I06-B — знание о дорогах появляется фактом и принадлежит агенту', () => {
  let migrated: MigratedDatabase;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i06_knowledge');
  });

  afterAll(async () => {
    await migrated.close();
  });

  beforeEach(async () => {
    await truncateWorldData(migrated.db);
    await initializeWorld(migrated.db, fixtureInitialization());
  });

  it('свежий мир не знает о дорогах ничего', () => {
    // Пустая карта — не умолчание, а утверждение: дорог никто пока не видел. Если бы генезис
    // заполнял её каноном, вся итерация проверяла бы мир, в котором все всё знают.
    return loadWorldState(migrated.db, FIXTURE_WORLD_ID).then((state) => {
      for (const agent of Object.values(state?.agents ?? {})) {
        expect(agent.knownRoutes).toEqual({});
      }
    });
  });

  it('прошедший дорогу узнаёт её, а оставшийся дома — нет', async () => {
    expect((await executeCommand(migrated.db, startJourney(FIXTURE_AGENT_ID, 0))).outcome).toBe(
      'accepted',
    );
    await runWorldTick(migrated.db, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'test',
      horizon: ARRIVAL,
    });

    const state = await loadWorldState(migrated.db, FIXTURE_WORLD_ID);
    const traveller = state?.agents[FIXTURE_AGENT_ID];
    const stayed = state?.agents[FIXTURE_OTHER_AGENT_ID];

    // Главное утверждение слоя: знание СУБЪЕКТИВНО. Оно принадлежит тому, кто его получил, а не
    // миру — иначе «неполное знание меняет решение» проверять было бы не на чем.
    expect(Object.keys(traveller?.knownRoutes ?? {})).toEqual([FIXTURE_ROUTE_ID]);
    expect(stayed?.knownRoutes).toEqual({});

    // Provenance: у записи есть момент и событие-источник, и событие это в журнале есть.
    const known = traveller?.knownRoutes[FIXTURE_ROUTE_ID];
    expect(known?.at).toBe(ARRIVAL);
    const events = await loadWorldEvents(migrated.db, FIXTURE_WORLD_ID);
    const source = events.find((event) => event.event_id === known?.sourceEventId);
    expect(source?.type).toBe('risk.observed');
    expect(source?.actor_ids).toEqual([FIXTURE_AGENT_ID]);
  });

  it('узнанное совпадает с тем, что записано в мире: пройденную дорогу видно как есть', async () => {
    await executeCommand(migrated.db, startJourney(FIXTURE_AGENT_ID, 0));
    await runWorldTick(migrated.db, { worldId: FIXTURE_WORLD_ID, owner: 'test', horizon: ARRIVAL });

    const state = await loadWorldState(migrated.db, FIXTURE_WORLD_ID);
    // Совпадение здесь ожидаемо и проверяется: искажение бывает у пересказа (§12), а пройденная
    // своими ногами дорога — это то, что человек видел сам.
    expect(state?.agents[FIXTURE_AGENT_ID]?.knownRoutes[FIXTURE_ROUTE_ID]?.risk).toBe(
      state?.routes[FIXTURE_ROUTE_ID]?.risk,
    );
  });

  it('дорога не узнаётся дважды, а НОВАЯ дорога узнаётся', async () => {
    /**
     * Обе половины утверждения обязательны, и вторая — та, ради которой первая не превращается
     * в «мир вообще перестал узнавать». Первая редакция теста подавала ту же команду второй раз
     * и получала идемпотентный повтор: мутация «узнавать заново на каждом проходе» прошла её
     * целиком, потому что второго прохода в тесте не было вовсе.
     */
    const travel = async (routeId: string, at: string): Promise<void> => {
      const command: Command = {
        command_id: ids.next(RUNTIME_ID_PREFIXES.command),
        world_id: FIXTURE_WORLD_ID,
        type: 'journey.start',
        schema_version: 1,
        actor_id: FIXTURE_AGENT_ID,
        issued_at_world_time: FIXTURE_WORLD_TIME,
        correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
        payload: { route_id: routeId },
      };
      const result = await executeCommand(migrated.db, command);
      expect(result.outcome, JSON.stringify(result)).toBe('accepted');
      // Такт обрабатывает ОДИН момент мира, поэтому доводить до горизонта надо циклом — ровно
      // так же, как это делают `world tick` и шаг worker-а.
      for (let tick = 0; tick < 20; tick += 1) {
        const step = await runWorldTick(migrated.db, {
          worldId: FIXTURE_WORLD_ID,
          owner: `test-${String(tick)}`,
          horizon: at,
        });
        if (step.claimed === 0) return;
      }
      throw new Error(`мир не дошёл до ${at} за двадцать тактов`);
    };

    await travel(FIXTURE_ROUTE_ID, ARRIVAL);
    await travel(FIXTURE_BACK_ROUTE_ID, '2028-04-26T07:20:00.000Z');
    await travel(FIXTURE_ROUTE_ID, '2028-04-26T08:00:00.000Z');

    const events = await loadWorldEvents(migrated.db, FIXTURE_WORLD_ID);
    const observed = events.filter((event) => event.type === 'risk.observed');
    // Две разные дороги — два факта. Третий проход был по уже известной дороге и факта не дал:
    // узнавать нечего, а лента, повторяющая «узнал то же самое», перестала бы быть перечнем
    // произошедшего.
    expect(
      observed.map((event) => (event.type === 'risk.observed' ? event.payload.route_id : '')),
    ).toEqual([FIXTURE_ROUTE_ID, FIXTURE_BACK_ROUTE_ID]);
  });
});
