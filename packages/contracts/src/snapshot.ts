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
/**
 * Версия ОБЛАСТИ snapshot checksum.
 *
 * Отдельная от `CANONICAL_SERIALIZATION_VERSION` величина, потому что это две разные
 * договорённости: первая отвечает на вопрос «как значение превращается в байты», вторая — «над
 * каким подмножеством снимка эти байты считаются». Изменить можно любую из них по отдельности,
 * и checksum разойдётся в обоих случаях, поэтому потребитель обязан видеть обе.
 *
 * `/1` — первая редакция I01: checksum считался над всем снимком, кроме поля `checksum`.
 * `/2` — текущая: только над содержимым, которое воспроизводит replay (B2, §9).
 */
export const SNAPSHOT_CHECKSUM_SCOPE_VERSION = 'snapshot-checksum/2';

export const DeterministicRuntimeProfileSchema = Type.Object(
  {
    canonical_serialization_version: Type.Literal(CANONICAL_SERIALIZATION_VERSION, {
      description: 'Версия алгоритма канонической сериализации, которой посчитан checksum.',
    }),
    snapshot_checksum_scope_version: Type.Literal(SNAPSHOT_CHECKSUM_SCOPE_VERSION, {
      description: 'Версия области snapshot checksum: над каким подмножеством снимка он считан.',
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
    transaction_isolation_level: Type.String({
      minLength: 1,
      description:
        'Уровень изоляции канонической транзакции (ADR-010 §10.1). Часть профиля, потому что ' +
        'от него зависит НАБЛЮДАЕМАЯ семантика отказа: под repeatable read/serializable ' +
        'конкурентная команда получает 40001 вместо названного stale_world_version.',
    }),
  },
  { additionalProperties: false, description: 'Deterministic runtime profile (§9).' },
);

/**
 * Уровень изоляции канонической транзакции.
 *
 * Живёт в контракте, а не в персистентности, потому что попадает в runtime profile снимка и
 * участвует в проверке совместимости при восстановлении. Одно значение в одном месте: иначе
 * строка появилась бы отдельно в handler-е, отдельно в снимке и отдельно в тестах, и разошлась
 * бы молча.
 */
export const CANONICAL_TRANSACTION_ISOLATION_LEVEL = 'read committed';

export type DeterministicRuntimeProfile = Static<typeof DeterministicRuntimeProfileSchema>;

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
        // Обязателен, иначе объявленный pattern ключа декоративен: `Type.Record` порождает
        // `patternProperties`, а JSON Schema разрешает всё, что шаблону НЕ соответствует, если
        // `additionalProperties` не запрещены. Без этой строки ключи `"NOT A KEY!!"`, `""` и
        // `"../../etc/passwd"` принимались как валидные stream key.
        additionalProperties: false,
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
 * Поля, ВХОДЯЩИЕ в checksum: ровно то содержимое, которое воспроизводит replay (§9, B2).
 *
 * §9 требует одновременно двух вещей: `created_at` — «wall clock только как metadata», и
 * снимок валиден, если replay событий после `last_sequence` даёт тот же checksum, что полный
 * replay. Два прогона, выполненные в разное время, неизбежно получат разный `created_at`;
 * совместимы оба требования только тогда, когда `created_at` вне checksum.
 *
 * `deterministic_runtime_profile` исключён по более сильной причине. Профиль хоста внутри
 * checksum делает НАСТОЯЩУЮ cross-host регрессию детерминизма неотличимой от ожидаемой разницы
 * профиля: когда в ядро просочится ICU- или ordering-зависимое поведение, checksum разойдётся
 * между macOS и Linux, и объяснение «checksum различается между хостами, это ожидаемо» закроет
 * дефект как ожидаемый. Вне checksum равенство между хостами снова становится сигналом, а сам
 * профиль проверяется отдельно — `verifyRuntimeProfileCompatibility`, совместимостью, а не
 * равенством.
 */
export const SNAPSHOT_CHECKSUM_FIELDS = [
  'world_id',
  'last_sequence',
  'world_time',
  'bundles',
  'prng_stream_positions',
  'canonical_state',
] as const;

/**
 * Поля, СОЗНАТЕЛЬНО исключённые из checksum. Список существует не для документации: contract
 * test сверяет объединение двух списков с полями `SnapshotSchema`, поэтому новое поле снимка
 * невозможно добавить, молча оставив его вне checksum, — придётся объявить, к какой половине
 * оно относится. Контроль того же класса, что исчерпывающий union событий (A8).
 */
export const SNAPSHOT_CHECKSUM_EXCLUDED_FIELDS = [
  'checksum',
  'created_at',
  'deterministic_runtime_profile',
] as const;

/**
 * Checksum снимка над областью `SNAPSHOT_CHECKSUM_FIELDS`.
 *
 * Два правила, и оба обязательны, иначе значение перестаёт быть функцией состояния:
 *
 * 1. Поле `checksum` в расчёт НЕ входит — иначе значение было бы самоссылочным.
 * 2. `world_time` сначала приводится к канонической форме. `…T20:20:00+02:00` и
 *    `…T18:20:00.000Z` — один момент мира; если бы checksum считался по тексту как есть,
 *    один и тот же снимок давал бы разный checksum в зависимости от того, в каком смещении
 *    его записал источник. Ровно это ловит A3.
 */
export function snapshotChecksum(snapshot: Omit<Snapshot, 'checksum'>): string {
  const source = snapshot as unknown as Record<string, unknown>;
  const scoped: Record<string, unknown> = {};
  for (const field of SNAPSHOT_CHECKSUM_FIELDS) {
    scoped[field] = source[field];
  }

  const worldTime = scoped['world_time'];
  if (typeof worldTime === 'string') {
    const result = normalizeInstantField('/world_time', worldTime);
    if (isValidationIssue(result)) {
      throw new Error(`невозможно посчитать checksum снимка: ${result.path} ${result.message}`);
    }
    scoped['world_time'] = result.iso;
  }

  return requireChecksum(scoped, 'snapshot');
}

/**
 * Поля профиля, которые обязаны совпадать ТОЧНО: каждое из них — часть определения
 * канонического результата, а не свойство машины. Разные значения означают, что два checksum
 * посчитаны по разным правилам и несопоставимы в принципе.
 */
export const EXACT_MATCH_PROFILE_FIELDS = [
  'canonical_serialization_version',
  'snapshot_checksum_scope_version',
  'prng_version',
  'numeric_rounding_policy_version',
  'icu_version',
  'timezone',
  // Точное совпадение, а не major/minor: это дискретный режим, а не версия. «Почти тот же
  // уровень изоляции» не бывает — другой уровень означает другую семантику отказа (ADR-010).
  'transaction_isolation_level',
] as const;

/**
 * Поля, у которых §7 квалифицирует major/minor profile: patch-версия Node.js в квалификацию не
 * входит, поэтому её расхождение — не повод объявлять профиль несовместимым. Записывается при
 * этом точное значение: усечь запись означало бы потерять то, чего уже не восстановить.
 */
export const MAJOR_MINOR_PROFILE_FIELDS = ['node_version'] as const;

function majorMinor(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

/**
 * Совместимость профиля выполнения (§7, §9, B2).
 *
 * Не равенство: checksum больше не накрывает профиль, поэтому расхождение профиля обязано быть
 * ОТДЕЛЬНЫМ, названным отказом, а не подмешиваться в расхождение checksum. §7: «обновление
 * runtime не принимается, пока compatibility suite не сравнит replay и resimulation regression
 * bank на старом и новом profile» — значит несовместимость это «пока не квалифицировано», а не
 * «сломано».
 */
export function verifyRuntimeProfileCompatibility(
  qualified: DeterministicRuntimeProfile,
  candidate: DeterministicRuntimeProfile,
): ValidationResult<DeterministicRuntimeProfile> {
  const issues: ValidationIssue[] = [];

  for (const field of EXACT_MATCH_PROFILE_FIELDS) {
    if (qualified[field] !== candidate[field]) {
      issues.push({
        path: `/${field}`,
        message:
          `профиль несовместим по ${field}: квалифицирован ${JSON.stringify(qualified[field])}, ` +
          `предъявлен ${JSON.stringify(candidate[field])}; это часть определения канонического ` +
          'результата, поэтому два checksum несопоставимы',
      });
    }
  }

  for (const field of MAJOR_MINOR_PROFILE_FIELDS) {
    if (majorMinor(qualified[field]) !== majorMinor(candidate[field])) {
      issues.push({
        path: `/${field}`,
        message:
          `профиль несовместим по ${field}: квалифицирован major/minor ` +
          `${majorMinor(qualified[field])}, предъявлен ${majorMinor(candidate[field])}; ` +
          '§7 требует прогона compatibility suite до принятия нового runtime',
      });
    }
  }

  return issues.length > 0 ? { errors: issues } : { value: candidate };
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
