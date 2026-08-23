/**
 * Запись и чтение снимков мира (I02B, ACCEPTANCE C8, ADR-010 §10.1/§10.2).
 *
 * ## Снимок в БД САМ ПО СЕБЕ не самодостаточен
 *
 * Таблица `world_snapshots` (миграция 0007) сознательно не хранит `bundles` (rules/content/schema
 * `BundleRef`): immutable bundle адресуется по checksum, а его версии уже лежат в `worlds`
 * (`rules_version`/`content_version`/`schema_version`) — заводить для тех же данных второе место
 * хранения значило бы получить второй источник правды, который рано или поздно разойдётся с
 * первым. Но `bundles` — часть `Snapshot.checksum` (`SNAPSHOT_CHECKSUM_FIELDS`), поэтому строка
 * `world_snapshots` без них — неполное описание снимка, а не полное.
 *
 * Отсюда следствие для API этого модуля: `bundles` передаёт ВЫЗЫВАЮЩИЙ и на запись, и на чтение
 * (он же тот, кто загрузил immutable bundle с диска/из retention store и посчитал его checksum
 * через `bundleRefFor`). На чтении переданные `bundles` не подставляются молча — они участвуют в
 * пересчёте checksum наравне с остальными полями, и любое расхождение (чужие/подменённые/не той
 * версии bundles) обнаруживается ТЕМ ЖЕ путём, что порча `canonical_state`: громким отказом
 * {@link verifySnapshotChecksum}, а не тихо восстановленным «почти тем же» миром.
 *
 * ## `jsonb` не сохраняет каноническую форму (ADR-010 §10.2)
 *
 * `canonical_state`, `prng_stream_positions` и `deterministic_runtime_profile` хранятся `jsonb`:
 * он запрашиваем и понадобится проекциям (I03), но сортирует ключи по (длина, байты), а не по
 * кодовым точкам — канонический порядок расходится с ним уже на нескольких ключах. Поэтому
 * checksum снимается ДО записи (в {@link writeSnapshot}, тем же приёмом, что `event_checksum` в
 * `command-handler.ts`), а не полагается на то, что `jsonb` вернёт байты как есть. На чтении
 * {@link loadLatestSnapshot}/{@link loadSnapshotAt} пересчитывают checksum заново — `canonicalize`
 * пересортировывает ключи независимо от того, в каком порядке их отдал `jsonb`, поэтому сама
 * перестановка ключей НЕ портит checksum; портит только реально другое значение. Расхождение —
 * сбой (M-3, тот же приём, что `loadWorldEvents`), а не тихо другой снимок.
 */
import {
  isValidationFailure,
  requireCanonical,
  snapshotChecksum,
  verifyRuntimeProfileCompatibility,
  verifySnapshotChecksum,
  type DeterministicRuntimeProfile,
  type Snapshot,
} from '@zona/contracts';
import { requireSafeInteger, type DatabaseConnection } from './database.ts';

/**
 * Всё, из чего собирается снимок, КРОМЕ `checksum` (он считается здесь) и КРОМЕ операционных
 * полей, которых у снимка нет (в отличие от `scheduled_actions`, снимок целиком канонический,
 * см. `SNAPSHOT_CHECKSUM_FIELDS`/`SNAPSHOT_CHECKSUM_EXCLUDED_FIELDS`).
 */
export interface SnapshotContent {
  readonly worldId: string;
  readonly lastSequence: number;
  readonly worldTime: string;
  readonly bundles: Snapshot['bundles'];
  readonly deterministicRuntimeProfile: DeterministicRuntimeProfile;
  readonly prngStreamPositions: Readonly<Record<string, number>>;
  /** Форма принадлежит домену (`WorldState`); контракт требует лишь канонической сериализуемости. */
  readonly canonicalState: unknown;
  /** Wall clock создания снимка; по умолчанию — реальные часы этого процесса. Метаданные, не
   *  участвует в checksum (§9). */
  readonly createdAt?: Date;
}

/**
 * Что обязан подставить вызывающий на чтении.
 *
 * `bundles` — потому что строка `world_snapshots` их не хранит (см. докстринг файла).
 *
 * `runtimeProfile` — профиль ЭТОГО процесса, тем же приёмом и по родственному доводу (M3, аудит
 * I02B). Профиль снимка сознательно вне checksum (`SNAPSHOT_CHECKSUM_FIELDS`): внутри него
 * настоящая cross-host регрессия детерминизма стала бы неотличима от ожидаемой разницы машин.
 * Плата за это ровно одна — расхождение профиля обязано проверяться ОТДЕЛЬНО, иначе не
 * проверяется ничем. ADR-010 §10.1 утверждал, что оно проверяется
 * `verifyRuntimeProfileCompatibility`; до M3 функция не вызывалась ни на одном пути.
 *
 * Значение строит вызывающий, а не этот модуль: профиль включает свойства хоста (`node_version`,
 * `icu_version`), а `packages/persistence` их читать не должен — это тот же порт, что `Clock` и
 * `RandomSource` в домене (ADR-002). CLI собирает его в `currentDeterministicRuntimeProfile`.
 */
export interface LoadSnapshotContext {
  readonly bundles: Snapshot['bundles'];
  readonly runtimeProfile: DeterministicRuntimeProfile;
}

/**
 * Записывает снимок. Checksum считается здесь, ДО записи, над `SnapshotContent` — не доверяется
 * значению, пришедшему извне: единственный способ получить снимок с верным checksum — записать
 * его через эту функцию.
 *
 * Первичный ключ `world_snapshots` — `(world_id, last_sequence)`: повторная запись снимка на ТОЙ
 * ЖЕ sequence — не идемпотентный повтор, а попытка перезаписать точку восстановления, и она
 * обязана упасть на ограничении, а не тихо пройти (тот же довод, что у `initializeWorld`).
 */
export const writeSnapshot = async (
  db: DatabaseConnection,
  content: SnapshotContent,
): Promise<Snapshot> => {
  const createdAt = content.createdAt ?? new Date();

  const withoutChecksum: Omit<Snapshot, 'checksum'> = {
    world_id: content.worldId,
    last_sequence: content.lastSequence,
    world_time: content.worldTime,
    created_at: createdAt.toISOString(),
    bundles: content.bundles,
    deterministic_runtime_profile: content.deterministicRuntimeProfile,
    prng_stream_positions: { ...content.prngStreamPositions },
    canonical_state: content.canonicalState,
  };
  const checksum = snapshotChecksum(withoutChecksum);
  const snapshot: Snapshot = { ...withoutChecksum, checksum };
  const label = `world_snapshots(${snapshot.world_id}:${String(snapshot.last_sequence)})`;

  await db
    .insertInto('world_snapshots')
    .values({
      world_id: snapshot.world_id,
      last_sequence: snapshot.last_sequence,
      world_time: snapshot.world_time,
      checksum: snapshot.checksum,
      prng_stream_positions: requireCanonical(
        snapshot.prng_stream_positions,
        `${label}.prng_stream_positions`,
      ),
      canonical_state: requireCanonical(snapshot.canonical_state, `${label}.canonical_state`),
      deterministic_runtime_profile: requireCanonical(
        snapshot.deterministic_runtime_profile,
        `${label}.deterministic_runtime_profile`,
      ),
      created_at: createdAt,
    })
    .execute();

  return snapshot;
};

/**
 * Профиль выполнения, под которым снят снимок, не квалифицирован для текущего процесса.
 *
 * Отдельный класс, а не `Error` (m-5 второго раунда верификации): для оператора «SIM-01 нарушен»
 * и «SIM-01 не проверен» — разные события с разными действиями. Первое означает, что мир и его
 * журнал разошлись; второе — что мир цел, но текущий runtime ещё не квалифицирован (§7). Раньше
 * `world replay` возвращал на оба один и тот же ненулевой код.
 */
export class UnqualifiedRuntimeProfileError extends Error {
  readonly code = 'UNQUALIFIED_RUNTIME_PROFILE';

  constructor(message: string) {
    super(message);
    this.name = 'UnqualifiedRuntimeProfileError';
  }
}

/**
 * Собирает `Snapshot` из строки `world_snapshots` и переданных `bundles`, затем ПРОВЕРЯЕТ его по
 * `checksum`, записанному в строке (M-3, ADR-010 §10.2). Расхождение — громкий сбой: снимок,
 * прочитанный в форме, не совпадающей с тем, что было записано (или с чужими `bundles`), не
 * является тем же миром, и молчать об этом нельзя.
 */
const rowToSnapshot = (
  row: {
    readonly world_id: string;
    readonly last_sequence: string | number;
    readonly world_time: string;
    readonly checksum: string;
    readonly prng_stream_positions: unknown;
    readonly canonical_state: unknown;
    readonly deterministic_runtime_profile: unknown;
    readonly created_at: Date;
  },
  context: LoadSnapshotContext,
): Snapshot => {
  const label = `world_snapshots(${row.world_id}:${String(row.last_sequence)})`;
  const snapshot: Snapshot = {
    world_id: row.world_id,
    last_sequence: requireSafeInteger(row.last_sequence, `${label}.last_sequence`),
    world_time: row.world_time,
    created_at: row.created_at.toISOString(),
    bundles: context.bundles,
    deterministic_runtime_profile: row.deterministic_runtime_profile as DeterministicRuntimeProfile,
    prng_stream_positions: row.prng_stream_positions as Readonly<Record<string, number>>,
    canonical_state: row.canonical_state,
    checksum: row.checksum,
  };

  const verified = verifySnapshotChecksum(snapshot);
  if (isValidationFailure(verified)) {
    throw new Error(
      `persistence: снимок ${label} не прошёл проверку checksum: ` +
        `${verified.errors.map((issue) => `${issue.path} ${issue.message}`).join('; ')}. ` +
        'Снимок невосполним как точка восстановления — расхождение обязано быть сбоем, а не ' +
        'тихо другим миром (M-3, ADR-010 §10.2).',
    );
  }

  // Профиль проверяется ПОСЛЕ checksum намеренно: порча содержимого — более сильный диагноз, и
  // сообщать «профиль несовместим» о снимке, который вдобавок повреждён, значило бы назвать
  // причиной вторую по важности из двух.
  const compatible = verifyRuntimeProfileCompatibility(
    // Квалифицирован тот профиль, ПОД КОТОРЫМ мир был посчитан: он определение канонического
    // результата, записанное вместе с состоянием. Профиль читающего процесса — предъявленный.
    snapshot.deterministic_runtime_profile,
    context.runtimeProfile,
  );
  if (isValidationFailure(compatible)) {
    throw new UnqualifiedRuntimeProfileError(
      `persistence: снимок ${label} снят под несовместимым профилем выполнения: ` +
        `${compatible.errors.map((issue) => `${issue.path} ${issue.message}`).join('; ')}. ` +
        'Несовместимость означает «профиль ещё не квалифицирован» (§7), а не «мир сломан»: ' +
        'принять её тихо значило бы продолжить канонический мир по другим правилам счёта, ' +
        'и расхождение всплыло бы как необъяснимое расхождение checksum (M3, ADR-010 §10.1).',
    );
  }
  return snapshot;
};

/** Последний по `last_sequence` снимок мира. `null` — снимков ещё нет. */
export const loadLatestSnapshot = async (
  db: DatabaseConnection,
  worldId: string,
  context: LoadSnapshotContext,
): Promise<Snapshot | null> => {
  const row = await db
    .selectFrom('world_snapshots')
    .selectAll()
    .where('world_id', '=', worldId)
    .orderBy('last_sequence', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return null;
  return rowToSnapshot(row, context);
};

/**
 * Снимок мира РОВНО на указанной `lastSequence`. `null` — снимка на этой sequence нет.
 *
 * Отдельная от {@link loadLatestSnapshot} функция, а не параметр по умолчанию: replay из
 * ПРОИЗВОЛЬНОЙ точки (C9 — «снимок плюс суффикс журнала») обязан уметь адресовать конкретный
 * снимок, а не только последний, иначе перепроверка «снимок + суффикс = непрерывный прогон»
 * могла бы тестировать только один снимок из истории мира.
 */
export const loadSnapshotAt = async (
  db: DatabaseConnection,
  worldId: string,
  lastSequence: number,
  context: LoadSnapshotContext,
): Promise<Snapshot | null> => {
  const row = await db
    .selectFrom('world_snapshots')
    .selectAll()
    .where('world_id', '=', worldId)
    // `last_sequence` — `bigint`: драйвер `pg` отдаёт его строкой (см. `BigIntColumn` в
    // `database.ts`), и Kysely типизирует операнд WHERE по SELECT-типу колонки, а не по
    // числу, которое удобно вызывающему коду.
    .where('last_sequence', '=', String(lastSequence))
    .executeTakeFirst();
  if (row === undefined) return null;
  return rowToSnapshot(row, context);
};
