/**
 * B8 — прохождение через базу не меняет канонический результат (SIM-01).
 * B9 — состояние переживает перезапуск процесса.
 *
 * Импорты относительные, а не через `@zona/*`: `tests/` не является workspace-пакетом
 * (та же причина, что у `support/decide-evolve-chain.ts` в I01).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireChecksum } from '../../packages/contracts/src/index.ts';
import {
  DerivedIdFactory,
  FixedClock,
  FixedRuleset,
  decide,
  evolve,
  testRulesetVersions,
  type RandomDraw,
  type RandomSource,
  type WorldState,
} from '../../packages/domain/src/index.ts';
import { PROTOTYPE_WORLD } from '../../packages/content/src/index.ts';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../packages/persistence/src/__fixtures__/test-database.ts';
import { spawnWorldCliDirect } from './support/spawn-world-cli.ts';

const SEED = 42;
const AGENT_ID = 'agent:rook';
const ROUTE_ID = 'route:yard-to-bridge';

/** Тот же отказывающийся PRNG, что в handler-е: этот slice розыгрышей не делает. */
class NoRandomness implements RandomSource {
  draw(streamKey: string): RandomDraw {
    throw new Error(`acceptance: неожиданный розыгрыш по потоку ${streamKey}`);
  }
}

const cli = (argv: readonly string[], databaseUrl: string) =>
  spawnWorldCliDirect(argv, { env: { DATABASE_URL: databaseUrl } });

describe('I02A B8/B9 — durable мир', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('acceptance_i02a');
    const migrate = cli(['world', 'migrate'], db.url);
    expect(migrate.exitCode, migrate.stdout + migrate.stderr).toBe(0);
    const init = cli(['world', 'init', '--seed', String(SEED)], db.url);
    expect(init.exitCode, init.stdout + init.stderr).toBe(0);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('B9: journey, начатый одним процессом, виден другому процессу', () => {
    const run = cli(['world', 'run', '--agent', AGENT_ID, '--route', ROUTE_ID], db.url);
    expect(run.exitCode, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('принята');

    // Отдельный процесс, собственное подключение, ничего общего с предыдущим в памяти.
    const state = cli(['world', 'state'], db.url);
    expect(state.exitCode, state.stdout + state.stderr).toBe(0);
    expect(state.stdout).toMatch(
      new RegExp(`${AGENT_ID}\\s+traveling\\s+в loc:quiet-yard по маршруту ${ROUTE_ID}`),
    );

    const events = cli(['world', 'events'], db.url);
    expect(events.exitCode, events.stdout + events.stderr).toBe(0);
    expect(events.stdout).toContain('Событий: 1');
    expect(events.stdout).toContain('journey.started');
  });

  it('B9: повтор по command_id возвращает записанный результат между процессами', () => {
    // Агент уже в пути, поэтому новая команда получает честный отказ — и именно её
    // command_id используется дальше: журнал команд обязан быть идемпотентным и для
    // отказов, иначе повтор превратил бы записанный отказ в новую попытку (B3).
    const eventsBefore = cli(['world', 'events'], db.url).stdout;
    const rejected = cli(['world', 'run', '--agent', AGENT_ID, '--route', ROUTE_ID], db.url);
    expect(rejected.stdout).toContain('отклонена');
    const commandId = /cmd_[0-9A-HJKMNP-TV-Z]{26}/.exec(rejected.stdout)?.[0];
    expect(commandId).toBeDefined();

    const repeat = cli(
      ['world', 'run', '--agent', AGENT_ID, '--route', ROUTE_ID, '--command-id', commandId!],
      db.url,
    );
    expect(repeat.stdout).toContain('повтор: результат прочитан из journal');
    expect(cli(['world', 'events'], db.url).stdout).toBe(eventsBefore);
  });

  it('B9: тот же command_id с ДРУГИМ телом команды отвергается между процессами (M-2)', () => {
    const first = cli(['world', 'run', '--agent', AGENT_ID, '--route', ROUTE_ID], db.url);
    const commandId = /cmd_[0-9A-HJKMNP-TV-Z]{26}/.exec(first.stdout)?.[0];
    expect(commandId).toBeDefined();

    // Тот же идентификатор, другой актор — это подмена, а не повтор.
    const impostor = cli(
      ['world', 'run', '--agent', 'agent:kite', '--route', ROUTE_ID, '--command-id', commandId!],
      db.url,
    );
    expect(impostor.stdout).toContain('precondition_failed');
    expect(impostor.stdout).toContain('с ДРУГИМ телом команды');
    expect(impostor.exitCode).toBe(1);
  });

  it('B9: без --command-id каждый запуск это новая попытка (M-9)', () => {
    // Прежде id выводился из версии мира, поэтому повтор после потерянного ответа получал
    // ДРУГОЙ id и обходил journal идемпотентности. Теперь связь с версией мира разорвана:
    // два запуска — два разных id, и это видно.
    const a = /cmd_[0-9A-HJKMNP-TV-Z]{26}/.exec(
      cli(['world', 'run', '--agent', AGENT_ID, '--route', ROUTE_ID], db.url).stdout,
    )?.[0];
    const b = /cmd_[0-9A-HJKMNP-TV-Z]{26}/.exec(
      cli(['world', 'run', '--agent', AGENT_ID, '--route', ROUTE_ID], db.url).stdout,
    )?.[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('B8: состояние после команды совпадает с in-memory прогоном той же команды', async () => {
    // Свежая база: сравниваем ОДИН и тот же переход, а не накопленную историю предыдущих тестов.
    const isolated = await createTestDatabase('acceptance_i02a_b8');
    try {
      expect(cli(['world', 'migrate'], isolated.url).exitCode).toBe(0);
      expect(cli(['world', 'init', '--seed', String(SEED)], isolated.url).exitCode).toBe(0);

      const runOutput = cli(
        ['world', 'run', '--agent', AGENT_ID, '--route', ROUTE_ID],
        isolated.url,
      );
      expect(runOutput.exitCode, runOutput.stdout + runOutput.stderr).toBe(0);
      const commandId = /cmd_[0-9A-HJKMNP-TV-Z]{26}/.exec(runOutput.stdout)?.[0];
      expect(commandId).toBeDefined();

      // Путь через БД: читаем состояние обратно тем же кодом, что и продукт.
      const { createDatabase, parseDatabaseConnectionUrl } =
        await import('../../packages/persistence/src/database.ts');
      const { loadWorldState } = await import('../../packages/persistence/src/world-repository.ts');
      const connection = createDatabase(parseDatabaseConnectionUrl(isolated.url));
      let throughDatabase: WorldState | null;
      try {
        throughDatabase = await loadWorldState(connection, PROTOTYPE_WORLD.worldId);
      } finally {
        await connection.destroy();
      }
      expect(throughDatabase).not.toBeNull();

      // Путь в памяти: тот же seed, та же команда, никакой базы.
      const { seedWorld } = await import('../../apps/cli/src/world.ts');
      const initial = seedWorld(SEED).state;
      const decided = decide(
        initial,
        {
          command_id: commandId!,
          world_id: initial.worldId,
          type: 'journey.start',
          schema_version: testRulesetVersions().schemaVersion,
          actor_id: AGENT_ID,
          issued_at_world_time: initial.worldTime,
          expected_world_version: initial.worldVersion,
          correlation_id: new DerivedIdFactory('b8').next('corr'),
          payload: { route_id: ROUTE_ID },
        },
        {
          clock: new FixedClock(initial.worldTime),
          random: new NoRandomness(),
          ids: new DerivedIdFactory(`${initial.worldId}:${String(initial.sequence + 1)}`),
          ruleset: new FixedRuleset(testRulesetVersions()),
        },
      );
      expect(decided.kind).toBe('accepted');
      if (decided.kind !== 'accepted') return;

      let inMemory = initial;
      for (const draft of decided.events) {
        // `recorded_at` — операционная отметка, в доменное состояние не входит: любое значение
        // здесь даёт тот же `WorldState`, и это ровно то, что B8 обязан подтвердить.
        inMemory = evolve(inMemory, { ...draft, recorded_at: '1970-01-01T00:00:00.000Z' });
      }

      expect(requireChecksum(throughDatabase, 'состояние из БД')).toBe(
        requireChecksum(inMemory, 'состояние в памяти'),
      );
      expect(throughDatabase).toEqual(inMemory);
    } finally {
      await isolated.drop();
    }
  });
});
