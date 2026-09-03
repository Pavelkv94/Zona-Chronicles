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
  /**
   * Во сколько агент оценивает опасность дороги, о которой ничего не знает (I06, §8).
   *
   * Так выражен `uncertainty_penalty` формулы §8 — предполагаемым риском, а НЕ отдельным
   * штрафом. Два множителя за одно и то же взяли бы двойную плату: осторожность уже умножает
   * воспринимаемый риск, и неизвестная дорога дорожает для пугливого агента сама собой.
   *
   * Значение обязано быть таким, чтобы уход в неизвестность оставался возможным. Слишком
   * высокое даёт мир, где никто не трогается с места, пока не узнает дорогу, — а узнать её,
   * не пройдя, нельзя.
   */
  readonly assumedUnknownRiskPermille: number;
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
  const permillesWithUnknown = [...permilles, weights.assumedUnknownRiskPermille];
  for (const value of permillesWithUnknown) {
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
  /**
   * Опасность места, где агент находится, в тысячных (I06-C).
   *
   * Это единственная опасность, которую агент знает БЕЗ памяти: он здесь, и место вокруг него.
   * Знание о дорогах — другое дело, оно требует того, чтобы по ним прошли.
   */
  readonly locationRisk: number;
  /**
   * Дороги, доступные отсюда, — И ТОЛЬКО ТО, ЧТО АГЕНТ О НИХ ЗНАЕТ.
   *
   * Здесь проходит граница, ради которой вся итерация и затевалась. Канонической опасности
   * дороги в ситуации нет вовсе: `perceivedRisk === null` означает «не знает», и подставить сюда
   * настоящее значение — это и есть тот утёк, который объявлен STOP-условием. Проверяется
   * свойством: изменение канона неизвестных дорог не меняет выбора.
   */
  readonly travelOptions: readonly TravelOption[];
}

/** Дорога глазами агента: длина известна всем, опасность — только тому, кто по ней ходил. */
export interface TravelOption {
  readonly routeId: string;
  readonly travelMinutes: number;
  /** `null` — агент об этой дороге ничего не знает. НЕ ноль: незнание это не безопасность. */
  readonly perceivedRisk: number | null;
}

/** Цена дороги глазами агента: длина плюс страх, умноженный на осторожность (§8). */
export interface RouteCost {
  readonly routeId: string;
  readonly cost: number;
}

/**
 * Дорога, которую агент выберет отсюда, либо `null`, если идти некуда.
 *
 * Дешевле — лучше; при равной цене выигрывает дорога с меньшим id. Порядок задан ключом, а не
 * порядком перебора: второе зависело бы от того, как собран список, и переставленные местами
 * дороги дали бы другой мир при том же seed.
 */
export function chooseRoute(
  options: readonly TravelOption[],
  weights: GoalWeights,
  caution: number,
): RouteCost | null {
  let best: RouteCost | null = null;
  for (const option of options) {
    const cost = routeCost(option, weights, caution);
    if (
      best === null ||
      cost < best.cost ||
      (cost === best.cost && option.routeId < best.routeId)
    ) {
      best = { routeId: option.routeId, cost };
    }
  }
  return best;
}

/**
 * Цена одной дороги.
 *
 * Осторожность умножает ИМЕННО воспринимаемый риск, а не всю цену: бояться можно опасности, а не
 * расстояния. Умножение всей цены сделало бы пугливого агента ещё и домоседом, и различить эти
 * два свойства в поведении стало бы невозможно.
 */
function routeCost(option: TravelOption, weights: GoalWeights, caution: number): number {
  const perceived = option.perceivedRisk ?? weights.assumedUnknownRiskPermille;
  const durationCost = timeCostOf(option.travelMinutes, weights);
  return durationCost + Math.ceil((perceived * caution) / PERMILLE);
}

/** Тысяча — нейтральный множитель. Один литерал на весь модуль, а не число в трёх местах. */
const PERMILLE = 1000;

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

/** Нужда, которую снимает цель; у `idle` и `flee` её нет — они не о теле. */
function needOf(goal: GoalKind): NeedKind | null {
  if (goal === 'eat') return 'hunger';
  if (goal === 'rest') return 'fatigue';
  return null;
}

/**
 * Срочность цели «уйти» — это опасность места, где агент стоит (I06-C).
 *
 * Читается напрямую, без ступеней по уровням, — в отличие от нужд. Разница не в произволе:
 * значение нужды это ИЗМЕРЕНИЕ, которое дрейфует между двумя соседними минутами, а опасность
 * места — свойство мира, постоянное, пока мир его не изменил. Решение по нему не «плавает».
 */
function fleeUrgency(situation: GoalSituation): number {
  return situation.locationRisk;
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
 * Цена цели «уйти» — это цена ЛУЧШЕЙ доступной дороги (§8).
 *
 * Решить уйти, не зная куда, нельзя: «уйти» и «выбрать дорогу» — одно решение, а не два. Поэтому
 * стоимость дороги входит в оценку цели, а не считается потом. Если идти некуда, цели нет вовсе
 * — это выражено исполнимостью, а не бесконечной ценой.
 */
function fleeCost(situation: GoalSituation, weights: GoalWeights, caution: number): number {
  return chooseRoute(situation.travelOptions, weights, caution)?.cost ?? 0;
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
  // Уйти можно только туда, куда есть дорога. Место без выхода — не «дорого уходить», а некуда.
  if (goal === 'flee') return situation.travelOptions.length > 0;
  return true;
}

/** Одна строка разбора: слагаемые считаются и для неисполнимых целей (см. `goal.ts`). */
function lineFor(
  goal: GoalKind,
  situation: GoalSituation,
  weights: GoalWeights,
  caution: number,
): GoalScoreLine {
  const need = needOf(goal);
  const urgency =
    goal === 'flee'
      ? fleeUrgency(situation)
      : need === null
        ? 0
        : weights.urgencyPermille[situation.needLevels[need]];
  const timeCost =
    goal === 'flee'
      ? fleeCost(situation, weights, caution)
      : timeCostOf(durationOf(goal, situation), weights);
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
export function chooseGoal(
  situation: GoalSituation,
  weights: GoalWeights,
  caution: number,
): GoalDecision {
  const candidates = GOAL_KINDS.map((goal) => lineFor(goal, situation, weights, caution));

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
