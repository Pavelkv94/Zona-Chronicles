/**
 * `PersistentRandomSource` — `RandomSource`, продолжающий потоки PRNG с сохранённых позиций
 * (I02B, ACCEPTANCE C11).
 *
 * `DeterministicRandomSource` домена (`@zona/domain`) начинает КАЖДЫЙ поток с `drawIndex = 0` и
 * не даёт способа задать иную стартовую точку — и не обязан: чистое ядро не знает о снимках и
 * перезапусках, это забота persistence (ADR-002/ADR-003, домену запрещены часы, случайность и
 * сеть, но не запрещено persistence-обёртке ОСТАВАТЬСЯ детерминированной).
 *
 * Здесь — оболочка вокруг ДОМЕННОГО источника, а не собственная реализация PRNG: математика
 * (`deriveDrawValue`, hash streamKey) не дублируется. Значение draw в `DeterministicRandomSource`
 * — чистая функция `(seed, streamKey, drawIndex)` без цепочки мутируемого состояния (см.
 * докстринг `random-source.ts` в домене), поэтому "продолжить поток с позиции N" здесь означает
 * буквально: сделать N ХОЛОСТЫХ вызовов `draw(streamKey)` перед тем, как отдать управление
 * вызывающему. Копировать состояние не нужно и нечего — состояния между draw не существует.
 *
 * Прокрутка — ЛЕНИВАЯ, по потоку, при первом обращении к нему после восстановления: снимок
 * может содержать позиции для потоков (агентов, подсистем), к которым в текущем прогоне больше
 * никогда не обратятся, и прокручивать их вхолостую было бы чистой тратой.
 */
import { DeterministicRandomSource, type RandomDraw, type RandomSource } from '@zona/domain';

export interface PersistentRandomSourceOptions {
  readonly seed: number;
  /**
   * Позиции потоков на момент восстановления — то же, что `Snapshot.prng_stream_positions`
   * (§9 контракта): сколько draw уже сделано по каждому stable stream key. Поток, отсутствующий
   * в карте, ещё не использовался и продолжается с 0 — как в свежесозданном мире.
   */
  readonly startPositions?: Readonly<Record<string, number>>;
}

/** Позиция потока, которого раньше не существовало: свежий мир начинает каждый поток с нуля. */
const FRESH_POSITION = 0;

export class PersistentRandomSource implements RandomSource {
  private readonly inner: RandomSource;
  private readonly startPositions: ReadonlyMap<string, number>;
  /** Какие потоки уже прокручены вхолостую до стартовой позиции (прокрутка — не более раза). */
  private readonly caughtUpStreams = new Set<string>();
  /** Следующий drawIndex по каждому потоку, К КОТОРОМУ ОБРАТИЛИСЬ в этом инстансе — то, что
   *  войдёт в `prng_stream_positions` СЛЕДУЮЩЕГО снимка (см. {@link positions}). */
  private readonly nextDrawIndex = new Map<string, number>();

  constructor(options: PersistentRandomSourceOptions) {
    this.inner = new DeterministicRandomSource(options.seed);

    const positions = new Map<string, number>();
    for (const [streamKey, position] of Object.entries(options.startPositions ?? {})) {
      if (!Number.isSafeInteger(position) || position < 0) {
        throw new Error(
          `PersistentRandomSource: позиция потока "${streamKey}" обязана быть неотрицательным ` +
            `безопасным целым, получено ${String(position)}`,
        );
      }
      positions.set(streamKey, position);
    }
    this.startPositions = positions;
  }

  draw(streamKey: string): RandomDraw {
    this.catchUp(streamKey);
    const draw = this.inner.draw(streamKey);
    this.nextDrawIndex.set(streamKey, draw.drawIndex + 1);
    return draw;
  }

  /**
   * Текущие позиции ВСЕХ известных потоков — стартовые (для тех, к которым в этом инстансе не
   * обращались) поверх обновлённых (для тех, по которым были draw). Это ровно то, что пишется в
   * `prng_stream_positions` следующего снимка: позиция потока, которого не коснулись, обязана
   * пережить снимок неизменной, а не исчезнуть из карты.
   */
  positions(): Readonly<Record<string, number>> {
    const merged = new Map(this.startPositions);
    for (const [streamKey, position] of this.nextDrawIndex) {
      merged.set(streamKey, position);
    }
    return Object.fromEntries(merged);
  }

  /** Прокручивает поток вхолостую до сохранённой позиции. Не более одного раза на поток. */
  private catchUp(streamKey: string): void {
    if (this.caughtUpStreams.has(streamKey)) return;
    this.caughtUpStreams.add(streamKey);

    const target = this.startPositions.get(streamKey) ?? FRESH_POSITION;
    for (let index = 0; index < target; index += 1) {
      this.inner.draw(streamKey);
    }
  }
}
