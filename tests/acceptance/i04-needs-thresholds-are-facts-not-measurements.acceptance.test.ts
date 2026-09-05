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
import { loadWorldEvents } from '../../packages/persistence/src/world-repository.ts';
import type { WorldEvent } from '../../packages/contracts/src/index.ts';
import { requireAddMinutes, requireInstant } from '../../packages/contracts/src/index.ts';
import { PROTOTYPE_NEEDS } from '../../packages/domain/src/ports/ruleset.ts';
import { PROTOTYPE_WORLD } from '../../packages/content/src/index.ts';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';

const SEED = 42;

/** Сколько предметов в стартовом мире. Сток единственный, поэтому число обязано только убывать. */
const INITIAL_ITEM_COUNT = PROTOTYPE_WORLD.items.length;

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
 * Доводит мир до горизонта.
 *
 * С I05-B цикл живёт в самой команде: `world tick --until X` крутит очередь, пока в пределах
 * горизонта что-то есть. Раньше он делал один шаг очереди, и звать его приходилось повторно —
 * отсюда и этот помощник. Повторный вызов остаётся: он проверяет ИДЕМПОТЕНТНОСТЬ горизонта —
 * второй проход по доведённому миру обязан честно сказать «нечего обрабатывать».
 */
const tickUntilQuiet = (until: string, databaseUrl: string): number => {
  for (let step = 0; step < 3; step += 1) {
    // Отдельный, увеличенный таймаут: этот помощник гоняет мир на сотни суток вперёд, а шаг
    // очереди с I05-B обрабатывает ОДИН момент мира — так требует последовательность летописи.
    // Двадцати секунд по умолчанию не хватает, и нехватка выглядела как пустой вывод и
    // необъяснимый ненулевой код: так этот тест и упал впервые.
    const tick = spawnWorldCliDirect(['world', 'tick', '--until', until], {
      env: { DATABASE_URL: databaseUrl },
      /**
       * Десять минут, а не пять.
       *
       * Пять были не запасом, а пределом: независимое test-review I04-I06 измерило прогон,
       * сжигавший 300 022 мс, — то есть запас исчислялся долями процента, и под нагрузкой тест
       * падал бы не по своему утверждению, а по бюджету. Это не ослабление проверки: таймаут
       * здесь ловит ЗАВИСАНИЕ, а ни одно утверждение теста не говорит о скорости машины.
       */
      timeoutMs: 600_000,
    });
    if (tick.exitCode !== 0) throw new Error(`world tick упал: ${tick.stdout}${tick.stderr}`);
    if (tick.stdout.includes('Нечего обрабатывать')) return step;
  }
  throw new Error(`мир не успокоился за три вызова до горизонта ${until}`);
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

/** Канонический журнал мира. Читается напрямую: тест разбирает payload, а не текст для человека. */
const journalOf = async (databaseUrl: string): Promise<readonly WorldEvent[]> => {
  const connection = createDatabase(parseDatabaseConnectionUrl(databaseUrl));
  try {
    return await loadWorldEvents(connection, 'world:prototype');
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

  it('порог не пропускается и не повторяется: переходы образуют законную цепочку', async () => {
    // Мир, простоявший ночь, обязан пройти пропущенные пороги ПО ОДНОМУ, а не «догнать» их
    // последним. Проверяется это ЦЕПОЧКОЙ переходов, а не числом событий: как только агент
    // начал есть, число перестало быть постоянной величиной — оно зависит от запаса еды, — а
    // законность цепочки не зависит ни от чего.
    const far = atMinute(minutesTo('hunger', 'critical') * 4);
    tickUntilQuiet(far, db.url);

    const journal = await journalOf(db.url);
    const byActor = new Map<string, { need: string; from: string; to: string }[]>();
    for (const event of journal) {
      if (event.type !== 'need.threshold.crossed') continue;
      const actor = event.actor_ids[0] ?? '';
      const list = byActor.get(actor) ?? [];
      list.push({
        need: event.payload.need,
        from: event.payload.from_level,
        to: event.payload.to_level,
      });
      byActor.set(actor, list);
    }
    expect(byActor.size).toBe(agentCount);

    const RANK: Record<string, number> = { normal: 0, warning: 1, critical: 2 };
    for (const [actor, crossings] of byActor) {
      for (const need of ['hunger', 'fatigue']) {
        const chain = crossings.filter((crossing) => crossing.need === need);
        let level = 'normal';
        for (const crossing of chain) {
          // Каждый переход обязан начинаться там, где закончился предыдущий: иначе в летописи
          // есть шаг, которого мир не совершал, или нет шага, который совершил.
          expect(`${actor}/${need}: ${crossing.from}`).toBe(`${actor}/${need}: ${level}`);
          // Ухудшение — ровно на одну ступень; восстановление — сразу в `normal`.
          const step = RANK[crossing.to]! - RANK[crossing.from]!;
          expect(step === 1 || crossing.to === 'normal').toBe(true);
          level = crossing.to;
        }
      }
    }
  });

  it('голод снимается едой, и еда при этом исчезает из мира ровно по одной', async () => {
    // Наблюдаемая демонстрация итерации: голод растёт → агент ест → голод падает. Команду «поесть»
    // подаёт МИР по достигнутому порогу, а не человек: ни одного `world run` в этом тесте нет.
    const journal = await journalOf(db.url);
    const meals = journal.filter((event) => event.type === 'agent.ate');
    expect(meals.length).toBeGreaterThan(0);

    // Съеденное не съедается дважды — ключевое свойство §6 «нельзя потратить дважды».
    const eaten = meals.map((event) => (event.type === 'agent.ate' ? event.payload.item_id : ''));
    expect(new Set(eaten).size).toBe(eaten.length);

    // Каждая еда сопровождается переходом голода в `normal` в ТОТ ЖЕ момент мира.
    for (const meal of meals) {
      const recovery = journal.find(
        (event) =>
          event.type === 'need.threshold.crossed' &&
          event.payload.need === 'hunger' &&
          event.payload.to_level === 'normal' &&
          event.world_time === meal.world_time &&
          event.actor_ids[0] === meal.actor_ids[0],
      );
      expect(recovery, `у ${String(meal.actor_ids[0])} еда без снятия голода`).toBeDefined();
    }

    // Сток единственный: предметов в мире ровно столько, сколько их было минус съеденные.
    const connection = createDatabase(parseDatabaseConnectionUrl(db.url));
    try {
      const rows = await connection.selectFrom('items').select('item_id').execute();
      expect(rows.length).toBe(INITIAL_ITEM_COUNT - meals.length);
    } finally {
      await connection.destroy();
    }
  });

  it('когда еда кончилась, голод остаётся: мир не кормит агента из ниоткуда', async () => {
    const far = atMinute(200_000);
    tickUntilQuiet(far, db.url);

    const connection = createDatabase(parseDatabaseConnectionUrl(db.url));
    try {
      const rows = await connection.selectFrom('items').select('item_id').execute();
      expect(rows).toHaveLength(0);
    } finally {
      await connection.destroy();
    }

    const journal = await journalOf(db.url);
    const lastHunger = journal
      .filter((event) => event.type === 'need.threshold.crossed' && event.payload.need === 'hunger')
      .at(-1);
    expect(lastHunger?.type === 'need.threshold.crossed' && lastHunger.payload.to_level).toBe(
      'critical',
    );
  });

  it('в расписании не остаётся ничего просроченного', async () => {
    // Если выполненное действие не снимать, новых событий не появится — повтор идемпотентен и
    // вернёт записанный результат, — но сделанное навсегда останется ждущим. По ленте это
    // неотличимо от исправного мира; по расписанию отличимо сразу.
    expect(await overdueActions(db.url, atMinute(200_000))).toEqual([]);
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
