/**
 * D14 / BLOCKER 2 первого раунда I02B — прочитанное состояние соответствует ОДНОЙ версии мира.
 *
 * ## Про сам детектор: он вероятностный, и это записано честно
 *
 * Дефект — гонка: под `read committed` четыре независимых запроса могут застать мир между двумя
 * состояниями. Ревьюер воспроизвёл 9 несвязных чтений из 454. Значит тест НЕ гарантирует поимку
 * на каждом прогоне: он может пропустить дефект, но не может дать ложное падение — несогласованное
 * состояние не возникает, если чтение атомарно.
 *
 * Направление ошибки выбрано сознательно. Детерминированную версию пришлось бы строить на
 * инъекции задержки между запросами, то есть проверять шов, существующий ради проверки. Здесь
 * вместо этого — много чтений под настоящей параллельной записью и ПРОВЕРЯЕМЫЙ ИНВАРИАНТ,
 * который несогласованное состояние нарушает по построению.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ID_PREFIXES, type Command } from '@zona/contracts';
import { DerivedIdFactory } from '@zona/domain';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitializationWithAgents,
  racerAgentIds,
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { executeCommand } from './command-handler.ts';
import { initializeWorld, loadWorldState } from './world-repository.ts';

const ids = new DerivedIdFactory('i03-world-state-consistency');
const AGENTS = 12;

const start = (agentId: string, expectedVersion: number): Command => ({
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

describe('D14: чтение мира самосогласовано под параллельной записью', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i03_world_state_consistency', 16);
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  /**
   * ИНВАРИАНТ: агент в пути обязан иметь запланированное завершение В ТОМ ЖЕ прочитанном
   * состоянии. Оба факта пишутся ОДНОЙ транзакцией (`command-handler.ts`, C1), поэтому мир, в
   * котором они разошлись, не существовал ни в один момент времени — а несогласованное чтение
   * даёт ровно такую пару.
   */
  it('агент в пути всегда имеет своё запланированное завершение', async () => {
    await truncateWorldData(db);
    await initializeWorld(db, fixtureInitializationWithAgents(AGENTS));

    const agents = racerAgentIds(AGENTS);
    const writer = (async () => {
      let version = 0;
      for (const agentId of agents) {
        const result = await executeCommand(db, start(agentId, version));
        if (result.outcome === 'accepted') version += 1;
      }
    })();

    const inconsistencies: string[] = [];
    const reader = (async () => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const state = await loadWorldState(db, FIXTURE_WORLD_ID);
        if (state === null) continue;

        const traveling = Object.values(state.agents).filter(
          (agent) => agent.status === 'traveling',
        );
        const scheduledFor = new Set(
          Object.values(state.scheduledActions).map((action) => action.entityId),
        );
        for (const agent of traveling) {
          if (!scheduledFor.has(agent.id)) {
            inconsistencies.push(
              `agent ${agent.id} traveling без запланированного завершения при sequence ${String(state.sequence)}`,
            );
          }
        }
        // Версия мира не может отставать от числа записанных путей: и то, и другое двигает та
        // же транзакция.
        if (state.worldVersion < traveling.length) {
          inconsistencies.push(
            `worldVersion ${String(state.worldVersion)} меньше числа идущих путей ${String(traveling.length)}`,
          );
        }
      }
    })();

    await Promise.all([writer, reader]);
    expect(inconsistencies).toEqual([]);
  });
});
