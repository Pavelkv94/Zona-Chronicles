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
 * остаётся свёрткой. Поэтому запрет продублирован КОНТРОЛЕМ, а не только текстом здесь — правило
 * `replay-does-not-decide-or-draw` в `.dependency-cruiser.cjs` запрещает этому файлу достигать
 * `decide.ts`/`random-source.ts`, в т.ч. транзитивно, и падает в тот день, когда конструкцию
 * перепишут через повторный `decide`.
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
 * Восстанавливает состояние мира из УЖЕ ЗАГРУЖЕННОГО и проверенного снимка плюс суффикс
 * журнала (C9). `snapshot` — то, что вернул {@link loadLatestSnapshot}/`loadSnapshotAt` из
 * `snapshot-store.ts`: checksum снимка уже сверен там, здесь это не повторяется.
 */
export const replayFromSnapshot = async (
  db: DatabaseConnection,
  worldId: string,
  snapshot: Snapshot,
): Promise<ReplayResult> => {
  const suffix = await loadContinuousSuffix(db, worldId, snapshot.last_sequence);

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
