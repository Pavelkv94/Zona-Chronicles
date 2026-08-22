/**
 * M4 (аудит I02B): позиции PRNG становятся канонической частью МИРА, а не выводятся заново.
 *
 * PLAN §4.6 требовал заменить `UnavailableRandomSource` настоящим источником, восстанавливающим
 * позиции из снимка. Замена не была сделана и не была записана отклонением. Здесь она делается,
 * и делается в durable-виде: позиции живут в строке `worlds` и двигаются в ТОЙ ЖЕ транзакции,
 * что событие, а снимок их лишь фотографирует.
 *
 * Почему не «восстанавливать из снимка», как буквально сказано в PLAN. Снимок — точка
 * восстановления, которую оператор берёт по своему решению (OPS-04), а не непрерывная запись:
 * между двумя снимками мир может принять сколько угодно команд. Источник, стартующий с позиций
 * ПОСЛЕДНЕГО снимка, повторил бы уже сделанные розыгрыши — то есть выдал бы те же значения
 * дважды. Позиция обязана двигаться там же, где двигается sequence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ID_PREFIXES, type Command } from '@zona/contracts';
import { DerivedIdFactory } from '@zona/domain';
import { sql } from 'kysely';
import {
  createMigratedDatabase,
  truncateWorldData,
  type MigratedDatabase,
} from './__fixtures__/migrated-database.ts';
import {
  FIXTURE_AGENT_ID,
  FIXTURE_ROUTE_ID,
  FIXTURE_WORLD_ID,
  FIXTURE_WORLD_TIME,
  fixtureInitialization,
} from './__fixtures__/world-fixture.ts';
import type { DatabaseConnection } from './database.ts';
import { executeCommand } from './command-handler.ts';
import { initializeWorld, loadWorldMeta } from './world-repository.ts';

const ids = new DerivedIdFactory('i02b-m4-prng-positions');

const startJourney = (): Command => ({
  command_id: ids.next(RUNTIME_ID_PREFIXES.command),
  world_id: FIXTURE_WORLD_ID,
  type: 'journey.start',
  schema_version: 1,
  actor_id: FIXTURE_AGENT_ID,
  issued_at_world_time: FIXTURE_WORLD_TIME,
  expected_world_version: 0,
  correlation_id: ids.next(RUNTIME_ID_PREFIXES.correlation),
  payload: { route_id: FIXTURE_ROUTE_ID },
});

describe('позиции PRNG durable на уровне мира (M4)', () => {
  let migrated: MigratedDatabase;
  let db: DatabaseConnection;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('prng_positions_world');
    db = migrated.db;
  });

  afterAll(async () => {
    await migrated.close();
  });

  it('позиции, записанные при создании мира, читаются обратно как часть его метаданных', async () => {
    await truncateWorldData(db);
    await initializeWorld(db, {
      ...fixtureInitialization(),
      prngStreamPositions: { [FIXTURE_AGENT_ID]: 7 },
    });

    const meta = await loadWorldMeta(db, FIXTURE_WORLD_ID);
    expect(meta?.prngStreamPositions).toEqual({ [FIXTURE_AGENT_ID]: 7 });
  });

  /**
   * Настоящий детектор подмены: стартовая позиция НЕ равна генезисной. Прежний способ добывать
   * позиции — пересчёт `seedWorld(seed)` — выдал бы генезисное значение и затёр бы сохранённое,
   * причём молча: значения одного типа, теста бы не было.
   */
  it('принятая команда сохраняет позиции мира, а не пересчитывает их из seed', async () => {
    await truncateWorldData(db);
    await initializeWorld(db, {
      ...fixtureInitialization(),
      prngStreamPositions: { [FIXTURE_AGENT_ID]: 11, 'stream:weather': 3 },
    });

    const result = await executeCommand(db, startJourney());
    expect(result.outcome).toBe('accepted');

    const meta = await loadWorldMeta(db, FIXTURE_WORLD_ID);
    expect(meta?.prngStreamPositions).toEqual({ [FIXTURE_AGENT_ID]: 11, 'stream:weather': 3 });
  });

  it('колонка позиций непустая по умолчанию: мир без явных позиций начинает с пустой карты', async () => {
    await truncateWorldData(db);
    await initializeWorld(db, fixtureInitialization());
    const row = await sql<{
      readonly prng_stream_positions: unknown;
    }>`select prng_stream_positions from worlds where world_id = ${FIXTURE_WORLD_ID}`.execute(db);
    expect(row.rows[0]?.prng_stream_positions).toEqual({});
  });
});
