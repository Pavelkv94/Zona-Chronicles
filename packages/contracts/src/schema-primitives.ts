/**
 * Переиспользуемые примитивы схем. Одно правило — одно определение: шаблоны берутся из
 * `identifier.ts`/`instant.ts`, а не переписываются в каждой схеме заново.
 *
 * Все числовые поля объявляются через единицу из `numeric.ts`, поэтому «безразмерного числа»
 * в контрактах нет (A5): диапазон приходит из единицы, а не из литерала рядом со схемой.
 */
import { Type } from '@sinclair/typebox';
import { NAMESPACED_ID_SOURCE, RUNTIME_ID_PATTERN } from './identifier.ts';
import { STRICT_ISO_8601_INSTANT_PATTERN } from './instant.ts';
import {
  DRAW_COUNT_UNIT,
  DRAW_INDEX_UNIT,
  type NumericUnit,
  PROJECTION_SEQUENCE_UNIT,
  SCHEMA_VERSION_UNIT,
  SEQUENCE_UNIT,
  RISK_UNIT,
  TRAVEL_MINUTES_UNIT,
  WORLD_VERSION_UNIT,
} from './numeric.ts';
import { CHECKSUM_PATTERN } from './checksum.ts';

/** Извлекает исходник шаблона без флагов: JSON Schema `pattern` — строка, а не `RegExp`. */
function sourceOf(pattern: RegExp): string {
  return pattern.source;
}

/** Стабильный slug статического контента: `loc:quiet-yard` (§1). */
export const NamespacedIdSchema = Type.String({
  pattern: NAMESPACED_ID_SOURCE,
  description: 'Идентификатор вида namespace:local-part, например loc:quiet-yard.',
});

/** Runtime id с фиксированным префиксом: `evt_…`, `cmd_…`, `corr_…` (§1). */
export function RuntimeIdSchema(prefix: string, description: string) {
  return Type.String({ pattern: RUNTIME_ID_PATTERN(prefix), description });
}

/**
 * Момент времени на входе: строгий ISO-8601 с ОБЯЗАТЕЛЬНЫМ смещением.
 *
 * Схема намеренно шире канонической формы: `09_EVENT_AND_COMMAND_CONTRACTS` §3 приводит
 * `"world_time": "2034-05-17T18:20:00Z"` — без миллисекунд. Отвергать пример из документа
 * нельзя, поэтому приведение к `….sssZ` выполняет декодер, а не схема. Значение точнее
 * миллисекунды декодер отвергает (A5), а не усекает.
 */
export const InstantSchema = Type.String({
  pattern: sourceOf(STRICT_ISO_8601_INSTANT_PATTERN),
  description:
    'ISO-8601 момент с обязательным явным смещением; декодируется в UTC с точностью до миллисекунды.',
});

/** Semantic version правил и контента: `0.1.0` (§4). */
export const SEMANTIC_VERSION_SOURCE = '^\\d+\\.\\d+\\.\\d+$';

export const SemanticVersionSchema = Type.String({
  pattern: SEMANTIC_VERSION_SOURCE,
  description: 'Semantic version вида MAJOR.MINOR.PATCH.',
});

/** Точечное имя: `journey.started`, `agent.is_on_route` (§4). */
export const DOTTED_NAME_SOURCE =
  '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$';

export const DottedNameSchema = Type.String({
  pattern: DOTTED_NAME_SOURCE,
  description: 'Точечное имя вида noun.past_tense или aggregate.predicate.',
});

/** Checksum канонического содержимого: `sha256:<64 hex>` (§9). */
export const ChecksumSchema = Type.String({
  pattern: sourceOf(CHECKSUM_PATTERN),
  description: 'SHA-256 над канонической сериализацией: sha256:<64 hex>.',
});

/**
 * Целое в minor units конкретной единицы. Диапазон берётся из единицы, поэтому число в схеме
 * всегда имеет документированную размерность (A5).
 */
export function UnitIntegerSchema(unit: NumericUnit, description: string) {
  if (unit.minorUnitsPerMajor !== 1) {
    throw new Error(
      `единица "${unit.id}" дробная: величина в схеме обязана быть целой в minor units`,
    );
  }
  return Type.Integer({
    minimum: unit.min,
    maximum: unit.max,
    description: `${description} Единица: ${unit.id}.`,
  });
}

export const SequenceSchema = UnitIntegerSchema(
  SEQUENCE_UNIT,
  'Строгий порядок commit внутри мира.',
);

export const WorldVersionSchema = UnitIntegerSchema(
  WORLD_VERSION_UNIT,
  'Ожидаемая версия мира для optimistic concurrency.',
);

export const SchemaVersionSchema = UnitIntegerSchema(
  SCHEMA_VERSION_UNIT,
  'Версия схемы payload конкретного type.',
);

export const ProjectionSequenceSchema = UnitIntegerSchema(
  PROJECTION_SEQUENCE_UNIT,
  'Порядковый номер шага проекции; курсор SSE и observer snapshot (§7 03_TECHNICAL_DESIGN).',
);

export const TravelMinutesSchema = UnitIntegerSchema(
  TRAVEL_MINUTES_UNIT,
  'Длительность перехода по маршруту в минутах мирового времени.',
);

/**
 * Опасность места или дороги в тысячных.
 *
 * Границы берутся ИЗ ЕДИНИЦЫ, а не выписаны числами в схеме. Ревью I04-I06 (m4) нашло, что
 * `RISK_UNIT` был объявлен, экспортирован и не использован нигде: диапазон держали
 * check-constraint миграции и два литерала 0..1000 в схеме события. Три источника одной величины
 * расходятся молча — и первым же расхождением станет то, которое никто не проверяет.
 *
 * `UnitIntegerSchema` здесь неприменим намеренно: он существует для единиц, у которых minor unit
 * совпадает с major (`minorUnitsPerMajor === 1`), и падает на дробных. Опасность — тысячные, как
 * оценка цели: величина хранится целой В MINOR UNITS, а её границы единица уже выражает в них же.
 */
export const RiskSchema = Type.Integer({
  minimum: RISK_UNIT.min,
  maximum: RISK_UNIT.max,
  description: `Опасность места или дороги в тысячных. Единица: ${RISK_UNIT.id}.`,
});

export const DrawIndexSchema = UnitIntegerSchema(
  DRAW_INDEX_UNIT,
  'Индекс первого использованного draw в PRNG stream.',
);

export const DrawCountSchema = UnitIntegerSchema(
  DRAW_COUNT_UNIT,
  'Сколько draw израсходовал outcome.',
);

/**
 * Массив идентификаторов, участвующий в канонической сериализации.
 *
 * `uniqueItems` не косметика: `actor_ids`, `subject_ids` и `caused_by` — множества, а не
 * последовательности. Порядок элементов в них не несёт смысла, но ВЛИЯЕТ на checksum,
 * поэтому декодер дополнительно требует возрастающего порядка (см. `validation.ts`).
 */
export function IdSetSchema(description: string) {
  return Type.Array(NamespacedIdSchema, { uniqueItems: true, description });
}

export function RuntimeIdSetSchema(prefix: string, description: string) {
  return Type.Array(RuntimeIdSchema(prefix, description), { uniqueItems: true, description });
}
