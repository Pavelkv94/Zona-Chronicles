import { describe, expect, it } from 'vitest';
import { NEED_LEVELS, requireAddMinutes, requireInstant } from '@zona/contracts';
import { needLevelAt, needValueAt, nextThresholdCrossing, type NeedConfig } from './needs.ts';

/** Сутки мировых минут до значения 1; пороги — умолчания §5. */
const CONFIG: NeedConfig = { minutesToFull: 1440, warningAtPermille: 450, criticalAtPermille: 750 };
const BASELINE = '2028-04-26T06:00:00.000Z';

/**
 * Сдвиг момента ТЕМИ ЖЕ средствами, что использует продукт (`requireAddMinutes`), а не
 * `Date.parse`: правило `no-restricted-syntax` запрещает часы платформы и в тестах, и это не
 * формальность — тест, считающий время по-своему, проверял бы согласие с собственной арифметикой.
 */
const plusMinutes = (minutes: number): string =>
  requireAddMinutes(requireInstant(BASELINE, 'BASELINE'), minutes, 'сдвиг теста').iso;

const epochMsOf = (iso: string): number => requireInstant(iso, 'момент теста').epochMs;

describe('значение нужды — чистая функция от момента отсчёта', () => {
  it('растёт линейно: ноль в момент отсчёта, половина на середине, единица в конце', () => {
    expect(needValueAt(BASELINE, BASELINE, CONFIG)).toBe(0);
    expect(needValueAt(BASELINE, plusMinutes(720), CONFIG)).toBe(0.5);
    expect(needValueAt(BASELINE, plusMinutes(1440), CONFIG)).toBe(1);
  });

  it('не превышает единицу, сколько бы времени ни прошло (bounded needs)', () => {
    expect(needValueAt(BASELINE, plusMinutes(1_000_000), CONFIG)).toBe(1);
  });

  it('момент раньше отсчёта даёт ноль, а не отрицательное значение', () => {
    // Такой момент — нарушение причинности, а не входные данные. Значение обязано остаться в
    // [0, 1]: отрицательная нужда не имеет уровня, и любой потребитель сломался бы молча.
    expect(needValueAt(BASELINE, plusMinutes(-60), CONFIG)).toBe(0);
  });
});

describe('уровень нужды определяется порогами ruleset', () => {
  it.each([
    [0, 'normal'],
    [647, 'normal'],
    [648, 'warning'],
    [1079, 'warning'],
    [1080, 'critical'],
    [1440, 'critical'],
  ])('через %s минут уровень %s', (minutes, expected) => {
    expect(needLevelAt(BASELINE, plusMinutes(minutes), CONFIG)).toBe(expected);
  });
});

describe('расписание согласовано с самой функцией нужды', () => {
  // Главное свойство итерации. Момент, который планируется как «следующее пересечение», обязан
  // быть ПЕРВОЙ минутой, когда уровень действительно сменился. Разойдись эти два вычисления —
  // и мир публиковал бы событие о переходе, которого в его собственных данных ещё нет.
  // Второй набор коэффициентов — не для полноты, а потому что первый НЕ ИЗМЕРЯЕТ направление
  // округления: 0.45 * 1440 и 0.75 * 1440 попадают ровно на целые минуты, и `ceil` там равен
  // `floor`. Проба мутацией это показала — подмена `Math.ceil` на `Math.floor` не роняла ни
  // одного теста. Здесь пороги на целые минуты НЕ попадают: 0.45 * 7 = 3.15.
  const CONFIGS: readonly [string, NeedConfig][] = [
    ['пороги на целых минутах', CONFIG],
    [
      'пороги между минутами',
      { minutesToFull: 7, warningAtPermille: 450, criticalAtPermille: 750 },
    ],
  ];

  it.each(
    CONFIGS.flatMap(([label, config]) =>
      (['normal', 'warning'] as const).map((from) => [label, from, config] as const),
    ),
  )('%s: от уровня %s планируется настоящее пересечение', (_label, from, config) => {
    const crossing = nextThresholdCrossing(BASELINE, from, config);
    if (crossing === null) throw new Error(`ожидалось пересечение после уровня ${from}`);

    const oneMinuteEarlier = requireAddMinutes(
      requireInstant(crossing.at, 'момент пересечения'),
      -1,
      'минута до пересечения',
    ).iso;
    expect(needLevelAt(BASELINE, crossing.at, config)).toBe(crossing.level);
    expect(needLevelAt(BASELINE, oneMinuteEarlier, config)).toBe(from);
  });

  it('после крайнего уровня следующего порога нет: событий больше не будет', () => {
    expect(nextThresholdCrossing(BASELINE, 'critical', CONFIG)).toBeNull();
  });

  it('пересечение планируется строго после момента отсчёта', () => {
    for (const level of NEED_LEVELS) {
      const crossing = nextThresholdCrossing(BASELINE, level, CONFIG);
      if (crossing === null) continue;
      expect(epochMsOf(crossing.at)).toBeGreaterThan(epochMsOf(BASELINE));
    }
  });
});
