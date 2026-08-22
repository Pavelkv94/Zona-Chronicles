/**
 * `world replay` — команда действительно сравнивает и действительно падает при расхождении
 * (ACCEPTANCE C9/C10, `PLAN.md` §2, задание "последний пункт scope итерации").
 *
 * C9/C10 в математическом смысле (снимок + суффикс журнала == непрерывный прогон; replay не
 * делает ни одного розыгрыша) уже доказаны интеграционными тестами persistence
 * (`replay.integration.test.ts`) — дублировать их процессами смысла нет (так и сказано в
 * задании). Здесь проверяется другое, чем не покрыт НИКТО: что КОМАНДА `world replay` (не
 * движок под ней) действительно читает снимок, действительно сверяет checksum с ТЕКУЩИМ
 * состоянием базы и действительно возвращает ненулевой exit при расхождении — а не просто
 * печатает то, что ей вернул `replayFromSnapshot`.
 *
 * Расхождение в последнем тесте создаётся ЧЕСТНО: прямой SQL `UPDATE` строки `world_snapshots`
 * В ОБХОД CLI, а не подмена внутри самой команды. Это тот же класс порчи, от которого защищает
 * `verifySnapshotChecksum` на чтении — checksum строки внутренне непротиворечив (пересчитан по
 * той же формуле, что и `writeSnapshot`), но `canonical_state` больше не описывает РЕАЛЬНУЮ
 * историю мира.
 *
 * Импорты относительные, а не через `@zona/*` — `tests/` не workspace-пакет (та же причина, что
 * у `i02a-b8-b9-durable-world.acceptance.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  requireCanonical,
  snapshotChecksum,
  type DeterministicRuntimeProfile,
  type Snapshot,
} from '../../packages/contracts/src/index.ts';
import type { WorldState } from '../../packages/domain/src/index.ts';
import {
  createDatabase,
  parseDatabaseConnectionUrl,
} from '../../packages/persistence/src/database.ts';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../packages/persistence/src/__fixtures__/test-database.ts';
import { currentBundles } from '../../apps/cli/src/world.ts';
import { spawnWorldCliDirect } from './support/spawn-world-cli.ts';

const SEED = 42;
const ROUTE_ID = 'route:yard-to-bridge';
const WORLD_ID = 'world:prototype';
const SHA256_PATTERN = /sha256:[0-9a-f]{64}/g;

const cli = (argv: readonly string[], databaseUrl: string) =>
  spawnWorldCliDirect(argv, { env: { DATABASE_URL: databaseUrl } });

const checksumsIn = (output: string): string[] =>
  [...output.matchAll(SHA256_PATTERN)].map((match) => match[0]);

describe('I02B — `world replay` сравнивает и падает честно (C9/C10 на уровне команды)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('acceptance_i02b_replay');
    expect(cli(['world', 'migrate'], db.url).exitCode).toBe(0);
    expect(cli(['world', 'init', '--seed', String(SEED)], db.url).exitCode).toBe(0);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('без единого снимка replay восстанавливает genesis из seed, и checksum совпадает (демо PLAN §2)', () => {
    expect(
      cli(['world', 'run', '--agent', 'agent:rook', '--route', ROUTE_ID], db.url).exitCode,
    ).toBe(0);
    expect(cli(['world', 'tick', '--advance', '40'], db.url).exitCode).toBe(0);

    // Ни одного "world snapshot" до этой точки — ровно то, что буквально пишет demo PLAN §2:
    // `pnpm world replay` голым, последней строкой, без предшествующего снятия снимка.
    const replay = cli(['world', 'replay'], db.url);
    expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
    expect(replay.stdout).toContain('в базе снимков не было — восстановлен из seed');
    expect(replay.stdout).toContain('checksum совпадает.');

    const checksums = checksumsIn(replay.stdout);
    expect(checksums).toHaveLength(2);
    expect(checksums[0]).toBe(checksums[1]);
  });

  it('снимок посреди истории — суффикс применяется, checksum совпадает, "восстановлен из seed" не печатается', () => {
    expect(cli(['world', 'snapshot'], db.url).exitCode).toBe(0);

    expect(
      cli(['world', 'run', '--agent', 'agent:kite', '--route', ROUTE_ID], db.url).exitCode,
    ).toBe(0);
    expect(cli(['world', 'tick', '--advance', '40'], db.url).exitCode).toBe(0);

    const replay = cli(['world', 'replay'], db.url);
    expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
    expect(replay.stdout).not.toContain('восстановлен из seed');
    expect(replay.stdout).toMatch(/Применено событий суффикса: [1-9]/);
    expect(replay.stdout).toContain('checksum совпадает.');

    const checksums = checksumsIn(replay.stdout);
    expect(checksums).toHaveLength(2);
    expect(checksums[0]).toBe(checksums[1]);
  });

  it('world snapshot: повторная запись на той же sequence — честный отказ, а не тихая перезапись точки восстановления', () => {
    // Самодостаточный тест, а не зависимость от того, сдвинулась ли история в предыдущих тестах
    // этого файла: первый вызов ЗДЕСЬ и ВТОРОЙ вызов сразу за ним, без единого шага истории
    // между ними — история точно не сдвинулась, и второй обязан отказать.
    const first = cli(['world', 'snapshot'], db.url);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);

    const second = cli(['world', 'snapshot'], db.url);
    expect(second.exitCode).toBe(2);
    expect(second.stdout).toContain('уже существует');
  });

  it('world replay: РАСХОЖДЕНИЕ между снимком и реальностью — команда падает, а не молчит (C10)', async () => {
    const connection = createDatabase(parseDatabaseConnectionUrl(db.url));
    try {
      const row = await connection
        .selectFrom('world_snapshots')
        .selectAll()
        .where('world_id', '=', WORLD_ID)
        .orderBy('last_sequence', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();

      const originalState = row.canonical_state as WorldState;
      const rook = originalState.agents['agent:rook'];
      expect(rook).toBeDefined();
      // Любое ДРУГОЕ валидное значение локации подходит: checksum сравнивает данные, а не
      // бизнес-правила, поэтому семантическая достижимость точки назначения тут не важна.
      const tamperedLocationId =
        rook!.locationId === 'loc:bridge' ? 'loc:checkpoint' : 'loc:bridge';
      const tamperedState: WorldState = {
        ...originalState,
        agents: {
          ...originalState.agents,
          'agent:rook': { ...rook!, locationId: tamperedLocationId },
        },
      };

      // Пересчитываем checksum ТОЙ ЖЕ формулой, что и `writeSnapshot` — иначе порча ловилась бы
      // на чтении `verifySnapshotChecksum`-ом, а не там, где её обязан поймать `world replay`.
      const withoutChecksum: Omit<Snapshot, 'checksum'> = {
        world_id: row.world_id,
        last_sequence: Number(row.last_sequence),
        world_time: row.world_time,
        created_at: row.created_at.toISOString(),
        bundles: currentBundles(),
        deterministic_runtime_profile:
          row.deterministic_runtime_profile as DeterministicRuntimeProfile,
        prng_stream_positions: row.prng_stream_positions as Readonly<Record<string, number>>,
        canonical_state: tamperedState,
      };
      const tamperedChecksum = snapshotChecksum(withoutChecksum);

      await connection
        .updateTable('world_snapshots')
        .set({
          canonical_state: requireCanonical(tamperedState, 'i02b-c9-c10 test tamper'),
          checksum: tamperedChecksum,
        })
        .where('world_id', '=', row.world_id)
        .where('last_sequence', '=', row.last_sequence)
        .execute();
    } finally {
      await connection.destroy();
    }

    const replay = cli(['world', 'replay'], db.url);
    expect(replay.exitCode, replay.stdout + replay.stderr).toBe(1);
    expect(replay.stdout).toContain('РАСХОЖДЕНИЕ');
    expect(replay.stdout).toContain('SIM-01');

    const checksums = checksumsIn(replay.stdout);
    expect(checksums).toHaveLength(2);
    expect(checksums[0]).not.toBe(checksums[1]);
  });
});
