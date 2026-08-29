/**
 * I04 — нужда меняется во времени, а журнал остаётся списком фактов
 * (`docs/iterations/I04-needs-and-items/PLAN.md` §3, §6; `07_MVP_MECHANICS_SPEC` §5).
 *
 * Проверяется решение итерации целиком, на настоящем мире и через тот же CLI, которым работает
 * оператор:
 *
 * - Given мир создан и никто в него не вмешивается;
 * - When мировое время доходит до порога голода;
 * - Then появляется РОВНО одно событие на каждое пересечение — и ни одного между ними.
 *
 * Мир двигается `world tick --until <момент>`, а не живым worker-ом, намеренно: проверяется, ЧТО
 * происходит и сколько раз, а не когда. Темп сюда не входит вовсе (D2), поэтому и вносить его в
 * измерение незачем — он добавил бы к тесту только неопределённость ожидания.
 *
 * Горизонт задаётся АБСОЛЮТНЫМ моментом, а не сдвигом `--advance`. Разница не стилистическая:
 * `--advance` считается от ТЕКУЩЕГО мирового времени, а оно двигается только событиями и в
 * тишине стоит. Два сдвига подряд поэтому не складываются — второй считается от той же точки,
 * что первый, и тест, написанный на сдвигах, измерял бы не то, что заявляет. Найдено
 * исполнением: шаг «ещё одна минута до порога» приводил горизонт к 06:01 вместо 07:12.
 *
 * Импорты относительные: `tests/` не workspace-пакет.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../packages/persistence/src/__fixtures__/test-database.ts';
import {
  createDatabase,
  parseDatabaseConnectionUrl,
} from '../../packages/persistence/src/database.ts';
import { requireAddMinutes, requireInstant } from '../../packages/contracts/src/index.ts';
import { PROTOTYPE_NEEDS } from '../../packages/domain/src/ports/ruleset.ts';
import { PROTOTYPE_WORLD } from '../../packages/content/src/index.ts';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';

const SEED = 42;

/** Стартовый момент мира прототипа: от него отсчитываются и нужды, и горизонты этого теста. */
const WORLD_START = requireInstant(PROTOTYPE_WORLD.initialWorldTime, 'initialWorldTime').iso;

/** Абсолютный момент «стартовое время мира плюс N мировых минут». */
const atMinute = (minutes: number): string =>
  requireAddMinutes(requireInstant(WORLD_START, 'WORLD_START'), minutes, 'горизонт теста').iso;

/**
 * Минуты до порогов считаются ИЗ КОЭФФИЦИЕНТОВ, а не выписаны числами.
 *
 * Выписанное число проверяло бы, что мир согласен с моим арифметическим упражнением. Через
 * коэффициенты тест проверяет другое и нужное: что мир согласен со СВОИМИ ПРАВИЛАМИ, — и
 * переживает их настройку, оставаясь при этом чувствительным к поломке механики.
 */
const minutesTo = (need: 'hunger' | 'fatigue', level: 'warning' | 'critical'): number => {
  const config = PROTOTYPE_NEEDS[need];
  const permille = level === 'warning' ? config.warningAtPermille : config.criticalAtPermille;
  return Math.ceil((permille * config.minutesToFull) / 1000);
};

const cli = (argv: readonly string[], databaseUrl: string) =>
  spawnWorldCliDirect(argv, { env: { DATABASE_URL: databaseUrl } });

/**
 * Доводит мир до горизонта ПОЛНОСТЬЮ, а не одним шагом.
 *
 * Один `world tick` захватывает то, что было назначено НА МОМЕНТ ЗАХВАТА. Пересечение порога
 * планирует следующее пересечение, поэтому за один шаг мир проходит один порог на нужду, даже
 * если горизонт покрывает несколько. Это не дефект, а пачечная семантика шага (C4): живой
 * worker опрашивает мир в цикле и приходит к тому же результату.
 *
 * Найдено исполнением: тест ожидал все пересечения после одного шага и получил на четверть
 * меньше — ожидание было неверным, а не мир.
 */
const tickUntilQuiet = (until: string, databaseUrl: string): number => {
  for (let step = 0; step < 20; step += 1) {
    const tick = cli(['world', 'tick', '--until', until], databaseUrl);
    if (tick.exitCode !== 0) throw new Error(`world tick упал: ${tick.stdout}${tick.stderr}`);
    if (tick.stdout.includes('Нечего обрабатывать')) return step;
  }
  throw new Error(`мир не успокоился за 20 шагов до горизонта ${until}`);
};

/**
 * Действия, СРОК которых наступил, но которые так и остались необработанными.
 *
 * Читается прямо из базы, а не через CLI, и это не короткий путь. Через CLI такое состояние
 * НЕВИДИМО в течение аренды: захваченная строка на тридцать секунд не показывается очереди, и
 * шаг мира честно отвечает «нечего обрабатывать». Проба мутации это и показала — детектор,
 * считавший шаги до тишины, измерял окно аренды, а не работу мира, и пропускал дефект, при
 * котором выполненное действие навсегда остаётся в расписании.
 */
const overdueActions = async (databaseUrl: string, horizon: string): Promise<readonly string[]> => {
  const connection = createDatabase(parseDatabaseConnectionUrl(databaseUrl));
  try {
    const rows = await connection
      .selectFrom('scheduled_actions')
      .select('action_id')
      .where('completed_at', 'is', null)
      .where('failed_at', 'is', null)
      .where('due_at', '<=', horizon)
      .orderBy('action_id')
      .execute();
    return rows.map((row) => row.action_id);
  } finally {
    await connection.destroy();
  }
};

/** Строки ленты `world events` с пересечением порога. Вывод CLI — текст для человека. */
const crossingLines = (output: string): readonly string[] =>
  output.split('\n').filter((line) => line.includes('need.threshold.crossed'));

describe('I04 — пересечение порога это факт, а не измерение', () => {
  let db: TestDatabase;
  let agentCount = 0;

  beforeAll(async () => {
    db = await createTestDatabase('acceptance_i04_needs');
    expect(cli(['world', 'migrate'], db.url).exitCode).toBe(0);
    const init = cli(['world', 'init', '--seed', String(SEED)], db.url);
    expect(init.exitCode, init.stdout + init.stderr).toBe(0);

    const state = cli(['world', 'state'], db.url);
    expect(state.exitCode, state.stdout).toBe(0);
    agentCount = state.stdout.split('\n').filter((line) => line.includes('agent:')).length;
    expect(agentCount).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('до первого порога мир молчит: ни одного события за всё время ожидания', () => {
    // Усталость наступает раньше голода, поэтому граница молчания — её порог.
    const untilJustBefore = atMinute(minutesTo('fatigue', 'warning') - 1);
    const tick = cli(['world', 'tick', '--until', untilJustBefore], db.url);
    expect(tick.exitCode, tick.stdout).toBe(0);

    const events = cli(['world', 'events'], db.url);
    expect(crossingLines(events.stdout)).toHaveLength(0);
  });

  it('на пороге появляется ровно одно событие на агента, и ни одним больше', () => {
    // Ещё одна минута — и порог перейден. Минута, а не час: событие обязано появиться ИМЕННО на
    // пороге, а не «когда-нибудь потом»; крупный шаг этого бы не различил.
    const atThreshold = atMinute(minutesTo('fatigue', 'warning'));
    expect(cli(['world', 'tick', '--until', atThreshold], db.url).exitCode).toBe(0);

    const events = cli(['world', 'events'], db.url);
    const crossed = crossingLines(events.stdout);
    expect(crossed).toHaveLength(agentCount);
  });

  it('между порогами не происходит НИЧЕГО: сутки ожидания не добавляют событий', () => {
    // Ключевое утверждение итерации и её STOP-условие: «pulses создают непросматриваемый поток
    // событий». Здесь проверяется, что потока нет КОНСТРУКТИВНО — между двумя порогами мир не
    // порождает ни одного факта, сколько бы времени ни прошло.
    const before = crossingLines(cli(['world', 'events'], db.url).stdout).length;

    const gap = minutesTo('hunger', 'warning') - minutesTo('fatigue', 'warning');
    expect(gap).toBeGreaterThan(60);
    const untilJustBeforeHunger = atMinute(minutesTo('hunger', 'warning') - 1);
    expect(cli(['world', 'tick', '--until', untilJustBeforeHunger], db.url).exitCode).toBe(0);

    const after = crossingLines(cli(['world', 'events'], db.url).stdout).length;
    expect(after).toBe(before);
  });

  it('порог не пропускается: скачок через два порога сразу даёт оба события', () => {
    // Мир, простоявший ночь, обязан пройти пропущенные пороги ПО ОДНОМУ, а не «догнать» их
    // последним. Иначе летопись потеряла бы переход, который в мире состоялся.
    const jump = atMinute(
      Math.max(minutesTo('fatigue', 'critical'), minutesTo('hunger', 'critical')),
    );
    tickUntilQuiet(jump, db.url);

    const crossed = crossingLines(cli(['world', 'events'], db.url).stdout);
    // Четыре пересечения на агента: warning и critical у голода и у усталости.
    expect(crossed).toHaveLength(agentCount * 4);

    // И каждое — своё: ни один уровень не появляется дважды у одного агента.
    const seen = new Set(crossed.map((line) => line.trim()));
    expect(seen.size).toBe(crossed.length);
  });

  it('дальше пороги кончаются, и в расписании не остаётся ничего просроченного', async () => {
    const before = crossingLines(cli(['world', 'events'], db.url).stdout).length;

    const far = atMinute(100_000);
    tickUntilQuiet(far, db.url);

    const after = crossingLines(cli(['world', 'events'], db.url).stdout).length;
    expect(after).toBe(before);

    // Проверяется не только лента, но и РАСПИСАНИЕ. Если выполненное пересечение не снимать,
    // новых событий не появится — повтор идемпотентен и вернёт записанный результат, — но
    // сделанное действие навсегда останется ждущим. По ленте это неотличимо от исправного мира;
    // по расписанию отличимо сразу.
    expect(await overdueActions(db.url, far)).toEqual([]);
  });

  it('пересимуляция журнала даёт то же состояние: расписание нужд выводится из фактов', () => {
    // Самая важная проверка среза, и она нашлась пробой мутации. Операционную очередь ведёт
    // scheduler: он помечает обработанное действие выполненным САМ, поэтому мир продолжает
    // работать даже если `evolve` забыл снять его с КАНОНИЧЕСКОГО расписания. По ленте и по
    // занятости мира это неотличимо — расходятся только состояние из базы и состояние,
    // выведенное из журнала, и увидеть расхождение может лишь пересимуляция.
    const replay = cli(['world', 'replay'], db.url);
    expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
    expect(replay.stdout).toContain('checksum совпадает.');
  });
});
