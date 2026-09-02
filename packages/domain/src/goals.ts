/**
 * Utility AI: оценка целей и отбор (I05, `07_MVP_MECHANICS_SPEC` §6).
 *
 * Чистая функция от СИТУАЦИИ и коэффициентов. Ни состояния мира целиком, ни часов, ни
 * случайности: выбор обязан быть воспроизводим по своим входам, иначе «одинаковые агенты при
 * одном seed ведут себя одинаково» — STOP-условие итерации — нечем проверить.
 *
 * ## Что вошло в оценку и почему не всё
 *
 * §6 перечисляет восемь слагаемых. Здесь три — те, для которых в мире ЕСТЬ входы:
 *
 * ```text
 * score(goal) = urgency - time_cost - switching_cost
 * ```
 *
 * `expected_value` исключён не по объёму работ: обе цели этого среза снимают свою нужду
 * ПОЛНОСТЬЮ, поэтому ожидаемая польза совпала бы со срочностью до последней тысячной. Это не
 * слагаемое, а второе имя того же числа, и его присутствие делало бы разбор решения вдвое
 * убедительнее, ничего не объясняя. `personality_fit`, `relationship_pressure`,
 * `obligation_pressure` и `risk_cost` вводятся итерациями, которые вводят их входы (I06/I07/I09).
 *
 * ## Гистерезис и switching_cost — один механизм, а не два
 *
 * §6 называет их по отдельности: слагаемое `switching_cost` в формуле и правило «агент не
 * меняет цель, пока новая не лучше текущей на `switch_margin`». Реализованы они одним
 * вычитанием, и это решение, а не срез угла: вычесть margin из каждого кандидата, отличного от
 * текущей цели, и взять максимум — это ТОЖДЕСТВЕННО правилу порога. Завести их порознь значило
 * бы вычесть один и тот же порог дважды и получить агента, который вдвое неохотнее меняет цель,
 * чем объявлено в ruleset.
 *
 * В этом срезе текущей целью в момент решения почти всегда оказывается `idle` — цель
 * потребляется своим шагом, — поэтому слагаемое читается как «порог, ниже которого нужда не
 * стоит того, чтобы что-то начинать». Названо это здесь честно: механизм общий, а его нынешнее
 * прочтение узкое, и когда планы станут длиннее одного шага, оно расширится само.
 */
import {
  GOAL_KINDS,
  GOAL_SCORE_UNIT,
  NEED_LEVELS,
  goalRank,
  type DecisionTrace,
  type GoalKind,
  type GoalScoreLine,
  type NeedKind,
  type NeedLevel,
} from '@zona/contracts';

const MINUTES_PER_HOUR = 60;

/**
 * Коэффициенты выбора цели. Живут в versioned ruleset (ADR-003) и приходят сюда портом.
 *
 * Все величины — ЦЕЛЫЕ в тысячных, по той же причине, что пороги нужд: ruleset входит в rules
 * bundle, а `canonicalize` отвергает дробное число. Обнаружено исполнением в I04, повторять не
 * обязательно.
 */
export interface GoalWeights {
  /** Срочность по уровню нужды, тысячные. Не убывает с ухудшением уровня. */
  readonly urgencyPermille: Readonly<Record<NeedLevel, number>>;
  /** Цена занятости: тысячных за час мирового времени. */
  readonly timeCostPermillePerHour: number;
  /** `switch_margin` §6: тысячные, на которые новая цель обязана превзойти текущую. */
  readonly switchMarginPermille: number;
}

/**
 * Верхняя граница длительности действия, которую коэффициенты обязаны выдерживать.
 *
 * Неделя мирового времени. Граница существует не ради приличия: без неё цена времени
 * неограничена, и утверждение «оценка лежит в объявленном диапазоне» перестало бы быть
 * свойством функции, превратившись в свойство удачно подобранного ruleset.
 */
export const MAX_GOAL_DURATION_MINUTES = 10_080;

/** Максимум тысячных у любого коэффициента: тысячная доля от единицы — это 1000. */
const MAX_PERMILLE = 1000;

/**
 * Проверка коэффициентов — ГРОМКАЯ и в одном месте, как у нужд.
 *
 * Отдельно проверяется НЕУБЫВАНИЕ срочности по уровням. Коэффициенты, у которых `warning`
 * срочнее `critical`, дали бы агента, успокаивающегося по мере ухудшения, — и ни один тест
 * поведения не назвал бы это дефектом, потому что мир остался бы внутренне непротиворечивым.
 */
export function requireValidGoalWeights(weights: GoalWeights, label: string): GoalWeights {
  const permilles = [
    weights.timeCostPermillePerHour,
    weights.switchMarginPermille,
    ...NEED_LEVELS.map((level) => weights.urgencyPermille[level]),
  ];
  for (const value of permilles) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PERMILLE) {
      throw new Error(
        `ruleset: коэффициенты "${label}" обязаны быть целыми тысячными в [0, ${MAX_PERMILLE}], ` +
          `получено ${String(value)}`,
      );
    }
  }
  for (let index = 1; index < NEED_LEVELS.length; index += 1) {
    const previous = weights.urgencyPermille[NEED_LEVELS[index - 1] as NeedLevel];
    const current = weights.urgencyPermille[NEED_LEVELS[index] as NeedLevel];
    if (current < previous) {
      throw new Error(
        `ruleset: срочность "${label}" убывает с ухудшением уровня ` +
          `(${NEED_LEVELS[index - 1] as string}=${String(previous)} > ` +
          `${NEED_LEVELS[index] as string}=${String(current)}): агент успокаивался бы, ` +
          'когда ему становится хуже',
      );
    }
  }
  return weights;
}

/**
 * Что мир знает об агенте в момент решения.
 *
 * Именно СИТУАЦИЯ, а не `WorldState`: оценка не должна иметь доступа к тому, чего агент не
 * знает о себе, и не должна расти в объёме вместе с миром. Сборка ситуации — работа `decide`,
 * и она проверяема отдельно от арифметики выбора.
 */
export interface GoalSituation {
  /** Цель, которой агент придерживается сейчас. Определяет, кому достаётся `switching_cost`. */
  readonly currentGoal: GoalKind;
  readonly needLevels: Readonly<Record<NeedKind, NeedLevel>>;
  /** Есть ли у агента съедобное. Исполнимость цели `eat`, а не её оценка. */
  readonly hasFood: boolean;
  /** Свободен ли агент. Занятому нельзя начать ни есть, ни отдыхать. */
  readonly isIdle: boolean;
  /** Сколько мирового времени займёт отдых. Приходит из ruleset через `decide`. */
  readonly restMinutes: number;
}

export interface GoalDecision {
  readonly goal: GoalKind;
  readonly trace: DecisionTrace;
}

/**
 * Цена мирового времени, ОКРУГЛЁННАЯ ВВЕРХ.
 *
 * Направление округления выбрано так, чтобы цена никогда не занижалась: заниженная цена делает
 * долгое действие чуть привлекательнее, чем объявлено в ruleset, и расхождение проявляется
 * только на границе — то есть в редком случае, который потом объясняют «плавающей точкой».
 */
function timeCostOf(minutes: number, weights: GoalWeights): number {
  return Math.ceil((minutes * weights.timeCostPermillePerHour) / MINUTES_PER_HOUR);
}

/** Нужда, которую снимает цель; у `idle` её нет, поэтому срочность нулевая. */
function needOf(goal: GoalKind): NeedKind | null {
  if (goal === 'eat') return 'hunger';
  if (goal === 'rest') return 'fatigue';
  return null;
}

/**
 * Длительность цели в мировых минутах.
 *
 * У еды — ноль, и это НАЗВАННОЕ упрощение, а не забытая величина: приём пищи в этом мире
 * мгновенен (I04), поэтому цена его времени честно равна нулю. Когда у еды появится
 * длительность, она придёт из ruleset тем же путём, что длительность отдыха.
 */
function durationOf(goal: GoalKind, situation: GoalSituation): number {
  return goal === 'rest' ? situation.restMinutes : 0;
}

/**
 * Есть ли у цели исполнимый первый шаг ЗДЕСЬ И СЕЙЧАС.
 *
 * Исполнимость входит в ОТБОР, а не проверяется после выбора, и это решение из §4.3 плана
 * итерации. Цель, для которой шага нет, — не кандидат с низкой оценкой, а вовсе не кандидат.
 * Иначе агент выбирал бы недостижимое, оставался свободным, получал новое решение — и мир
 * крутился бы, не породив ни одного факта.
 *
 * `idle` исполним ВСЕГДА: пустой набор кандидатов законным исходом быть не может, потому что
 * «ничего не делать» доступно любому.
 */
function isFeasible(goal: GoalKind, situation: GoalSituation): boolean {
  if (goal === 'idle') return true;
  if (!situation.isIdle) return false;
  if (goal === 'eat') return situation.hasFood;
  return true;
}

/** Одна строка разбора: слагаемые считаются и для неисполнимых целей (см. `goal.ts`). */
function lineFor(goal: GoalKind, situation: GoalSituation, weights: GoalWeights): GoalScoreLine {
  const need = needOf(goal);
  const urgency = need === null ? 0 : weights.urgencyPermille[situation.needLevels[need]];
  const timeCost = timeCostOf(durationOf(goal, situation), weights);
  const switchingCost = goal === situation.currentGoal ? 0 : weights.switchMarginPermille;
  return {
    goal,
    feasible: isFeasible(goal, situation),
    urgency,
    time_cost: timeCost,
    switching_cost: switchingCost,
    score: urgency - timeCost - switchingCost,
  };
}

/**
 * Выбор цели и разбор, его объясняющий.
 *
 * Победитель — исполнимый кандидат с наибольшей оценкой; при равенстве выигрывает объявленный
 * раньше в `GOAL_KINDS`. Tie-break задан ПОРЯДКОМ ОБЪЯВЛЕНИЯ, а не порядком перебора: второе
 * зависело бы от того, как написан цикл, и переставленные местами кандидаты дали бы другой мир
 * при том же seed. Проверяется пробой, переставляющей кандидатов.
 */
export function chooseGoal(situation: GoalSituation, weights: GoalWeights): GoalDecision {
  const candidates = GOAL_KINDS.map((goal) => lineFor(goal, situation, weights));

  let best: GoalScoreLine | null = null;
  for (const line of candidates) {
    if (!line.feasible) continue;
    if (best === null || line.score > best.score) {
      best = line;
      continue;
    }
    if (line.score === best.score && goalRank(line.goal) < goalRank(best.goal)) {
      best = line;
    }
  }

  if (best === null) {
    // `idle` исполним всегда, поэтому сюда попасть нельзя. Отказ громкий: молчаливый `idle`
    // скрыл бы дефект `isFeasible`, при котором агент перестал бы выбирать вовсе.
    throw new Error('goals: не нашлось ни одного исполнимого кандидата, включая "idle"');
  }

  return { goal: best.goal, trace: { candidates } };
}

/**
 * Границы оценки, объявленные единицей `GOAL_SCORE_UNIT`.
 *
 * Вынесены сюда, чтобы property-тест сверял функцию с ОБЪЯВЛЕННЫМ диапазоном, а не с числами,
 * переписанными в тест. Конечность проверяется отдельно: `NaN` проходит оба сравнения границ
 * как ложь, поэтому проверка «в диапазоне» его не ловит — урок I04.
 */
export const GOAL_SCORE_BOUNDS = {
  min: GOAL_SCORE_UNIT.min,
  max: GOAL_SCORE_UNIT.max,
} as const;
