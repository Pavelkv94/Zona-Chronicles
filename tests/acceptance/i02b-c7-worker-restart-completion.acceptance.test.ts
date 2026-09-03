/**
 * C7 — остановка между стартом journey и завершением ничего не теряет
 * (`docs/iterations/I02B-scheduler-and-replay/ACCEPTANCE.md`).
 *
 * Given journey начат, worker НИ РАЗУ не запускался (ни одного `world tick` между `world run` и
 * этим прогоном). When процесс worker-а запускается заново (свежий `world tick`). Then завершение
 * происходит, And каждому `journey.started` соответствует РОВНО одно `journey.completed`.
 *
 * ACCEPTANCE прямо требует настоящих процессов, а не переиспользования пула в одном: каждый вызов
 * `cli(...)` здесь — отдельный `spawnSync` (`spawnWorldCliDirect`), со своим подключением к базе,
 * которое открывается и закрывается вокруг ровно одной команды (см. `runCliAsync` в `main.ts`).
 * Ничего не остаётся в памяти между вызовами: свежий `world tick` не может подглядеть в состояние
 * предыдущего процесса, только прочитать то, что тот успел закоммитить в базу.
 *
 * Импорты относительные, а не через `@zona/*` — `tests/` не workspace-пакет (та же причина, что
 * у `i02a-b8-b9-durable-world.acceptance.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../packages/persistence/src/__fixtures__/test-database.ts';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';
import {
  assertCalmLocationsMatchMap,
  calmLegs,
  parseAgentLocations,
} from '../support/calm-routes.ts';

const SEED = 42;
// route:yard-to-bridge (40 мин) годится только агентам, начинающим в loc:quiet-yard — при
// seed=42 это agent:rook и agent:kite (проверено `world inspect --seed 42`); agent:finch стартует
// в loc:bridge, поэтому для него — второй маршрут route:bridge-to-checkpoint (25 мин).

const cli = (argv: readonly string[], databaseUrl: string) =>
  spawnWorldCliDirect(argv, { env: { DATABASE_URL: databaseUrl } });

/** Строки `world events` для заданного типа события — считаем по подстроке, а не парсим JSON:
 *  вывод CLI — человекочитаемый текст, а не машинный формат (см. `runWorldEventsCommand`). */
describe('I02B C7 — worker, запущенный заново, доводит journey до конца', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('acceptance_i02b_c7');
    const migrate = cli(['world', 'migrate'], db.url);
    expect(migrate.exitCode, migrate.stdout + migrate.stderr).toBe(0);
    const init = cli(['world', 'init', '--seed', String(SEED)], db.url);
    expect(init.exitCode, init.stdout + init.stderr).toBe(0);
  });

  afterAll(async () => {
    await db.drop();
  });

  /** Где стоит каждый агент — по выводу `world state`, а не по памяти о seed. */
  const agentLocations = (): Readonly<Record<string, string>> => {
    const state = cli(['world', 'state'], db.url);
    expect(state.exitCode, state.stdout).toBe(0);
    return parseAgentLocations(state.stdout);
  };

  /** Сколько событий данного типа относится к КОНКРЕТНОМУ агенту. */
  const countFor = (eventsOutput: string, eventType: string, agentId: string): number =>
    eventsOutput.split('\n').filter((line) => line.includes(eventType) && line.includes(agentId))
      .length;

  it('C7: единственный journey, начатый без единого запуска worker-а, завершается свежим процессом', () => {
    /**
     * Дорога выбирается СПОКОЙНАЯ, и это не удобство.
     *
     * С I06-C мир перестал быть неподвижным между командами оператора: пришедший в опасное место
     * агент немедленно решает уйти. Тест про перезапуск worker-а, поставленный на такую дорогу,
     * падал бы из-за поведения агента — то есть по причине, к его утверждению отношения не
     * имеющей. Так он и упал впервые.
     */
    assertCalmLocationsMatchMap();
    const [leg] = calmLegs(agentLocations());
    expect(leg, 'ни один агент не стоит в спокойном месте').toBeDefined();
    if (leg === undefined) return;

    // Given: journey начат. Ни одного `world tick` до этой точки в тесте не было вовсе — это
    // ПЕРВОЕ обращение к worker-стороне очереди для этого мира.
    const run = cli(['world', 'run', '--agent', leg.agentId, '--route', leg.routeId], db.url);
    expect(run.exitCode, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('принята');

    const beforeTick = cli(['world', 'events'], db.url);
    expect(beforeTick.stdout).toContain('journey.started');
    expect(beforeTick.stdout).not.toContain('journey.completed');

    // When: worker запускается заново — свежий OS-процесс, ничего не унаследовавший от
    // процесса, который выполнил `world run`. Горизонт равен длительности маршрута, поэтому
    // совпадает с due_at запланированного завершения.
    const tick = cli(['world', 'tick', '--advance', String(leg.travelMinutes)], db.url);
    expect(tick.exitCode, tick.stdout + tick.stderr).toBe(0);
    expect(tick.stdout).not.toContain('отклонена');

    // Then: у ЭТОГО агента на единственный journey.started приходится ровно одно
    // journey.completed — ни пропуска, ни дубля. Счёт по агенту, а не по миру: мир живёт своей
    // жизнью, и общий счётчик проверял бы её, а не перезапуск worker-а.
    const afterTick = cli(['world', 'events'], db.url);
    expect(countFor(afterTick.stdout, 'journey.started', leg.agentId)).toBe(1);
    expect(countFor(afterTick.stdout, 'journey.completed', leg.agentId)).toBe(1);

    const state = cli(['world', 'state'], db.url);
    expect(state.stdout).toMatch(new RegExp(`${leg.agentId}\\s+idle\\s+в ${leg.toLocationId}`));
  });

  it('C7: несколько стартов без единого tick между ними — один tick закрывает КАЖДЫЙ ровно один раз', () => {
    // Given: два НОВЫХ journey стартуют один за другим, и между ними worker не запускается ни
    // разу. Оба ведут в спокойные места — по тому же доводу, что и выше.
    assertCalmLocationsMatchMap();
    const legs = calmLegs(agentLocations()).slice(0, 2);
    expect(legs.length, 'нужны двое агентов в спокойных местах').toBe(2);

    for (const leg of legs) {
      const started = cli(['world', 'run', '--agent', leg.agentId, '--route', leg.routeId], db.url);
      expect(started.exitCode, started.stdout + started.stderr).toBe(0);
    }

    const startedBefore = legs.map((leg) =>
      countFor(cli(['world', 'events'], db.url).stdout, 'journey.completed', leg.agentId),
    );

    // When: ОДИН свежий worker-процесс, горизонт покрывает оба due_at.
    const horizon = Math.max(...legs.map((leg) => leg.travelMinutes));
    const tick = cli(['world', 'tick', '--advance', String(horizon)], db.url);
    expect(tick.exitCode, tick.stdout + tick.stderr).toBe(0);

    // Then: у каждого прирост завершений ровно один — не меньше (пропуск) и не больше (дубль).
    const afterEvents = cli(['world', 'events'], db.url).stdout;
    legs.forEach((leg, index) => {
      expect(countFor(afterEvents, 'journey.completed', leg.agentId)).toBe(
        (startedBefore[index] ?? 0) + 1,
      );
    });
  });

  // Не C7 сама по себе, а требование постановки задачи к `world tick`: «оба флага сразу — отказ
  // с названной причиной, а не молчаливый приоритет одного над другим». Не мутирует состояние
  // (обе ветки возвращаются до вызова `runWorldTick`), поэтому безопасно в любом месте файла.
  it('world tick: --advance и --until одновременно — явный отказ, а не тихий выбор одного из двух', () => {
    const result = cli(
      ['world', 'tick', '--advance', '10', '--until', '2028-04-26T07:00:00.000Z'],
      db.url,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('--advance');
    expect(result.stdout).toContain('--until');
    expect(result.stdout.toLowerCase()).toContain('взаимоисключ');
  });

  it('world tick: нецелый --advance отвергается флаговой ошибкой, а не NaN-горизонтом', () => {
    const result = cli(['world', 'tick', '--advance', 'soon'], db.url);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('--advance');
  });
});
