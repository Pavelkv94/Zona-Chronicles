/**
 * Replay: восстановление канонического состояния мира из снимка и суффикса журнала
 * (I02B, ACCEPTANCE C9, C10).
 *
 * ## Replay — это СВЁРТКА, а не повторное решение (C10)
 *
 * Replay применяет УЖЕ ЗАПИСАННЫЕ факты (`evolve`), а не принимает решения заново (`decide`):
 * outcome каждого события берётся из журнала, а не пересчитывается. `evolve(state, event)` в
 * домене — чистая функция БЕЗ параметра `RandomSource` (см. `evolve.ts`), поэтому у розыгрыша
 * здесь структурно неоткуда взяться: добавлять источник случайности в сигнатуру этого модуля
 * ради того, чтобы тест мог его подставить и проверить, что он не вызван, значило бы заводить
 * шов, существующий только чтобы его проверяли (тот же довод, что убрал `afterStep` из
 * публичного индекса пакета).
 *
 * Довод структурный, а не поведенческий, и у него есть слабое место: он держится, пока replay
 * остаётся свёрткой. Поэтому запрет продублирован КОНТРОЛЕМ, а не только текстом здесь —
 * `no-restricted-imports` в `eslint.config.mjs` для файлов replay: `evolve` разрешён, `decide` и
 * источники случайности запрещены, и правило падает в тот день, когда конструкцию перепишут через
 * повторный `decide`.
 *
 * Прежняя редакция этого абзаца ссылалась на правило dependency-cruiser
 * `replay-does-not-decide-or-draw`, которого в репозитории УЖЕ НЕ БЫЛО (M6, аудит I02B). Его
 * удалили как неисполнимое: `depcruise` строит граф по файлам, а `@zona/domain` — баррель, поэтому
 * любая реализация, которой нужен `evolve`, транзитивно «достигает» `decide`, и правило падало на
 * правильном коде. Ссылка на несуществующий контроль хуже отсутствия ссылки: читатель считает
 * свойство проверяемым, а проверки нет.
 *
 * ## Суффикс журнала обязан быть непрерывным
 *
 * `loadWorldEvents` уже проверяет checksum каждого события (M-3); здесь дополнительно
 * проверяется, что после снимка НЕТ ДЫР в `sequence` — разрыв означает, что снимок и журнал
 * относятся к разным историям мира (например, журнал был обрезан retention-политикой сильнее,
 * чем допускают доступные снимки), и «доиграть» такой суффикс значило бы тихо получить не тот
 * мир (SIM-01).
 */
import {
  canonicalChecksum,
  isCanonicalizationError,
  type Snapshot,
  type WorldEvent,
} from '@zona/contracts';
import { evolve, type WorldState } from '@zona/domain';
import type { DatabaseConnection } from './database.ts';
import { loadLatestSnapshot, type LoadSnapshotContext } from './snapshot-store.ts';
import { loadWorldEvents } from './world-repository.ts';

export interface ReplayResult {
  readonly state: WorldState;
  /** `canonicalChecksum` от {@link ReplayResult.state} — то же самое, что дал бы непрерывный
   *  прогон над тем же журналом (C9): сравнивать напрямую этим полем, а не пересчитывать заново. */
  readonly checksum: string;
  /** Сколько событий суффикса реально применено — 0 означает «снимок уже актуален». */
  readonly appliedEventCount: number;
}

/** События журнала строго после `snapshot.last_sequence`, БЕЗ дыр в `sequence`. */
const loadContinuousSuffix = async (
  db: DatabaseConnection,
  worldId: string,
  afterSequence: number,
): Promise<readonly WorldEvent[]> => {
  const events = await loadWorldEvents(db, worldId);

  // M5 аудита: снимок НОВЕЕ журнала — это не «пустой суффикс», а рассогласование. Реальный
  // случай: журнал восстановлен из более старого бэкапа, чем снимок (PITR). Без этой проверки
  // replay вернул бы состояние снимка как истину, и сверка checksum сошлась бы сама с собой.
  const lastSequence = events.length === 0 ? 0 : events[events.length - 1]!.sequence;
  if (afterSequence > lastSequence) {
    throw new Error(
      `replay: снимок мира ${worldId} на sequence ${String(afterSequence)} новее журнала ` +
        `(последняя записанная sequence ${String(lastSequence)}). Журнал и снимок ` +
        'рассогласованы — это не пустой суффикс.',
    );
  }
  const suffix = events.filter((event) => event.sequence > afterSequence);

  let expected = afterSequence + 1;
  for (const event of suffix) {
    if (event.sequence !== expected) {
      throw new Error(
        `replay: разрыв в журнале мира ${worldId} — после sequence ${expected - 1} ожидалась ` +
          `${expected}, получена ${String(event.sequence)}. Снимок и журнал относятся к разным ` +
          'историям — доиграть такой суффикс значило бы получить не тот мир (SIM-01).',
      );
    }
    expected += 1;
  }
  return suffix;
};

const checksumOf = (state: WorldState): string => {
  const result = canonicalChecksum(state);
  if (isCanonicalizationError(result)) {
    // `evolve` производит `WorldState` из канонически сериализуемых входов (снимок + события,
    // оба уже прошли checksum-проверку на чтении) — недостижимо на практике, но громкий сбой
    // здесь лучше, чем NaN-подобная тишина, если когда-нибудь станет достижимо.
    throw new Error(`replay: результат evolve неканоничен в ${result.path}: ${result.error}`);
  }
  return result.checksum;
};

/**
 * Суффикс обязан быть посчитан ТЕМИ ЖЕ bundle-ами, что объявляет снимок (m2 аудита I02B).
 *
 * Непрерывность `sequence` и `event_checksum` каждого события этого не видят по построению:
 * событие с чужой `rules_version` внутренне непротиворечиво и стоит на своём месте в журнале.
 * Но состояние снимка посчитано одними правилами, а суффикс — другими, и свёртка даёт мир,
 * которого никогда не было. Для SIM-01 это то же самое, что дыра в журнале, только тише.
 *
 * `schema_version` события сюда НЕ входит: это версия конверта события, а `bundles.schema` —
 * версия bundle JSON-схем. Разные величины; сравнивать их значило бы проверять совпадение
 * чисел, не имеющих отношения друг к другу.
 *
 * Смена правил по ходу жизни мира сегодня невозможна (`worlds` держит одну `rules_version`),
 * поэтому расхождение означает порчу или смешение историй. В тот день, когда версионный переход
 * появится, эта проверка обязана стать сравнением с ИСТОРИЕЙ версий, а не с одной.
 */
const assertSuffixBundlesMatchSnapshot = (
  worldId: string,
  snapshot: Snapshot,
  suffix: readonly WorldEvent[],
): void => {
  const expectedRules = snapshot.bundles.rules.version;
  const expectedContent = snapshot.bundles.content.version;

  for (const event of suffix) {
    if (event.rules_version !== expectedRules) {
      throw new Error(
        `replay: событие ${event.event_id} (sequence ${String(event.sequence)}) мира ${worldId} ` +
          `порождено rules_version ${event.rules_version}, а снимок объявляет ` +
          `${expectedRules}. Состояние снимка и суффикс посчитаны разными правилами — ` +
          'свёртка дала бы мир, которого не было (SIM-01).',
      );
    }
    if (event.content_version !== expectedContent) {
      throw new Error(
        `replay: событие ${event.event_id} (sequence ${String(event.sequence)}) мира ${worldId} ` +
          `порождено content_version ${event.content_version}, а снимок объявляет ` +
          `${expectedContent}. Состояние снимка и суффикс относятся к разному контенту (SIM-01).`,
      );
    }
  }
};

/**
 * Восстанавливает состояние мира из УЖЕ ЗАГРУЖЕННОГО и проверенного снимка плюс суффикс
 * журнала (C9). `snapshot` — то, что вернул {@link loadLatestSnapshot}/`loadSnapshotAt` из
 * `snapshot-store.ts`: checksum снимка уже сверен там, здесь это не повторяется.
 */
export const replayFromSnapshot = async (
  db: DatabaseConnection,
  worldId: string,
  snapshot: Snapshot,
): Promise<ReplayResult> => {
  // M5 аудита: снимок обязан принадлежать ТОМУ ЖЕ миру. Функция экспортирована из индекса
  // пакета, то есть вызвать её с чужим снимком может кто угодно, а расхождение проявилось бы
  // как «мир получился не тот», без единого признака причины.
  if (snapshot.world_id !== worldId) {
    throw new Error(`replay: снимок принадлежит миру ${snapshot.world_id}, а реплеится ${worldId}`);
  }

  const suffix = await loadContinuousSuffix(db, worldId, snapshot.last_sequence);
  assertSuffixBundlesMatchSnapshot(worldId, snapshot, suffix);

  let state = snapshot.canonical_state as WorldState;
  for (const event of suffix) {
    state = evolve(state, event);
  }

  return { state, checksum: checksumOf(state), appliedEventCount: suffix.length };
};

/**
 * Удобный вход: сам загружает ПОСЛЕДНИЙ снимок мира и доигрывает суффикс поверх него — то, что
 * делает `pnpm world replay` (PLAN §2). `bundles` — тот же контекст, что требует
 * {@link loadLatestSnapshot} (снимок в БД не самодостаточен, см. `snapshot-store.ts`).
 *
 * Снимков без хотя бы одного явно объявленного нет: у replay без снимка неоткуда взять
 * начальное состояние — `evolve` не создаёт агентов/маршрутов, это делает `initializeWorld` в
 * обход событийного журнала (см. `world-repository.ts`), поэтому "начальное состояние из
 * пустоты" структурно невозможно восстановить одними событиями.
 */
export const replayWorld = async (
  db: DatabaseConnection,
  worldId: string,
  context: LoadSnapshotContext,
): Promise<ReplayResult> => {
  const snapshot = await loadLatestSnapshot(db, worldId, context);
  if (snapshot === null) {
    throw new Error(
      `replay: у мира ${worldId} нет ни одного снимка. Replay восстанавливает состояние из ` +
        'снимка плюс суффикс журнала (C9) — без снимка взять начальное состояние неоткуда.',
    );
  }
  return replayFromSnapshot(db, worldId, snapshot);
};
