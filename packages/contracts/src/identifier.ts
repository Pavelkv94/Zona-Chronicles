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
 * ## Формат runtime id: ULID, решение lead-а I01
 *
 * §1 требует time-sortable ID, но откладывает выбор библиотеки («выбрать в executable
 * skeleton»). Выбран ULID: 26 символов Crockford base32 (алфавит без `I`, `L`, `O`, `U` —
 * они путаются с `1`, `1`, `0` и `V`). Основания записаны здесь, а не унаследованы молча:
 *
 * - ULID сортируется лексикографически как ТЕКСТ, а текстовый порядок в этом проекте уже
 *   обязан быть детерминированным — в I00 по той же причине журналу миграций зафиксировали
 *   `collate "C"`;
 * - примеры §1–§3 записаны как `evt_01…`, `cmd_01…`, а ULID нашего времени начинаются
 *   именно с `01`: документ, судя по всему, уже подразумевал ULID;
 * - префикс `evt_`/`cmd_` в любом случае исключает хранение в нативном `uuid` Postgres,
 *   поэтому главное преимущество UUIDv7 здесь не реализуется.
 *
 * ОГОВОРКА. Если I02A найдёт сильную причину хранения в пользу UUIDv7, это breaking change,
 * и он обязан произойти ДО первого записанного события: после появления durable журнала
 * сужение или смена формата задевает уже сохранённые данные и требует upcaster.
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

/** Алфавит Crockford base32: цифры и заглавные буквы без `I`, `L`, `O`, `U`. */
export const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Длина ULID в символах. */
export const ULID_BODY_LENGTH = 26;

/** Тело id: ULID. Нижний регистр не принимается — канонической формой считается верхний. */
const RUNTIME_ID_BODY = `[0-9A-HJKMNP-TV-Z]{${ULID_BODY_LENGTH}}`;

/** Строковый шаблон для JSON Schema `pattern`; якоря входят в саму строку. */
export function RUNTIME_ID_PATTERN(prefix: string): string {
  return `^${prefix}_${RUNTIME_ID_BODY}$`;
}

export function isRuntimeId(value: string, prefix: string): boolean {
  // `RegExp` строится на каждый вызов намеренно: общий объект с флагом `g` хранит `lastIndex`
  // и делает результат зависимым от истории вызовов.
  return new RegExp(RUNTIME_ID_PATTERN(prefix)).test(value);
}
