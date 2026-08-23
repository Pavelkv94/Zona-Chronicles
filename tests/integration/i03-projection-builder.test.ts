/**
 * D6/D7 — сборщик проекции: ровно один раз на событие и пересборка с нуля.
 *
 * Прогоняется на НАСТОЯЩЕЙ базе: обещание «ровно один раз» держится на атомарности транзакции, а
 * транзакцию нельзя проверить на подделке.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RUNTIME_ID_PREFIXES,
  decodeObserverWorldSnapshot,
  isValidationFailure,
  type Command,
} from '../../packages/contracts/src/index.ts';
import { DerivedIdFactory } from '../../packages/domain/src/index.ts';
import type { DatabaseConnection } from '../../packages/persistence/src/database.ts';
import { executeCommand } from '../../packages/persistence/src/command-handler.ts';
import {
  initializeWorld,
  loadWorldState,
} from '../../packages/persistence/src/world-repository.ts';
import { runWorldTick } from '../../packages/persistence/src/scheduler.ts';
import {
  createProjectionDatabase,
  parseProjectionDatabaseUrl,
  type ProjectionDatabase,
} from '../../packages/projections/src/projection-database.ts';
import {
  loadObserverEvents,
  loadObserverSnapshot,
} from '../../packages/projections/src/projection-store.ts';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../packages/persistence/src/__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_OTHER_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from '../../packages/persistence/src/__fixtures__/world-fixture.ts';
import {
  createProjectionAtGenesis,
  rebuildProjection,
  runProjectionStep,
} from '../../apps/worker/src/projection-builder.ts';

const ids = new DerivedIdFactory('i03-projection-builder');
const ARRIVAL = '2028-04-26T06:40:00.000Z';
const NOW = new Date('2026-08-23T00:00:00.000Z');

/** Расстановка агентов на момент создания фикстурного мира (см. `fixtureState`). */
const GENESIS = {
  worldTime: FIXTURE_WORLD_TIME,
  agents: [
    {
      agent_id: FIXTURE_AGENT_ID,
      name: 'Рук',
      location_id: 'loc:quiet-yard' as string | null,
      status: 'idle' as const,
      route_id: null,
    },
    {
      agent_id: FIXTURE_OTHER_AGENT_ID,
      name: 'Коршун',
      location_id: 'loc:quiet-yard' as string | null,
      status: 'idle' as const,
      route_id: null,
    },
  ],
};

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

describe('D6/D7 — сборка observer projection', () => {
  let migrated: MigratedDatabase;
  let canonical: DatabaseConnection;
  let projection: ProjectionDatabase;

  const deps = () => ({
    canonical,
    projection,
    worldId: FIXTURE_WORLD_ID,
    now: () => NOW,
  });

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i03_projection_builder');
    canonical = migrated.db;
    projection = createProjectionDatabase(parseProjectionDatabaseUrl(migrated.testDb.url));

    await initializeWorld(canonical, fixtureInitialization());
    expect((await executeCommand(canonical, startJourney(FIXTURE_AGENT_ID, 0))).outcome).toBe(
      'accepted',
    );
    expect((await executeCommand(canonical, startJourney(FIXTURE_OTHER_AGENT_ID, 1))).outcome).toBe(
      'accepted',
    );
    const tick = await runWorldTick(canonical, {
      worldId: FIXTURE_WORLD_ID,
      owner: 'test',
      horizon: ARRIVAL,
    });
    expect(tick.claimed).toBe(2);

    // Проекция создаётся в ГЕНЕЗИСЕ, как это делает `world init`: иначе лента начиналась бы
    // пустой, а пересборка сворачивала бы ноль событий и D7 выполнялся бы тождественно.
    await createProjectionAtGenesis(deps(), GENESIS);
  });

  afterAll(async () => {
    await projection.destroy();
    await migrated.close();
  });

  it('D6: первый прогон догоняет журнал, второй не добавляет ничего', async () => {
    const first = await runProjectionStep(deps());
    const state = await loadWorldState(canonical, FIXTURE_WORLD_ID);
    expect(first.applied).toBe(state!.sequence);

    const second = await runProjectionStep(deps());
    expect(second.applied).toBe(0);
    expect(second.projectionSequence).toBe(first.projectionSequence);
  });

  it('D6: лента содержит каждое событие ровно один раз, курсор строго возрастает', async () => {
    const page = await loadObserverEvents(projection, FIXTURE_WORLD_ID, { after: 0, limit: 100 });
    const sequences = page.events.map((event) => event.projection_sequence);

    expect(new Set(page.events.map((event) => event.event_id)).size).toBe(page.events.length);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences[0]).toBe(1);
  });

  it('D8: snapshot проекции самодостаточен и совпадает с каноническим состоянием', async () => {
    const snapshot = await loadObserverSnapshot(projection, FIXTURE_WORLD_ID);
    const canonicalState = await loadWorldState(canonical, FIXTURE_WORLD_ID);

    expect(snapshot).not.toBeNull();

    /**
     * D8 требует, чтобы ответ НЕ содержал ни одного канонического поля, и ссылается на
     * contract-тест. Тот действительно вызывает `decodeObserverWorldSnapshot` — но на ЗАГЛУШКЕ
     * порта, то есть проверяет форму выдуманного объекта. Схема с `additionalProperties: false`
     * ловит лишнее поле только там, где к ней приложены НАСТОЯЩИЕ данные из проекции: лишнее
     * поле придёт из колонки таблицы, а не из литерала в тесте.
     */
    const decoded = decodeObserverWorldSnapshot(snapshot);
    expect(isValidationFailure(decoded) ? decoded.issues : []).toEqual([]);
    expect(snapshot!.world_time).toBe(canonicalState!.worldTime);
    expect(snapshot!.nodes.length).toBeGreaterThan(0);
    expect(snapshot!.edges.length).toBeGreaterThan(0);

    // Оба агента дошли: canonical и проекция обязаны говорить одно и то же о КАЖДОМ.
    for (const agent of snapshot!.agents) {
      const canonicalAgent = canonicalState!.agents[agent.agent_id];
      expect(canonicalAgent).toBeDefined();
      expect(agent.status).toBe(canonicalAgent!.status);
      if (agent.status === 'idle') {
        expect(agent.location_id).toBe(canonicalAgent!.locationId);
      }
    }
  });

  /**
   * D7: единственный поддерживаемый способ починки. Проверяется побайтовым совпадением, а не
   * «пересборка отработала»: пересборка, дающая другой результат, — это и есть тот дефект, от
   * которого проекция должна быть защищена.
   */
  it('D7: пересборка с нуля даёт тот же результат, что инкрементальная сборка', async () => {
    const before = await loadObserverSnapshot(projection, FIXTURE_WORLD_ID);
    const beforeFeed = await loadObserverEvents(projection, FIXTURE_WORLD_ID, {
      after: 0,
      limit: 100,
    });

    const rebuilt = await rebuildProjection(deps(), GENESIS);
    expect(rebuilt.applied).toBe(beforeFeed.events.length);

    const after = await loadObserverSnapshot(projection, FIXTURE_WORLD_ID);
    const afterFeed = await loadObserverEvents(projection, FIXTURE_WORLD_ID, {
      after: 0,
      limit: 100,
    });

    expect(after).toEqual(before);
    expect(afterFeed.events).toEqual(beforeFeed.events);
  });
});
