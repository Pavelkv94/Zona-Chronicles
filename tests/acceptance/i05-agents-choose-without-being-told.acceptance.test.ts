/**
 * I05-B — агент выбирает цель сам, и миру больше не нужен человек, чтобы кому-то стало лучше
 * (`docs/iterations/I05-utility-ai/PLAN.md` §2, §7, §9; `07_MVP_MECHANICS_SPEC` §6).
 *
 * Проверяется observable demo итерации целиком, на настоящем мире и через тот же CLI, которым
 * работает оператор:
 *
 * - Given мир создан и НИ ОДНОЙ команды человека в него не подано;
 * - When мировое время идёт;
 * - Then агенты сами решают, что делать, и усталость перестаёт только расти.
 *
 * До этой итерации усталость снималась лишь командой `agent.rest`, а подать её мог только
 * человек — которого в наблюдаемом мире нет (PR-01). Мир был устроен так, что людям в нём
 * становилось только хуже. Именно это утверждение здесь и опровергается.
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
import {
  GOAL_KINDS,
  requireAddMinutes,
  requireInstant,
} from '../../packages/contracts/src/index.ts';
import { PROTOTYPE_NEEDS } from '../../packages/domain/src/ports/ruleset.ts';
import { PROTOTYPE_WORLD } from '../../packages/content/src/index.ts';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';

const SEED = 42;
const WORLD_START = requireInstant(PROTOTYPE_WORLD.initialWorldTime, 'initialWorldTime').iso;

const atMinute = (minutes: number): string =>
  requireAddMinutes(requireInstant(WORLD_START, 'WORLD_START'), minutes, 'горизонт теста').iso;

/** Минуты до порога, посчитанные ИЗ КОЭФФИЦИЕНТОВ, а не выписанные числом. */
const minutesTo = (need: 'hunger' | 'fatigue', level: 'warning' | 'critical'): number => {
  const config = PROTOTYPE_NEEDS[need];
  const permille = level === 'warning' ? config.warningAtPermille : config.criticalAtPermille;
  return Math.ceil((permille * config.minutesToFull) / 1000);
};

const cli = (argv: readonly string[], databaseUrl: string, timeoutMs = 300_000) =>
  spawnWorldCliDirect(argv, { env: { DATABASE_URL: databaseUrl }, timeoutMs });

const journalOf = async (databaseUrl: string): Promise<readonly WorldEvent[]> => {
  const connection = createDatabase(parseDatabaseConnectionUrl(databaseUrl));
  try {
    return await loadWorldEvents(connection, PROTOTYPE_WORLD.worldId);
  } finally {
    await connection.destroy();
  }
};

describe('I05-B — мир перестаёт быть таким, где людям становится только хуже', () => {
  let db: TestDatabase;
  let journal: readonly WorldEvent[] = [];

  beforeAll(async () => {
    db = await createTestDatabase('acceptance_i05_goals');
    expect(cli(['world', 'migrate'], db.url).exitCode).toBe(0);
    const init = cli(['world', 'init', '--seed', String(SEED)], db.url);
    expect(init.exitCode, init.stdout + init.stderr).toBe(0);

    // Двое суток мира. Ни одного `world run`: команду в этом тесте человек не подаёт ВООБЩЕ.
    const until = atMinute(2880);
    const tick = cli(['world', 'tick', '--until', until], db.url);
    expect(tick.exitCode, tick.stdout + tick.stderr).toBe(0);

    journal = await journalOf(db.url);
  }, 600_000);

  afterAll(async () => {
    await db.drop();
  });

  it('агенты отдыхают, и никто им этого не приказывал', () => {
    const rested = journal.filter((event) => event.type === 'agent.rested');
    expect(rested.length).toBeGreaterThan(0);

    // Каждому отдыху предшествует РЕШЕНИЕ того же агента, а не команда: между «лёг» и «решил»
    // стоит факт выбора, и без него отдых был бы приказом.
    for (const start of journal.filter((event) => event.type === 'rest.started')) {
      const actor = start.actor_ids[0] ?? '';
      const decision = journal.find(
        (event) =>
          event.type === 'goal.chosen' &&
          event.actor_ids[0] === actor &&
          event.world_time === start.world_time &&
          event.payload.goal === 'rest',
      );
      expect(decision, `${actor} лёг отдыхать без решения`).toBeDefined();
    }
  });

  it('усталость перестала только расти: у неё появилось восстановление', () => {
    const recovered = journal.filter(
      (event) =>
        event.type === 'need.threshold.crossed' &&
        event.payload.need === 'fatigue' &&
        event.payload.to_level === 'normal',
    );
    // Прямое опровержение прежнего устройства мира: до I05 такого факта не мог породить никто,
    // кроме человека, а человека в наблюдаемом мире нет.
    expect(recovered.length).toBeGreaterThan(0);
  });

  it('решение и его шаг происходят в один момент мира', () => {
    // Иначе летопись читалась бы как «решил поесть в полдень, поел к ночи, в промежутке ничего»
    // — и каждая строка по отдельности выглядела бы правдоподобно. Измерено: до перехода такта
    // на моменты мира разрыв достигал семи часов.
    for (const decision of journal.filter((event) => event.type === 'goal.chosen')) {
      if (decision.type !== 'goal.chosen' || decision.payload.goal === 'idle') continue;
      const actor = decision.actor_ids[0] ?? '';
      const step = journal.find(
        (event) =>
          event.actor_ids[0] === actor &&
          event.world_time === decision.world_time &&
          (event.type === 'rest.started' || event.type === 'agent.ate'),
      );
      expect(
        step,
        `${actor}: цель ${decision.payload.goal} без шага в тот же момент`,
      ).toBeDefined();
    }
  });

  it('занятого агента мир не заставляет передумывать', () => {
    // §4.2 плана: решение назначается тому, кто СВОБОДЕН. Пока агент спит, его нужды переходят
    // пороги — и каждое такое пересечение назначало бы ему решение, если бы занятость не
    // проверялась. Решение вышло бы бессмысленным (ни есть, ни лечь занятому нельзя), но
    // засорило бы летопись и завело бы привычку решать вхолостую.
    //
    // Проверяется ИНТЕРВАЛАМИ, а не количеством: количество решений мутация «решать всегда» не
    // меняет, потому что новое решение вытесняет ждущее.
    for (const start of journal.filter((event) => event.type === 'rest.started')) {
      const actor = start.actor_ids[0] ?? '';
      const end = journal.find(
        (event) =>
          event.type === 'agent.rested' &&
          event.actor_ids[0] === actor &&
          event.world_time > start.world_time,
      );
      if (end === undefined) continue;
      const during = journal.filter(
        (event) =>
          event.type === 'goal.chosen' &&
          event.actor_ids[0] === actor &&
          event.world_time > start.world_time &&
          event.world_time < end.world_time,
      );
      expect(during.map((event) => event.world_time)).toEqual([]);
    }
  });

  it('каждое решение объяснимо: разбор называет все цели, включая неисполнимые', () => {
    const decisions = journal.filter((event) => event.type === 'goal.chosen');
    expect(decisions.length).toBeGreaterThan(0);
    for (const decision of decisions) {
      if (decision.type !== 'goal.chosen') continue;
      const lines = decision.payload.trace.candidates;
      expect(lines.map((line) => line.goal)).toEqual([...GOAL_KINDS]);
      // Слагаемые сходятся с итогом: объяснение не может разойтись с числом, потому что число
      // из объяснения и складывается.
      for (const line of lines) {
        expect(line.score).toBe(line.urgency - line.time_cost - line.switching_cost);
      }
      // Выбранная цель обязана быть исполнимой: цель без шага оставила бы агента стоять.
      const chosen = lines.find((line) => line.goal === decision.payload.goal);
      expect(chosen?.feasible).toBe(true);
    }
  });

  it('решения не размножаются: их не больше, чем фактов, которые агента касаются', () => {
    const byActor = new Map<string, { decisions: number; facts: number }>();
    for (const event of journal) {
      const actor = event.actor_ids[0] ?? '';
      const row = byActor.get(actor) ?? { decisions: 0, facts: 0 };
      if (event.type === 'goal.chosen') row.decisions += 1;
      else row.facts += 1;
      byActor.set(actor, row);
    }
    expect(byActor.size).toBeGreaterThan(0);
    for (const [actor, row] of byActor) {
      // GO-критерий §9: «доля бесконечных replans = 0». Решение, порождающее решение, дало бы
      // мир, крутящийся на месте; здесь это выражено измеримо.
      expect(`${actor}: ${String(row.decisions)} <= ${String(row.facts)}`).toBe(
        `${actor}: ${String(row.decisions)} <= ${String(row.facts)}`,
      );
      expect(row.decisions).toBeLessThanOrEqual(row.facts);
      expect(row.decisions).toBeGreaterThan(0);
    }
  });

  it('одинаковый seed даёт одинаковую историю решений', async () => {
    // STOP-условие итерации: «одинаковые агенты ведут себя случайно при одном seed». Проверяется
    // ВТОРЫМ миром, собранным тем же seed, а не повтором чтения того же журнала.
    const twin = await createTestDatabase('acceptance_i05_goals_twin');
    try {
      expect(cli(['world', 'migrate'], twin.url).exitCode).toBe(0);
      expect(cli(['world', 'init', '--seed', String(SEED)], twin.url).exitCode).toBe(0);
      expect(cli(['world', 'tick', '--until', atMinute(2880)], twin.url).exitCode).toBe(0);

      const other = await journalOf(twin.url);
      const shape = (events: readonly WorldEvent[]): readonly string[] =>
        events
          .filter((event) => event.type === 'goal.chosen')
          .map((event) =>
            event.type === 'goal.chosen'
              ? `${event.world_time} ${String(event.actor_ids[0])} ${event.payload.goal}`
              : '',
          );
      expect(shape(other)).toEqual(shape(journal));
      expect(shape(journal).length).toBeGreaterThan(0);
    } finally {
      await twin.drop();
    }
  }, 600_000);

  it('порог усталости выше нуля: сценарий вообще успел до него дойти', () => {
    // Страховка от теста, который прошёл бы на пустом мире: если бы горизонт не покрывал первый
    // порог, все утверждения выше стали бы утверждениями о пустом множестве.
    expect(minutesTo('fatigue', 'warning')).toBeLessThan(2880);
  });
});
