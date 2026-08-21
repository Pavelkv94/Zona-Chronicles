/**
 * Runtime-валидация envelopes (A4).
 *
 * Требование итерации — отказ В RUNTIME, а не только несовпадение типов: типы стираются при
 * компиляции и ничего не проверяют на данных из БД, CLI или HTTP. Поэтому каждый декодер
 * возвращает либо значение, либо список типизированных ошибок с путём.
 *
 * Декодер делает три вещи в фиксированном порядке, и порядок важен для качества сообщения:
 *
 * 1. **Дискриминатор.** Неизвестный `type` и чужая мажорная `schema_version` обязаны давать
 *    ОТДЕЛЬНОЕ сообщение: первое означает «событие не из этого контракта», второе — «нужен
 *    upcaster (§4)». Если бы обе ситуации проходили общий schema check, они слились бы в
 *    «значение не соответствует ни одному варианту union» и потребитель не смог бы их
 *    различить.
 * 2. **Схема TypeBox** конкретного типа: обязательные поля, типы, шаблоны, `additionalProperties`.
 * 3. **Канонические инварианты**, которые JSON Schema выразить не может: отсутствие
 *    дублирования полей envelope в payload (§4) и возрастающий порядок в множествах
 *    идентификаторов (иначе один и тот же факт даёт разный checksum).
 */
import { type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { compareByCodePoint } from './canonical-json.ts';
import { isInstantError } from './instant.ts';
import { parseCanonicalInstant } from './canonical-instant.ts';

export interface ValidationIssue {
  /** JSON Pointer до значения: `/payload/route_id`. Пустая строка — корень. */
  readonly path: string;
  readonly message: string;
}

export interface ValidationFailure {
  readonly errors: readonly ValidationIssue[];
}

export interface ValidationSuccess<T> {
  readonly value: T;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function isValidationFailure<T>(result: ValidationResult<T>): result is ValidationFailure {
  return 'errors' in result;
}

export function failure(path: string, message: string): ValidationFailure {
  return { errors: [{ path, message }] };
}

/** Ошибки TypeBox в стабильном порядке: сообщение об отказе не должно «плавать». */
export function schemaIssues(schema: TSchema, input: unknown): ValidationIssue[] {
  const issues = [...Value.Errors(schema, input)].map((error) => ({
    path: error.path,
    message: error.message,
  }));
  return issues.sort(
    (a, b) => compareByCodePoint(a.path, b.path) || compareByCodePoint(a.message, b.message),
  );
}

/** Простой объект: массив и `null` объектами envelope не являются. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * §4: «поля envelope не дублируются в payload» — проверка СХЕМЫ, а не входных данных.
 *
 * Первая редакция проверяла данные и была снята мутационной пробой как недостижимая: у каждой
 * payload-схемы стоит `additionalProperties: false`, поэтому лишний `world_id` во входе
 * отклоняется как «Unexpected property» ещё до неё. Контроль, который невозможно достичь, не
 * защищает ничего и при этом выглядит защитой.
 *
 * Нарушение §4, которое действительно возможно, — авторское: кто-то ОБЪЯВИТ в payload-схеме
 * поле с именем поля envelope, и дубликат станет легальным. Тогда одно значение получит два
 * источника истины, которые однажды разойдутся. Ловится это только сравнением имён свойств
 * схемы с именами полей envelope, что и делает функция ниже; вызывается она из contract-теста.
 */
export function payloadSchemaShadowedKeys(
  payloadSchema: { readonly properties?: Readonly<Record<string, unknown>> },
  envelopeKeys: readonly string[],
): string[] {
  return Object.keys(payloadSchema.properties ?? {})
    .filter((key) => envelopeKeys.includes(key))
    .sort(compareByCodePoint);
}

/**
 * Множество идентификаторов обязано быть отсортировано по возрастанию кодовых точек.
 *
 * `uniqueItems` в схеме убирает дубликаты, но не порядок: `["agent:a","agent:b"]` и
 * `["agent:b","agent:a"]` — одно множество и два разных канонических текста, то есть два
 * разных checksum одного факта. Порядок фиксируется здесь, а не оставляется на добрую волю
 * продюсера.
 */
export function idSetIsSorted(path: string, values: readonly string[]): ValidationIssue[] {
  for (let index = 1; index < values.length; index += 1) {
    if (compareByCodePoint(values[index - 1]!, values[index]!) >= 0) {
      return [
        {
          path: `${path}/${index}`,
          message:
            'множество идентификаторов обязано быть отсортировано по возрастанию кодовых точек: ' +
            'порядок не несёт смысла, но меняет checksum',
        },
      ];
    }
  }
  return [];
}

/**
 * Приводит момент к канонической форме UTC с точностью до миллисекунды либо возвращает
 * ошибку. Схема уже проверила формат, поэтому сюда попадает только несоответствие точности
 * или календарная невозможность.
 */
export function normalizeInstantField(
  path: string,
  value: string,
): { readonly iso: string } | ValidationIssue {
  const parsed = parseCanonicalInstant(value);
  if (isInstantError(parsed)) {
    return { path, message: parsed.error };
  }
  return { iso: parsed.iso };
}

export function isValidationIssue(
  value: { readonly iso: string } | ValidationIssue,
): value is ValidationIssue {
  return 'message' in value;
}
