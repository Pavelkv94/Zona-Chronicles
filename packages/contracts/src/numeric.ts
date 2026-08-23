/**
 * Единицы измерения, диапазоны и округление (A5, SIM-01, `07_MVP_MECHANICS_SPEC` §7).
 *
 * Требование §7 буквально: «физические количества, деньги, время, вероятность и коэффициенты
 * имеют документированную единицу, диапазон и правило округления. Для сохраняемых
 * ресурсов/цен предпочтительны целые minor units или fixed-point; `NaN`, `Infinity`, неявное
 * locale-округление и сравнение на точное равенство вычисленных float запрещены».
 *
 * Отсюда три решения, каждое из которых закрывает конкретный способ потерять детерминизм.
 *
 * 1. **Каноническое значение всегда целое в minor units.** «Дробного канонического числа»
 *    не существует: величина с двумя знаками после точки хранится как целое число сотых.
 *    Поэтому `canonical-json` вправе отвергать любое нецелое число — не как перестраховку,
 *    а потому что канонические данные его не содержат по построению.
 *
 * 2. **Разбор десятичного значения идёт по строке, а не через умножение float.**
 *    `0.29 * 100 === 28.999999999999996`; реализация через умножение либо потеряла бы копейку,
 *    либо потребовала бы неявного допуска — то есть ровно того неописанного округления,
 *    которое A5 запрещает. Разбор по строке точен и не зависит от того, как значение было
 *    получено.
 *
 * 3. **Округление — именованная операция с обязательным режимом.** Функции «округли как-нибудь»
 *    нет. `roundToMinorUnits` требует режим третьим аргументом, и режим применяется к ТОЧНОЙ
 *    десятичной записи числа (`String(value)` — по ECMA-262 кратчайшая запись, дающая то же
 *    двоичное значение, и она не зависит от локали), а не к результату умножения. Иначе
 *    «half-even от 1.005» зависело бы от того, что `1.005 * 100` в двоичной арифметике равно
 *    `100.49999999999999`, и режим округления фактически не применялся бы никогда.
 */

/** Допустимые режимы округления. Режим обязателен: «по умолчанию» округления не существует. */
export const NUMERIC_ROUNDING_MODES = [
  'half-even',
  'half-away-from-zero',
  'floor',
  'ceil',
] as const;

export type NumericRoundingMode = (typeof NUMERIC_ROUNDING_MODES)[number];

export interface NumericUnit {
  /** Стабильный идентификатор единицы: `count.sequence`, `time.second`. */
  readonly id: string;
  readonly description: string;
  /** Сколько minor units в одной major unit; 1 означает целочисленную величину. */
  readonly minorUnitsPerMajor: number;
  /** Нижняя граница В MINOR UNITS, включительно. */
  readonly min: number;
  /** Верхняя граница В MINOR UNITS, включительно. */
  readonly max: number;
}

export interface NumericError {
  readonly error: string;
}

export function isNumericError(result: number | NumericError): result is NumericError {
  return typeof result === 'object';
}

/** Число знаков после точки, которое допускает единица. */
function decimalPlaces(unit: NumericUnit): number {
  return Math.round(Math.log10(unit.minorUnitsPerMajor));
}

/**
 * Создаёт единицу, проверяя само определение. Некорректное определение — ошибка программиста
 * на этапе загрузки модуля, а не данные, поэтому здесь бросается исключение, а не `{ error }`.
 */
export function defineNumericUnit(definition: NumericUnit): NumericUnit {
  const { id, description, minorUnitsPerMajor, min, max } = definition;
  if (id.length === 0) {
    throw new Error('единица измерения обязана иметь непустой id');
  }
  if (description.length === 0) {
    throw new Error(`единица "${id}" обязана иметь описание: A5 требует документированной единицы`);
  }
  if (!Number.isSafeInteger(minorUnitsPerMajor) || minorUnitsPerMajor < 1) {
    throw new Error(`масштаб единицы "${id}" обязан быть целым >= 1`);
  }
  if (10 ** Math.round(Math.log10(minorUnitsPerMajor)) !== minorUnitsPerMajor) {
    // Только степени десяти: иначе «знаков после точки» не существует и правило
    // «значение точнее единицы отвергается» становится неформулируемым.
    throw new Error(
      `масштаб единицы "${id}" обязан быть степенью десяти, получено ${minorUnitsPerMajor}`,
    );
  }
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    throw new Error(`границы единицы "${id}" обязаны быть безопасными целыми в minor units`);
  }
  if (min > max) {
    throw new Error(`границы единицы "${id}" перепутаны: min ${min} > max ${max}`);
  }
  return Object.freeze({ ...definition });
}

/**
 * Проверяет, что значение — допустимое целое в minor units этой единицы.
 * `NaN`, `±Infinity`, дробное и выходящее за диапазон отвергаются НА ГРАНИЦЕ (A5).
 */
export function checkMinorUnits(value: number, unit: NumericUnit): number | NumericError {
  if (!Number.isFinite(value)) {
    return {
      error: `${unit.id}: значение обязано быть конечным числом, получено ${String(value)}`,
    };
  }
  if (!Number.isInteger(value)) {
    return {
      error:
        `${unit.id}: значение в minor units обязано быть целым, получено ${String(value)}; ` +
        'округление возможно только явным вызовом roundToMinorUnits',
    };
  }
  if (!Number.isSafeInteger(value) || value < unit.min || value > unit.max) {
    return {
      error: `${unit.id}: значение ${String(value)} вне диапазона [${unit.min}, ${unit.max}] minor units`,
    };
  }
  // `-0` и `0` — одно значение, но разные представления; нормализуем, чтобы каноническая
  // форма не зависела от того, как ноль был получен.
  return value === 0 ? 0 : value;
}

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * Точный разбор десятичной записи в minor units. Значение точнее единицы ОТВЕРГАЕТСЯ,
 * а не округляется (A5). Экспоненциальная запись, ведущие нули, знак `+`, пробелы и
 * разделители разрядов не принимаются: канонический вход не бывает «почти числом».
 */
export function parseDecimalMinorUnits(text: string, unit: NumericUnit): number | NumericError {
  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    return {
      error: `${unit.id}: ожидалась десятичная запись вида -?\\d+(\\.\\d+)?, получено ${JSON.stringify(text)}`,
    };
  }
  const [, sign, integerPart, fractionPart = ''] = match;
  const places = decimalPlaces(unit);
  if (fractionPart.length > places) {
    return {
      error:
        `${unit.id}: значение ${JSON.stringify(text)} точнее единицы — допустимо ${places} ` +
        `знаков после точки, получено ${fractionPart.length}; ` +
        'округление возможно только явным вызовом roundToMinorUnits',
    };
  }
  const digits = `${integerPart!}${fractionPart.padEnd(places, '0')}`;
  const magnitude = Number(digits);
  if (!Number.isSafeInteger(magnitude)) {
    return {
      error: `${unit.id}: значение ${JSON.stringify(text)} вне безопасного диапазона целых`,
    };
  }
  return checkMinorUnits(sign === '-' ? -magnitude : magnitude, unit);
}

/** Обратное представление: minor units в десятичную запись. Для отображения, не для canonical. */
export function formatMinorUnits(minorUnits: number, unit: NumericUnit): string {
  const places = decimalPlaces(unit);
  const sign = minorUnits < 0 ? '-' : '';
  const digits = String(Math.abs(minorUnits)).padStart(places + 1, '0');
  if (places === 0) {
    return `${sign}${digits}`;
  }
  return `${sign}${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
}

/**
 * Явное округление до minor units. Режим обязателен и применяется к точной десятичной
 * записи числа, поэтому «половина» — настоящая половина, а не артефакт двоичного умножения.
 */
export function roundToMinorUnits(
  value: number,
  unit: NumericUnit,
  mode: NumericRoundingMode,
): number | NumericError {
  if (!NUMERIC_ROUNDING_MODES.includes(mode)) {
    return { error: `${unit.id}: неизвестный режим округления ${JSON.stringify(mode)}` };
  }
  if (!Number.isFinite(value)) {
    return {
      error: `${unit.id}: значение обязано быть конечным числом, получено ${String(value)}`,
    };
  }

  const text = String(value);
  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    // `String` переходит на экспоненциальную запись при |value| >= 1e21 и < 1e-6.
    return {
      error: `${unit.id}: значение ${text} не имеет точной десятичной записи и не может быть округлено`,
    };
  }

  const [, sign, integerPart, fractionPart = ''] = match;
  const places = decimalPlaces(unit);
  const kept = fractionPart.slice(0, places).padEnd(places, '0');
  const dropped = fractionPart.slice(places);
  const magnitude = Number(`${integerPart!}${kept}`);
  if (!Number.isSafeInteger(magnitude)) {
    return { error: `${unit.id}: значение ${text} вне безопасного диапазона целых` };
  }

  const negative = sign === '-';
  const rounded = negative
    ? -applyRounding(magnitude, dropped, mode, true)
    : applyRounding(magnitude, dropped, mode, false);
  return checkMinorUnits(rounded, unit);
}

/**
 * Округление отброшенного хвоста. `magnitude` — абсолютная величина в minor units,
 * `dropped` — отброшенные десятичные знаки как строка (сравнение с «половиной» строковое,
 * поэтому точное).
 */
function applyRounding(
  magnitude: number,
  dropped: string,
  mode: NumericRoundingMode,
  negative: boolean,
): number {
  if (dropped.length === 0 || /^0*$/.test(dropped)) {
    return magnitude;
  }

  switch (mode) {
    case 'floor':
      // Округление к минус бесконечности: для отрицательных величина растёт по модулю.
      return negative ? magnitude + 1 : magnitude;
    case 'ceil':
      return negative ? magnitude : magnitude + 1;
    case 'half-away-from-zero':
      return compareToHalf(dropped) >= 0 ? magnitude + 1 : magnitude;
    case 'half-even': {
      const comparison = compareToHalf(dropped);
      if (comparison > 0) {
        return magnitude + 1;
      }
      if (comparison < 0) {
        return magnitude;
      }
      return magnitude % 2 === 0 ? magnitude : magnitude + 1;
    }
  }
}

/** Сравнивает отброшенный хвост с «0.5»: >0 больше половины, 0 ровно половина, <0 меньше. */
function compareToHalf(dropped: string): number {
  const first = dropped.charCodeAt(0) - 48;
  if (first !== 5) {
    return first - 5;
  }
  return /^0*$/.test(dropped.slice(1)) ? 0 : 1;
}

/** Порядковый номер события в мире: строго возрастающее целое, начинается с 1 (§3). */
export const SEQUENCE_UNIT = defineNumericUnit({
  id: 'count.sequence',
  description: 'Порядковый номер commit внутри мира; целое, строго возрастает, начинается с 1.',
  minorUnitsPerMajor: 1,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
});

/** Оптимистичная версия мира в `expected_world_version` (§2). */
export const WORLD_VERSION_UNIT = defineNumericUnit({
  id: 'count.world_version',
  description: 'Версия мира для optimistic concurrency; целое, не убывает, начинается с 0.',
  minorUnitsPerMajor: 1,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
});

/** Версия схемы конкретного типа команды/события (§4). */
export const SCHEMA_VERSION_UNIT = defineNumericUnit({
  id: 'count.schema_version',
  description: 'Версия схемы payload конкретного type; целое, начинается с 1.',
  minorUnitsPerMajor: 1,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
});

/** Индекс первого использованного draw в PRNG-потоке (§7 random audit). */
export const DRAW_INDEX_UNIT = defineNumericUnit({
  id: 'count.prng_draw_index',
  description: 'Индекс draw внутри PRNG stream; целое, начинается с 0.',
  minorUnitsPerMajor: 1,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
});

/**
 * Порядковый номер применённого проекцией события (I03).
 *
 * ОТДЕЛЬНАЯ единица от `SEQUENCE_UNIT`, а не переиспользование, и это не формальность.
 * Каноническая `sequence` — номер commit в журнале мира; projection sequence — номер шага
 * ПРОЕКЦИИ, у которой своя история: она может отставать, пересобираться с нуля и пропускать
 * события, не попадающие в observer-слой. Совпадение значений сегодня — совпадение, а не
 * свойство. Одна единица на две величины означала бы, что курсор SSE и курсор журнала можно
 * перепутать без единого сигнала — а зритель получает ИМЕННО projection sequence (§7
 * 03_TECHNICAL_DESIGN), и канонический номер ему знать неоткуда.
 */
export const PROJECTION_SEQUENCE_UNIT = defineNumericUnit({
  id: 'count.projection_sequence',
  description: 'Порядковый номер шага проекции; целое, строго возрастает, начинается с 1.',
  minorUnitsPerMajor: 1,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
});

/**
 * Длительность перехода по маршруту в минутах МИРОВОГО времени (I03, observer map).
 *
 * Единица нужна, потому что A5 запрещает безразмерное число в контракте: `travel_minutes: 40`
 * без единицы читается как «сорок чего-то» и однажды окажется секундами. Минимум 1 — переход
 * длительностью ноль означал бы телепортацию, то есть событие начала и завершения в один момент
 * мирового времени.
 */
export const TRAVEL_MINUTES_UNIT = defineNumericUnit({
  id: 'duration.travel_minutes',
  description: 'Длительность перехода по маршруту в минутах мирового времени; целое, минимум 1.',
  minorUnitsPerMajor: 1,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
});

/** Сколько draw израсходовал outcome (§7 random audit). */
export const DRAW_COUNT_UNIT = defineNumericUnit({
  id: 'count.prng_draw',
  description: 'Количество draw, израсходованных outcome; целое, минимум 1.',
  minorUnitsPerMajor: 1,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
});

/**
 * Момент времени и длительность: major unit — секунда, minor unit — миллисекунда.
 *
 * Единица не декоративна: именно она задаёт «сколько знаков допускает величина времени».
 * Метка `...T18:20:00.123456Z` точнее миллисекунды и обязана быть отвергнута, а не молча
 * усечена — иначе два разных текста дают один момент, и checksum перестаёт быть функцией
 * канонического состояния.
 */
export const MILLISECOND_UNIT = defineNumericUnit({
  id: 'time.second',
  description: 'Момент/длительность в секундах; minor unit — миллисекунда (3 знака).',
  minorUnitsPerMajor: 1000,
  min: -62_167_219_200_000,
  max: 253_402_300_799_999,
});
