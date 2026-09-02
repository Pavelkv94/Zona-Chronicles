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

const SEED = 42;
// route:yard-to-bridge (40 мин) годится только агентам, начинающим в loc:quiet-yard — при
// seed=42 это agent:rook и agent:kite (проверено `world inspect --seed 42`); agent:finch стартует
// в loc:bridge, поэтому для него — второй маршрут route:bridge-to-checkpoint (25 мин).
const ROUTE_YARD_TO_BRIDGE = 'route:yard-to-bridge';
const ROUTE_BRIDGE_TO_CHECKPOINT = 'route:bridge-to-checkpoint';

const cli = (argv: readonly string[], databaseUrl: string) =>
  spawnWorldCliDirect(argv, { env: { DATABASE_URL: databaseUrl } });

/** Строки `world events` для заданного типа события — считаем по подстроке, а не парсим JSON:
 *  вывод CLI — человекочитаемый текст, а не машинный формат (см. `runWorldEventsCommand`). */
const countEventLines = (eventsOutput: string, eventType: string): number =>
  eventsOutput.split('\n').filter((line) => line.includes(eventType)).length;

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

  it('C7: единственный journey, начатый без единого запуска worker-а, завершается свежим процессом', () => {
    // Given: journey начат. Ни одного `world tick` до этой точки в тесте не было вовсе — это
    // ПЕРВОЕ обращение к worker-стороне очереди для этого мира.
    const run = cli(
      ['world', 'run', '--agent', 'agent:rook', '--route', ROUTE_YARD_TO_BRIDGE],
      db.url,
    );
    expect(run.exitCode, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('принята');

    const beforeTick = cli(['world', 'events'], db.url);
    expect(beforeTick.stdout).toContain('journey.started');
    expect(beforeTick.stdout).not.toContain('journey.completed');

    // When: worker запускается заново — свежий OS-процесс, ничего не унаследовавший от
    // процесса, который выполнил `world run`. `--advance 40` — ровно `travelMinutes` маршрута,
    // поэтому горизонт совпадает с due_at запланированного завершения.
    const tick = cli(['world', 'tick', '--advance', '40'], db.url);
    expect(tick.exitCode, tick.stdout + tick.stderr).toBe(0);
    expect(tick.stdout).not.toContain('отклонена');

    // Then: завершение произошло, и на единственный journey.started приходится РОВНО одно
    // journey.completed — ни пропуска, ни дубля.
    const afterTick = cli(['world', 'events'], db.url);
    expect(countEventLines(afterTick.stdout, 'journey.started')).toBe(1);
    expect(countEventLines(afterTick.stdout, 'journey.completed')).toBe(1);

    const state = cli(['world', 'state'], db.url);
    expect(state.stdout).toMatch(/agent:rook\s+idle\s+в loc:bridge/);
  });

  it('C7: несколько стартов без единого tick между ними — один tick закрывает КАЖДЫЙ ровно один раз', () => {
    // Given: два НОВЫХ journey стартуют один за другим, и между ними worker снова не запускается
    // ни разу (после предыдущего теста тоже не запускался — это одна и та же база, продолжение
    // истории). У маршрутов разная длительность (40 и 25 минут) специально: single tick обязан
    // подобрать оба due action одним горизонтом, а не совпадением due_at.
    const startedBefore = countEventLines(
      cli(['world', 'events'], db.url).stdout,
      'journey.started',
    );
    const completedBefore = countEventLines(
      cli(['world', 'events'], db.url).stdout,
      'journey.completed',
    );

    const runKite = cli(
      ['world', 'run', '--agent', 'agent:kite', '--route', ROUTE_YARD_TO_BRIDGE],
      db.url,
    );
    expect(runKite.exitCode, runKite.stdout + runKite.stderr).toBe(0);
    const runFinch = cli(
      ['world', 'run', '--agent', 'agent:finch', '--route', ROUTE_BRIDGE_TO_CHECKPOINT],
      db.url,
    );
    expect(runFinch.exitCode, runFinch.stdout + runFinch.stderr).toBe(0);

    const midEvents = cli(['world', 'events'], db.url).stdout;
    expect(countEventLines(midEvents, 'journey.started')).toBe(startedBefore + 2);
    expect(countEventLines(midEvents, 'journey.completed')).toBe(completedBefore);

    // When: ОДИН свежий worker-процесс. `--advance 40` покрывает оба due_at: finch (+25) и
    // kite (+40) относительно текущего мирового времени.
    const tick = cli(['world', 'tick', '--advance', '40'], db.url);
    expect(tick.exitCode, tick.stdout + tick.stderr).toBe(0);
    // Четыре, а не два: с I05-B каждый прибывший СВОБОДЕН, и мир немедленно даёт ему решить,
    // что делать дальше. `world tick` доводит мир до горизонта, поэтому оба решения попадают в
    // тот же вызов. Утверждение C7 при этом не ослаблено: оно про завершения пути, и они
    // проверяются ниже по журналу поимённо.
    expect(tick.stdout).toContain('Захвачено действий: 4');

    // Then: у каждого из двух новых journey.started есть ровно одно journey.completed — прирост
    // завершений равен приросту стартов, а не меньше (пропуск) и не больше (дубль).
    const afterEvents = cli(['world', 'events'], db.url).stdout;
    expect(countEventLines(afterEvents, 'journey.started')).toBe(startedBefore + 2);
    expect(countEventLines(afterEvents, 'journey.completed')).toBe(completedBefore + 2);

    const state = cli(['world', 'state'], db.url);
    expect(state.stdout).toMatch(/agent:kite\s+idle\s+в loc:bridge/);
    expect(state.stdout).toMatch(/agent:finch\s+idle\s+в loc:checkpoint/);
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
