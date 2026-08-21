/**
 * Canonical serialization v1 (`09_EVENT_AND_COMMAND_CONTRACTS` §9, `07_MVP_MECHANICS_SPEC` §7,
 * SIM-01).
 *
 * Единственная форма, над которой считается checksum снапшота и любой другой канонический
 * хеш. Алгоритм зафиксирован целиком; изменение любого правила ниже — versioned migration,
 * а не улучшение, поэтому версия объявлена константой `CANONICAL_SERIALIZATION_VERSION`,
 * которую снапшот обязан хранить в своём runtime profile.
 *
 * ## Правила v1
 *
 * 1. **Порядок ключей** — по возрастанию кодовых точек Unicode. Не `localeCompare` (запрещён
 *    lint-ом и зависит от локали) и не наивное `a < b` (сравнивает UTF-16 code units, из-за
 *    чего суррогатная пара U+1F600 оказывается «меньше» U+FF5E). Порядок кодовых точек
 *    совпадает с порядком UTF-8 байтов, а хешируются именно UTF-8 байты.
 * 2. **Кодировка** — UTF-8. Строка на выходе кодируется в байты один раз, в `sha256Hex`.
 * 3. **Числа** — только безопасные целые (`Number.isSafeInteger`). `NaN`, `±Infinity`,
 *    дробные значения и значения за пределом 2^53−1 отвергаются НА ГРАНИЦЕ, а не округляются
 *    и не превращаются в `null`, как это делает `JSON.stringify` (A5). Дробные величины
 *    попадают в канонические данные только через документированные minor units
 *    (`numeric.ts`), поэтому «дробного канонического числа» не существует по построению.
 *    `-0` сериализуется как `0`.
 * 4. **Даты** — не имеют отдельного представления: канонический момент времени это строка
 *    `Instant` в нормализованной форме (`toCanonicalInstant`), а объекты `Date` отвергаются.
 *    Иначе один и тот же момент, записанный как `...T18:20:00Z` и `...T20:20:00+02:00`,
 *    дал бы разный checksum.
 * 5. **Отсутствующие поля** — ключ со значением `undefined` ОПУСКАЕТСЯ (отсутствующее поле);
 *    явный `null` сохраняется как присутствующее значение. `undefined` внутри массива —
 *    ошибка, а не молчаливая подмена на `null`.
 * 6. **Форматирование** — без пробелов и переводов строк; экранирование строк по правилам
 *    ECMA-262 `JSON.stringify` (well-formed: одиночные суррогаты выводятся как `\udXXX`).
 * 7. **Запрещённые входы** — `bigint`, `symbol`, функции, `Date`, `Map`, `Set`, типизированные
 *    массивы, экземпляры классов, объекты с `toJSON` и объекты с собственными symbol-ключами.
 *    Каждый из них либо теряет данные молча, либо зависит от неявного преобразования.
 * 8. **Циклы** — ошибка с путём, а не переполнение стека.
 */

/** Версия алгоритма. Часть контракта: снапшот хранит её в deterministic runtime profile. */
export const CANONICAL_SERIALIZATION_VERSION = 'canonical-json/1';

export interface CanonicalizationError {
  readonly error: string;
  /** JSONPath-подобный путь до значения, вызвавшего отказ: `$`, `$.a`, `$.a[0].b`. */
  readonly path: string;
}

export interface CanonicalJson {
  readonly json: string;
}

export type CanonicalizationResult = CanonicalJson | CanonicalizationError;

/**
 * Сужение до ошибки. Принимает любой результат вида «значение или ошибка канонизации»
 * (`CanonicalizationResult`, `ChecksumResult`, …), чтобы у каждого потребителя не появлялся
 * собственный почти-такой-же предикат: их расхождение — классический источник пропущенной
 * ошибки.
 */
export function isCanonicalizationError<T extends object>(
  result: T | CanonicalizationError,
): result is CanonicalizationError {
  return 'error' in result;
}

/**
 * Сравнение строк по кодовым точкам Unicode. Возвращает <0, 0 или >0.
 *
 * `localeCompare` запрещён (SIM-01), а `a < b` сравнивает UTF-16 code units и расходится с
 * порядком кодовых точек на суррогатах.
 */
export function compareByCodePoint(a: string, b: string): number {
  const aPoints = Array.from(a);
  const bPoints = Array.from(b);
  const shared = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < shared; i += 1) {
    const aPoint = aPoints[i]!.codePointAt(0)!;
    const bPoint = bPoints[i]!.codePointAt(0)!;
    if (aPoint !== bPoint) {
      return aPoint - bPoint;
    }
  }
  return aPoints.length - bPoints.length;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    // Разделяем "простой объект" и всё остальное по строковому тегу: он различает
    // Date/Map/Set/TypedArray без instanceof, который ломается между realm-ами.
    return Object.prototype.toString.call(value).slice(8, -1);
  }
  return typeof value;
}

function childPath(path: string, key: string): string {
  return `${path}.${key}`;
}

function indexPath(path: string, index: number): string {
  return `${path}[${index}]`;
}

/** Сериализует значение в каноническую JSON-строку либо возвращает типизированную ошибку. */
export function canonicalize(value: unknown): CanonicalizationResult {
  const ancestors = new Set<object>();

  function write(node: unknown, path: string): string | CanonicalizationError {
    if (node === null) {
      return 'null';
    }

    switch (typeof node) {
      case 'boolean':
        return node ? 'true' : 'false';

      case 'string':
        return JSON.stringify(node);

      case 'number': {
        if (!Number.isFinite(node)) {
          return {
            path,
            error: `нефинитное число (${String(node)}): каноническое значение обязано быть конечным целым`,
          };
        }
        if (!Number.isInteger(node)) {
          return {
            path,
            error:
              `дробное число (${String(node)}): каноническое значение обязано быть целым; ` +
              `дробные величины кодируются в minor units по documented unit`,
          };
        }
        if (!Number.isSafeInteger(node)) {
          return {
            path,
            error: `целое вне безопасного диапазона (${String(node)}): |value| должно быть <= 2^53-1`,
          };
        }
        // `String` для безопасного целого никогда не даёт экспоненциальную запись
        // и не зависит от локали; `-0` превращается в "0".
        return Object.is(node, -0) ? '0' : String(node);
      }

      case 'undefined':
        return { path, error: 'undefined не имеет канонического представления' };

      case 'bigint':
        return { path, error: 'bigint не имеет канонического представления в JSON' };

      case 'symbol':
        return { path, error: 'symbol не имеет канонического представления' };

      case 'function':
        return { path, error: 'функция не имеет канонического представления' };

      case 'object':
        break;
    }

    const objectNode: object = node;
    if (ancestors.has(objectNode)) {
      return { path, error: 'цикл в структуре: каноническая сериализация невозможна' };
    }

    if (Array.isArray(objectNode)) {
      ancestors.add(objectNode);
      const parts: string[] = [];
      for (let index = 0; index < objectNode.length; index += 1) {
        const element = (objectNode as unknown[])[index];
        if (element === undefined) {
          return {
            path: indexPath(path, index),
            error:
              'undefined в массиве: отсутствие элемента не выражается в каноническом JSON, ' +
              'JSON.stringify молча подменил бы его на null',
          };
        }
        const written = write(element, indexPath(path, index));
        if (typeof written !== 'string') {
          return written;
        }
        parts.push(written);
      }
      ancestors.delete(objectNode);
      return `[${parts.join(',')}]`;
    }

    if (!isPlainObject(objectNode)) {
      return {
        path,
        error:
          `значение типа ${describeType(objectNode)} не имеет канонического представления: ` +
          'канонично сериализуются только простые объекты, массивы и примитивы',
      };
    }

    if (Object.getOwnPropertySymbols(objectNode).length > 0) {
      return {
        path,
        error: 'объект содержит собственные symbol-ключи: они бы молча потерялись при сериализации',
      };
    }

    if ('toJSON' in objectNode) {
      return {
        path,
        error:
          'объект определяет toJSON: скрытое преобразование делает канонический вид непроверяемым',
      };
    }

    ancestors.add(objectNode);
    const keys = Object.keys(objectNode).sort(compareByCodePoint);
    const parts: string[] = [];
    for (const key of keys) {
      const child = (objectNode as Record<string, unknown>)[key];
      if (child === undefined) {
        continue;
      }
      const written = write(child, childPath(path, key));
      if (typeof written !== 'string') {
        return written;
      }
      parts.push(`${JSON.stringify(key)}:${written}`);
    }
    ancestors.delete(objectNode);
    return `{${parts.join(',')}}`;
  }

  const written = write(value, '$');
  return typeof written === 'string' ? { json: written } : written;
}

/**
 * Каноническая строка либо `Error` с меткой источника — граница, где неканоничное значение
 * обязано быть явной ошибкой, а не тихо изменённым checksum.
 */
export function requireCanonical(value: unknown, sourceLabel: string): string {
  const result = canonicalize(value);
  if (isCanonicalizationError(result)) {
    throw new Error(
      `значение из "${sourceLabel}" не сериализуется канонически в ${result.path}: ${result.error}`,
    );
  }
  return result.json;
}
