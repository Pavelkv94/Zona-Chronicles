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
 * — чистая функция `(seed, streamKey, drawIndex)` без цепочки мутируемого состояния, поэтому
 * "продолжить поток с позиции N" означает буквально "начать считать с N": стартовые индексы
 * передаются доменному источнику и применяются за O(1).
 *
 * **Раньше здесь была ПРОКРУТКА** — N холостых вызовов `draw` при первом обращении к потоку.
 * Она давала тот же результат и была снята не за неверность, а за цену: 119 мс на команду при
 * позиции 5·10^6, и всё это время держится замок строки мира (M-E, второй раунд верификации).
 * Единственное, что оболочка теперь добавляет к доменному источнику, — учёт `positions()` для
 * следующего снимка.
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

export class PersistentRandomSource implements RandomSource {
  private readonly inner: RandomSource;
  private readonly startPositions: ReadonlyMap<string, number>;
  /** Следующий drawIndex по каждому потоку, К КОТОРОМУ ОБРАТИЛИСЬ в этом инстансе — то, что
   *  войдёт в `prng_stream_positions` СЛЕДУЮЩЕГО снимка (см. {@link positions}). */
  private readonly nextDrawIndex = new Map<string, number>();

  constructor(options: PersistentRandomSourceOptions) {
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
    // Проверка позиций СВОЯ, а не переложена на домен: сообщение об ошибке обязано называть
    // источник данных (снимок мира), а доменный источник о снимках не знает.
    this.inner = new DeterministicRandomSource(options.seed, options.startPositions);
  }

  draw(streamKey: string): RandomDraw {
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
}
