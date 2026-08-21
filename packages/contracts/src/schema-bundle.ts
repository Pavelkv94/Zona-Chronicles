/**
 * Schema bundle: immutable артефакт, на который снимок ссылается по версии И checksum
 * (`07_MVP_MECHANICS_SPEC` §7, `09_EVENT_AND_COMMAND_CONTRACTS` §9, A9).
 *
 * ## Почему $id не является содержимым (M3)
 *
 * Первая редакция считала checksum schema-bundle от трёх строк `$id`
 * (`sha256:de92dd45…`). Такое значение — не checksum содержимого, а checksum ИМЁН содержимого:
 * добавление поля, снятие `additionalProperties: false` или смена `pattern` оставляли его
 * неизменным при той же версии. То есть ровно тот сценарий, против которого §7 и требует
 * checksum: «одной строки semantic version недостаточно», потому что версия — утверждение
 * автора, а checksum — проверяемый факт. Утверждение об именах фактом о содержимом не является.
 *
 * Поэтому содержимое bundle — сами JSON Schema документы публичных схем. Изменение любой из
 * них при неизменной версии обязано быть обнаружено `verifyBundleRef`.
 *
 * ## Почему JSON round-trip
 *
 * Схемы TypeBox несут собственные symbol-ключи (`Symbol(TypeBox.Kind)` и подобные), а
 * канонический сериализатор объекты с symbol-ключами отвергает — и правильно делает: их
 * содержимое не выражается в JSON и молча потерялось бы. `JSON.parse(JSON.stringify(schema))`
 * даёт ровно тот документ, который и является артефактом bundle: то, что схема означает как
 * JSON Schema, без деталей реализации библиотеки.
 */
import { type TSchema } from '@sinclair/typebox';
import { CommandSchema } from './command.ts';
import { type BundleRef, SnapshotSchema, bundleRefFor } from './snapshot.ts';
import { WorldEventSchema } from './world-event.ts';

/**
 * Версия schema bundle. Мажор совпадает с `ENVELOPE_SCHEMA_VERSION` (§4): несовместимое
 * изменение envelope — это новый мажор и bundle, и схемы.
 */
export const SCHEMA_BUNDLE_VERSION = '1.0.0';

/**
 * Публичные схемы контракта. Список — часть bundle: схема, которой здесь нет, не защищена
 * checksum, поэтому добавление публичной схемы обязано проходить через это место.
 */
const PUBLIC_SCHEMAS: readonly TSchema[] = [CommandSchema, WorldEventSchema, SnapshotSchema];

export const PUBLIC_SCHEMA_IDS: readonly string[] = PUBLIC_SCHEMAS.map((schema) =>
  requireSchemaId(schema),
);

function requireSchemaId(schema: TSchema): string {
  const id = schema.$id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('публичная схема обязана иметь $id: без него bundle неадресуем');
  }
  return id;
}

/** JSON Schema документ схемы: то, что она означает, без symbol-ключей реализации TypeBox. */
function jsonSchemaDocument(schema: TSchema): unknown {
  return JSON.parse(JSON.stringify(schema)) as unknown;
}

/** Содержимое schema bundle: документы публичных схем, индексированные их `$id`. */
export function schemaBundleContent(): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const schema of PUBLIC_SCHEMAS) {
    content[requireSchemaId(schema)] = jsonSchemaDocument(schema);
  }
  return content;
}

/** Ссылка на schema bundle по версии и checksum его фактического содержимого. */
export function schemaBundleRef(): BundleRef {
  return bundleRefFor(SCHEMA_BUNDLE_VERSION, schemaBundleContent());
}
