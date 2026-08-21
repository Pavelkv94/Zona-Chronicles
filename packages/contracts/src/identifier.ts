/**
 * Идентификаторы (`09_EVENT_AND_COMMAND_CONTRACTS` §1).
 *
 * Документ различает два вида и не смешивает их:
 *
 * 1. **Namespaced slug** статического контента — `loc:quiet-yard`, `agent:rook`,
 *    `world:prototype`, `system:world`. Он стабилен, читаем и переживает пересборку мира.
 * 2. **Runtime id**, выданный `IdFactory` — `evt_…`, `cmd_…`, `corr_…`. Он time-sortable и
 *    уникален.
 *
 * ВАЖНО про строгость второго шаблона. §1 явно откладывает выбор библиотеки ID
 * («Конкретную библиотеку ID выбрать в executable skeleton»), поэтому здесь НЕ зашиты ни
 * ULID (26 символов Crockford base32), ни UUIDv7 (hex с дефисами) — контракт принимает оба и
 * ограничивает алфавит и длину. Это осознанно слабее, чем хотелось бы: как только `IdFactory`
 * зафиксирует формат, шаблон надо сузить, и это будет breaking change для уже сохранённых
 * событий. Сузить дешевле до того, как появится первый durable журнал (I02A).
 *
 * Шаблоны отдаются и как `RegExp` (для предикатов), и как строка (для JSON Schema `pattern`,
 * где `RegExp` недопустим), чтобы не было двух разных определений одного правила.
 */

/**
 * `namespace:local-part`, где обе части — lowercase slug без ведущих/завершающих и двойных
 * дефисов. Namespace начинается с буквы: `1loc:` был бы неотличим от порядкового номера.
 */
export const NAMESPACED_ID_SOURCE = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$';

export const NAMESPACED_ID_PATTERN = new RegExp(NAMESPACED_ID_SOURCE);

export function isNamespacedId(value: string): boolean {
  return NAMESPACED_ID_PATTERN.test(value);
}

/** Namespace слева от двоеточия либо `null`, если значение не является namespaced id. */
export function namespaceOf(value: string): string | null {
  if (!isNamespacedId(value)) {
    return null;
  }
  return value.slice(0, value.indexOf(':'));
}

/** Префиксы runtime id, используемые первым contract slice (§11). */
export const RUNTIME_ID_PREFIXES = Object.freeze({
  command: 'cmd',
  correlation: 'corr',
  event: 'evt',
});

export type RuntimeIdPrefix = (typeof RUNTIME_ID_PREFIXES)[keyof typeof RUNTIME_ID_PREFIXES];

/** Тело id: алфавит покрывает и Crockford base32 (ULID), и hex с дефисами (UUIDv7). */
const RUNTIME_ID_BODY = '[0-9A-Za-z-]{10,40}';

/** Строковый шаблон для JSON Schema `pattern`; якоря входят в саму строку. */
export function RUNTIME_ID_PATTERN(prefix: string): string {
  return `^${prefix}_${RUNTIME_ID_BODY}$`;
}

export function isRuntimeId(value: string, prefix: string): boolean {
  // `RegExp` строится на каждый вызов намеренно: общий объект с флагом `g` хранит `lastIndex`
  // и делает результат зависимым от истории вызовов.
  return new RegExp(RUNTIME_ID_PATTERN(prefix)).test(value);
}
