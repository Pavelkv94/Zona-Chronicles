/**
 * Snapshot contract v1 (`09_EVENT_AND_COMMAND_CONTRACTS` §9, A9).
 *
 * Главное требование §7 и §9 — snapshot ссылается на immutable rules/content/schema bundles
 * **по версии И checksum**: «одной строки semantic version недостаточно». Причина не
 * теоретическая: версия — это утверждение автора, checksum — проверяемый факт. Пересобранный
 * под той же версией bundle меняет поведение replay, и без checksum это обнаружится как
 * «загадочное расхождение симуляции», а не как несовпадение артефакта.
 *
 * Поэтому `verifyBundleRef` здесь — исполняемая функция, а не обещание: подмена содержимого
 * при неизменной версии обязана быть отличима.
 *
 * ## Что сознательно НЕ входит в v1
 *
 * §9 перечисляет также «pending scheduled actions либо ссылку на их согласованный DB state».
 * Scheduled action появляется в I02B, и §12 запрещает реализовывать схемы будущих slices
 * заранее. Поле не добавлено, и это осознанный долг: в I02B его добавление будет breaking
 * change и потребует поднять мажорную версию snapshot-схемы.
 */
import { type Static, Type } from '@sinclair/typebox';
import {
  CANONICAL_SERIALIZATION_VERSION,
  canonicalize,
  isCanonicalizationError,
} from './canonical-json.ts';
import { canonicalChecksum, requireChecksum } from './checksum.ts';
import { NAMESPACED_ID_SOURCE } from './identifier.ts';
import { defineNumericUnit } from './numeric.ts';
import {
  ChecksumSchema,
  DrawIndexSchema,
  InstantSchema,
  NamespacedIdSchema,
  SemanticVersionSchema,
  UnitIntegerSchema,
} from './schema-primitives.ts';
import {
  type ValidationIssue,
  type ValidationResult,
  failure,
  isRecord,
  isValidationIssue,
  normalizeInstantField,
  schemaIssues,
} from './validation.ts';

/**
 * Последняя применённая sequence в snapshot.
 *
 * Отдельная единица, а не `SEQUENCE_UNIT`: у только что порождённого мира событий ещё нет,
 * и `last_sequence` равен 0, тогда как сама sequence события начинается с 1.
 */
export const SNAPSHOT_SEQUENCE_UNIT = defineNumericUnit({
  id: 'count.last_sequence',
  description: 'Последняя применённая sequence; 0 означает мир без событий.',
  minorUnitsPerMajor: 1,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
});

/** Ссылка на immutable bundle: версия И checksum содержимого (§7, §9). */
export const BundleRefSchema = Type.Object(
  {
    version: SemanticVersionSchema,
    checksum: ChecksumSchema,
  },
  {
    $id: 'zona:bundle-ref/1',
    additionalProperties: false,
    description: 'Версия и checksum immutable bundle; версии без checksum недостаточно.',
  },
);

export type BundleRef = Static<typeof BundleRefSchema>;

export const SnapshotBundlesSchema = Type.Object(
  {
    rules: BundleRefSchema,
    content: BundleRefSchema,
    schema: BundleRefSchema,
  },
  { additionalProperties: false, description: 'Immutable bundles, от которых зависит replay.' },
);

/**
 * Профиль детерминированного runtime (§9).
 *
 * Здесь перечислено ровно то, изменение чего меняет канонический результат при том же seed:
 * алгоритм сериализации, версия PRNG, политика единиц/округления и профиль
 * Node.js/ICU/timezone. Обновление любого из них требует прогона compatibility suite, поэтому
 * значения обязаны быть записаны в самом snapshot, а не подразумеваться средой запуска.
 */
export const DeterministicRuntimeProfileSchema = Type.Object(
  {
    canonical_serialization_version: Type.Literal(CANONICAL_SERIALIZATION_VERSION, {
      description: 'Версия алгоритма канонической сериализации, которой посчитан checksum.',
    }),
    prng_version: Type.String({ minLength: 1, description: 'Версия PRNG как зависимости мира.' }),
    numeric_rounding_policy_version: Type.String({
      minLength: 1,
      description: 'Версия политики единиц и округления.',
    }),
    node_version: Type.String({
      minLength: 1,
      description: 'Профиль Node.js канонического worker.',
    }),
    icu_version: Type.String({ minLength: 1, description: 'Профиль ICU.' }),
    timezone: Type.String({ minLength: 1, description: 'Профиль timezone канонического worker.' }),
  },
  { additionalProperties: false, description: 'Deterministic runtime profile (§9).' },
);

export const SnapshotSchema = Type.Object(
  {
    world_id: NamespacedIdSchema,
    last_sequence: UnitIntegerSchema(
      SNAPSHOT_SEQUENCE_UNIT,
      'Последняя применённая sequence мира.',
    ),
    world_time: Type.Unsafe<string>({
      ...InstantSchema,
      description: 'Каноническое время мира на момент снимка (§9).',
    }),
    created_at: Type.Unsafe<string>({
      ...InstantSchema,
      description: 'Wall clock создания снимка; метаданные, не участвуют в доменной логике (§9).',
    }),
    bundles: SnapshotBundlesSchema,
    deterministic_runtime_profile: DeterministicRuntimeProfileSchema,
    prng_stream_positions: Type.Record(
      Type.String({ pattern: NAMESPACED_ID_SOURCE }),
      DrawIndexSchema,
      {
        description: 'Позиции PRNG-потоков по stable stream key (§7, §9).',
      },
    ),
    canonical_state: Type.Unknown({
      description:
        'Каноническое состояние мира. Форму владеет домен; контракт требует лишь того, ' +
        'чтобы оно было канонически сериализуемым.',
    }),
    checksum: ChecksumSchema,
  },
  {
    $id: 'zona:snapshot/1',
    additionalProperties: false,
    description: 'Snapshot contract v1 (09_EVENT_AND_COMMAND_CONTRACTS §9).',
  },
);

export type Snapshot = Static<typeof SnapshotSchema>;

/**
 * Ссылка на bundle по его содержимому. Бросает `Error`, если содержимое неканонично: bundle,
 * который невозможно канонически сериализовать, нельзя и адресовать по checksum.
 */
export function bundleRefFor(version: string, content: unknown): BundleRef {
  return { version, checksum: requireChecksum(content, `bundle ${version}`) };
}

/**
 * A9: подмена содержимого bundle при неизменной версии обязана быть обнаружена.
 * Версия здесь не проверяется намеренно — именно совпадающая версия и является той ловушкой,
 * ради которой checksum вообще существует.
 */
export function verifyBundleRef(content: unknown, ref: BundleRef): ValidationResult<BundleRef> {
  const actual = canonicalChecksum(content);
  if (isCanonicalizationError(actual)) {
    return failure(actual.path, `содержимое bundle неканонично: ${actual.error}`);
  }
  if (actual.checksum !== ref.checksum) {
    return failure(
      '/checksum',
      `checksum bundle не совпадает: объявлен ${ref.checksum}, содержимое даёт ${actual.checksum}; ` +
        `версия ${ref.version} совпадает, значит подменено именно содержимое`,
    );
  }
  return { value: ref };
}

/**
 * Checksum снимка.
 *
 * Два правила, и оба обязательны, иначе значение перестаёт быть функцией состояния:
 *
 * 1. Поле `checksum` в расчёт НЕ входит — иначе значение было бы самоссылочным.
 * 2. Моменты времени сначала приводятся к канонической форме. `…T20:20:00+02:00` и
 *    `…T18:20:00.000Z` — один момент мира; если бы checksum считался по тексту как есть,
 *    один и тот же снимок давал бы разный checksum в зависимости от того, в каком смещении
 *    его записал источник. Ровно это ловит A3.
 */
export function snapshotChecksum(snapshot: Omit<Snapshot, 'checksum'>): string {
  const { checksum: _self, ...rest } = snapshot as Snapshot;
  return requireChecksum(normalizeInstantFields(rest), 'snapshot');
}

/** Приводит моменты снимка к канонической форме; невалидный момент — ошибка вызывающего. */
function normalizeInstantFields(snapshot: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...snapshot };
  for (const field of ['world_time', 'created_at'] as const) {
    const value = snapshot[field];
    if (typeof value !== 'string') {
      continue;
    }
    const result = normalizeInstantField(`/${field}`, value);
    if (isValidationIssue(result)) {
      throw new Error(`невозможно посчитать checksum снимка: ${result.path} ${result.message}`);
    }
    normalized[field] = result.iso;
  }
  return normalized;
}

export function verifySnapshotChecksum(snapshot: Snapshot): ValidationResult<Snapshot> {
  const expected = snapshotChecksum(snapshot);
  if (expected !== snapshot.checksum) {
    return failure(
      '/checksum',
      `checksum снимка не совпадает с его содержимым: объявлен ${snapshot.checksum}, ` +
        `содержимое даёт ${expected}`,
    );
  }
  return { value: snapshot };
}

/** Валидирует, нормализует и проверяет целостность снимка. */
export function decodeSnapshot(input: unknown): ValidationResult<Snapshot> {
  if (!isRecord(input)) {
    return failure('', 'snapshot обязан быть объектом');
  }

  const issues = schemaIssues(SnapshotSchema, input);
  if (issues.length > 0) {
    return { errors: issues };
  }

  const canonical = canonicalize(input);
  if (isCanonicalizationError(canonical)) {
    return failure(canonical.path, `snapshot неканоничен: ${canonical.error}`);
  }

  const snapshot = input as unknown as Snapshot;
  const normalized: Record<string, unknown> = {
    ...(snapshot as unknown as Record<string, unknown>),
  };
  const invariantIssues: ValidationIssue[] = [];

  for (const field of ['world_time', 'created_at'] as const) {
    const result = normalizeInstantField(`/${field}`, snapshot[field]);
    if (isValidationIssue(result)) {
      invariantIssues.push(result);
    } else {
      normalized[field] = result.iso;
    }
  }

  if (invariantIssues.length > 0) {
    return { errors: invariantIssues };
  }

  return verifySnapshotChecksum(normalized as unknown as Snapshot);
}
