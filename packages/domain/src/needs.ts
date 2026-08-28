/**
 * Нужды тела как ПРОИЗВОДНЫЕ величины (I04, `07_MVP_MECHANICS_SPEC` §5).
 *
 * Каноническим состоянием является момент отсчёта — когда агент последний раз ел или отдыхал.
 * Значение нужды им не является: оно вычисляется здесь, чистой функцией от момента отсчёта,
 * текущего мирового времени и коэффициентов ruleset.
 *
 * Так решён спор, из-за которого §5 пришлось переписать. Pulse, меняющий значение молча, ломает
 * replay: состояние перестаёт быть функцией журнала. Pulse, публикующий событие на каждый шаг,
 * упирается в собственное STOP-условие итерации — непросматриваемый поток фактов. Здесь между
 * порогами не происходит НИЧЕГО: ни события, ни изменения состояния. Момент следующего
 * пересечения вычислим заранее из той же функции, поэтому он планируется обычным
 * `ScheduledAction`, и на каждое пересечение приходится ровно одно событие.
 *
 * Цена названа в §5 спецификации: функция обязана быть монотонной и обратимой между порогами.
 * Линейный рост это выполняет; нелинейный потребует кусочной линеаризации или возврата к pulse-ам.
 */
import {
  NEED_FRACTION_UNIT,
  isInstantError,
  needLevelRank,
  parseCanonicalInstant,
  requireAddMinutes,
  type NeedLevel,
} from '@zona/contracts';

/**
 * Коэффициенты одной нужды.
 *
 * Пороги хранятся в MINOR UNITS единицы `NEED_FRACTION_UNIT` — тысячных, — а не долями единицы,
 * и это требование канонической сериализации, а не стиль: ruleset входит в rules bundle, а
 * `canonicalize` отвергает дробное число («каноническое значение обязано быть целым; дробные
 * величины кодируются в minor units по documented unit»). Обнаружено исполнением: `0.75` в
 * коэффициентах уронил построение генезисного снимка целиком.
 *
 * Сравнение с порогом ведётся тоже в целых (см. `needLevelOf`): деление на 1000 вернуло бы ту же
 * дробь и ту же зависимость от округления платформы, ради избавления от которой всё и сделано.
 */
export interface NeedConfig {
  /** Мировых минут от момента отсчёта до значения 1. Положительное безопасное целое. */
  readonly minutesToFull: number;
  /** Порог `warning` в тысячных: 450 — это 0.45 из §5. */
  readonly warningAtPermille: number;
  /** Порог `critical` в тысячных: 750 — это 0.75 из §5. */
  readonly criticalAtPermille: number;
}

const MS_PER_MINUTE = 60_000;

/**
 * Проверка коэффициентов — ГРОМКАЯ и в одном месте.
 *
 * Ruleset приходит данными, а не кодом, и порог 1.5 или отрицательная длительность не являются
 * доменным отказом, который можно вернуть вызывающему: это дефект bundle-а правил. Молча он
 * дал бы нужду, которая никогда не пересекает порог, — то есть мир, где голод не наступает, и
 * ни один тест поведения этого бы не назвал.
 */
export function requireValidNeedConfig(config: NeedConfig, label: string): NeedConfig {
  if (!Number.isSafeInteger(config.minutesToFull) || config.minutesToFull <= 0) {
    throw new Error(
      `ruleset: "${label}".minutesToFull обязан быть положительным целым числом минут, ` +
        `получено ${String(config.minutesToFull)}`,
    );
  }
  const full = NEED_FRACTION_UNIT.max;
  const thresholdsValid =
    Number.isSafeInteger(config.warningAtPermille) &&
    Number.isSafeInteger(config.criticalAtPermille) &&
    config.warningAtPermille > 0 &&
    config.warningAtPermille < config.criticalAtPermille &&
    config.criticalAtPermille <= full;
  if (!thresholdsValid) {
    throw new Error(
      `ruleset: пороги "${label}" обязаны быть целыми тысячными и возрастать в пределах ` +
        `(0, ${String(full)}]: получено warningAtPermille=${String(config.warningAtPermille)}, ` +
        `criticalAtPermille=${String(config.criticalAtPermille)}`,
    );
  }
  return config;
}

function epochMsOf(iso: string, label: string): number {
  const instant = parseCanonicalInstant(iso);
  if (isInstantError(instant)) {
    throw new Error(`needs: ${label} невалиден: ${instant.error}`);
  }
  return instant.epochMs;
}

/**
 * Значение нужды в момент `atIso`: доля пути от момента отсчёта до единицы.
 *
 * Результат всегда в `[0, 1]` — включая момент раньше отсчёта. Такой момент означает нарушение
 * причинности, но отрицательная нужда не имеет уровня, и потребитель сломался бы молча; ноль
 * — единственное значение, которое остаётся осмысленным.
 */
export function needValueAt(baselineIso: string, atIso: string, config: NeedConfig): number {
  const elapsedMs = epochMsOf(atIso, 'момент измерения') - epochMsOf(baselineIso, 'момент отсчёта');
  if (elapsedMs <= 0) return 0;
  const fullMs = config.minutesToFull * MS_PER_MINUTE;
  return elapsedMs >= fullMs ? 1 : elapsedMs / fullMs;
}

/**
 * Уровень нужды по порогам §5: `normal < warning <= warning < critical <= critical`.
 *
 * Сравнение переводит ЗНАЧЕНИЕ в тысячные, а не порог в долю: порог — точное целое, значение —
 * результат деления, и сравнивать надо в той системе, где хотя бы одна сторона точна.
 */
export function needLevelOf(value: number, config: NeedConfig): NeedLevel {
  const permille = value * NEED_FRACTION_UNIT.minorUnitsPerMajor;
  if (permille >= config.criticalAtPermille) return 'critical';
  if (permille >= config.warningAtPermille) return 'warning';
  return 'normal';
}

export function needLevelAt(baselineIso: string, atIso: string, config: NeedConfig): NeedLevel {
  return needLevelOf(needValueAt(baselineIso, atIso, config), config);
}

/** Порог в тысячных, с которого начинается уровень; у `normal` начала нет. */
function thresholdOf(level: NeedLevel, config: NeedConfig): number | null {
  if (level === 'warning') return config.warningAtPermille;
  if (level === 'critical') return config.criticalAtPermille;
  return null;
}

/** Следующий уровень по порядку ухудшения; у крайнего следующего нет. */
function worseThan(level: NeedLevel): NeedLevel | null {
  if (level === 'normal') return 'warning';
  if (level === 'warning') return 'critical';
  return null;
}

export interface NeedThresholdCrossing {
  readonly level: NeedLevel;
  /** Каноническая ISO-метка мирового времени первого момента, когда уровень стал `level`. */
  readonly at: string;
}

/**
 * Момент СЛЕДУЮЩЕГО пересечения после уровня `fromLevel`, либо `null` у крайнего уровня.
 *
 * Момент округляется ВВЕРХ до целой минуты, и это не потеря точности, а единица мира: сдвиг
 * момента определён только на целых минутах (`addMinutes`, M1), а дробная минута молча
 * округлилась бы, разведя текст метки и её число. Округление вверх выбрано так, чтобы в
 * запланированный момент уровень уже сменился: округление вниз дало бы событие о переходе,
 * которого в данных мира ещё нет. Проверяется тестом «расписание согласовано с самой функцией
 * нужды», а не подразумевается.
 */
export function nextThresholdCrossing(
  baselineIso: string,
  fromLevel: NeedLevel,
  config: NeedConfig,
): NeedThresholdCrossing | null {
  const nextLevel = worseThan(fromLevel);
  if (nextLevel === null) return null;

  const threshold = thresholdOf(nextLevel, config);
  if (threshold === null) return null;

  const baseline = parseCanonicalInstant(baselineIso);
  if (isInstantError(baseline)) {
    throw new Error(`needs: момент отсчёта невалиден: ${baseline.error}`);
  }

  const minutes = Math.ceil(
    (threshold * config.minutesToFull) / NEED_FRACTION_UNIT.minorUnitsPerMajor,
  );
  return {
    level: nextLevel,
    at: requireAddMinutes(baseline, minutes, `порог ${nextLevel}`).iso,
  };
}

/**
 * Уровень, непосредственно предшествующий данному в порядке УХУДШЕНИЯ; у первого его нет.
 *
 * Нужен, чтобы `from_level` запланированного пересечения выводился из порядка уровней, а не
 * вычислялся по `worldTime` состояния. Разница не косметическая: мировое время двигают события
 * ЛЮБЫХ агентов, поэтому событие соседа, попавшее в ту же пачку, могло сдвинуть время ровно на
 * момент пересечения — и вычисленный «прежний уровень» совпал бы с новым, а законное действие
 * было бы отвергнуто как «перехода не произошло». Цепочка порогов строго последовательна, и
 * предыдущий уровень известен из неё точно.
 */
export function betterThan(level: NeedLevel): NeedLevel | null {
  if (level === 'critical') return 'warning';
  if (level === 'warning') return 'normal';
  return null;
}

/** Уровень ухудшился, а не восстановился. Направление перехода без отдельного поля в факте. */
export function isWorsening(from: NeedLevel, to: NeedLevel): boolean {
  return needLevelRank(to) > needLevelRank(from);
}
