/**
 * M2 независимого архитектурного аудита I03 — вход проекции обязан сверяться с журналом.
 *
 * ## Что заявлялось и чего не было
 *
 * Докстринг `loadOutboxEventsAfter` утверждал: «Checksum события ПРОВЕРЯЕТСЯ, как и в
 * `loadWorldEvents`: строка outbox хранит `jsonb`, который не сохраняет канонический порядок
 * ключей, и точность обратного чтения обязана быть проверяемой». Проверки не было: выполнялся
 * только `decodeWorldEvent(row.payload)`, то есть проверка ФОРМЫ, а не тождества факту. Колонки
 * checksum в таблице `outbox` нет вовсе (`0002-canonical-core.ts`).
 *
 * Это единственный вход проекции. ADR-010 §10.2 обосновывает выбор `jsonb` для payload именно
 * наличием сверки — без неё обоснование повисает, а расхождение проекции с журналом становится
 * ненаблюдаемым: экран показывает не то, что произошло, и никто об этом не узнаёт.
 *
 * ## Как вызывается расхождение
 *
 * Честно: прямым `UPDATE` строки `outbox` в обход всякого писателя — тот же приём, что в
 * acceptance-тесте `world replay` для `world_snapshots`. Это моделирует не «злоумышленника», а
 * порчу: потерянный при сериализации порядок ключей, ручную правку, сбой репликации. Событие при
 * этом остаётся ВАЛИДНЫМ по схеме — иначе ловил бы уже существующий `decodeWorldEvent`, и тест
 * не отличал бы новую проверку от старой.
 *
 * Импорты относительные — `tests/` не workspace-пакет. Порча вносится ЧЕРЕЗ САМ builder, а не
 * `sql` из kysely: `kysely` не резолвится из корня, и добавлять его в корневые зависимости
 * нельзя — присутствие адаптера в корне уже один раз молча ослабило контроль границ (`pg` в I03).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ID_PREFIXES, type Command } from '../../packages/contracts/src/index.ts';
import { DerivedIdFactory } from '../../packages/domain/src/index.ts';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../packages/persistence/src/__fixtures__/migrated-database.ts';
import {
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitializationWithAgents,
  racerAgentIds,
} from '../../packages/persistence/src/__fixtures__/world-fixture.ts';
import { executeCommand } from '../../packages/persistence/src/command-handler.ts';
import {
  initializeWorld,
  loadOutboxEventsAfter,
} from '../../packages/persistence/src/world-repository.ts';
import type { DatabaseConnection } from '../../packages/persistence/src/database.ts';

const ids = new DerivedIdFactory('i03-m2-outbox-checksum');

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

describe('M2 — расхождение outbox с журналом обязано быть сбоем, а не тихо другим фактом', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('i03_m2_outbox');
    db = migrated.db;
    await initializeWorld(db, fixtureInitializationWithAgents(2));
    const [first] = racerAgentIds(2);
    expect((await executeCommand(db, start(first!, 0))).outcome).toBe('accepted');
  }, 120_000);

  afterAll(async () => {
    await migrated.close();
  });

  it('исправная строка читается', async () => {
    const events = await loadOutboxEventsAfter(db, FIXTURE_WORLD_ID, 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('journey.started');
  });

  it('подменённая строка outbox отвергается названной причиной, а не отдаётся как факт', async () => {
    // Меняем ПОЛЕ ФАКТА, оставляя событие валидным по схеме: другой актор.
    const rows = await db
      .selectFrom('outbox')
      .select(['event_id', 'payload'])
      .where('world_id', '=', FIXTURE_WORLD_ID)
      .execute();
    expect(rows).toHaveLength(1);
    const corrupted = { ...(rows[0]!.payload as Record<string, unknown>) };
    corrupted['actor_ids'] = ['agent:someone-else'];

    await db
      .updateTable('outbox')
      .set({ payload: JSON.stringify(corrupted) as unknown as never })
      .where('event_id', '=', rows[0]!.event_id)
      .execute();

    await expect(loadOutboxEventsAfter(db, FIXTURE_WORLD_ID, 0, 10)).rejects.toThrow(
      /checksum|расхожд|невосполним/i,
    );
  });
});
