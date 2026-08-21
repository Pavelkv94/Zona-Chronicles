/**
 * `RandomSource` port (ADR-003, `07_MVP_MECHANICS_SPEC` §7, A7).
 *
 * Домен не вызывает `Math.random()` (запрещено lint-ом, A6) — вся случайность идёт через этот
 * инъектированный порт. §7 требует, чтобы поток случайности был разделён по stable stream key
 * (мир, агент, сцена, система); A7 требует, чтобы (seed, stream key) воспроизводили одну и ту
 * же последовательность, а разные stream key при одном seed были НЕЗАВИСИМЫ — не просто другой
 * текст, а сдвигом друг к другу не приводимы (см. property-тесты `random-source.property.test.ts`).
 *
 * Каждый draw сообщает audit-поля (`streamKey`, `drawIndex`), из которых потребитель собирает
 * `RandomAudit` контракта (`stream_key`, `first_draw_index`, `draw_count` — последнее считает
 * сам потребитель по числу draw, которые он сделал).
 *
 * ## Почему PRNG устроен именно так
 *
 * `crypto` запрещён в домене, поэтому генератор — некриптографический, но с двумя свойствами,
 * которые здесь и нужны: детерминизм (то же состояние → тот же выход) и хорошее перемешивание
 * (маленькая разница входа → совсем другое состояние, иначе потоки оказались бы похожи).
 *
 * 1. Seed конкретного потока выводится из (`seed`, `streamKey`) через FNV-1a (хеш ключа) и два
 *    прохода SplitMix32 (`internal/deterministic-hash.ts`) — оба шага имеют сильный
 *    avalanche-эффект, поэтому близкие `streamKey` ("agent:rook" и "agent:rook") дают никак не
 *    связанные состояния, а не соседние точки одной последовательности.
 * 2. Сам поток продвигается Mulberry32 — маленьким PRNG с известными и достаточными для игровой
 *    механики статистическими свойствами; состояние явно хранится по каждому `streamKey`
 *    отдельно, поэтому потоки не делят один счётчик и не могут стать сдвинутыми копиями друг
 *    друга «по построению».
 */
import { fnv1a32, splitmix32Next } from '../internal/deterministic-hash.ts';

export interface RandomDraw {
  /** Равномерно распределено в [0, 1). */
  readonly value: number;
  readonly streamKey: string;
  /** Индекс draw внутри СВОЕГО потока; независимый счётчик на каждый `streamKey`, с 0. */
  readonly drawIndex: number;
}

export interface RandomSource {
  draw(streamKey: string): RandomDraw;
}

function deriveStreamState(seed: number, streamKey: string): number {
  const keyHash = fnv1a32(streamKey);
  // XOR с seed, домноженным на нечётную константу, а не простое сложение: нужно, чтобы разница
  // в один бит streamKey не давала соседний seed соседнего потока.
  const mixed = ((seed >>> 0) ^ Math.imul(keyHash, 0x2545f491)) >>> 0;
  return splitmix32Next(splitmix32Next(mixed));
}

/** Один шаг Mulberry32. `state` — то, что персистентно хранится между draw одного потока. */
function mulberry32Step(state: number): { readonly state: number; readonly value: number } {
  const nextState = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(nextState ^ (nextState >>> 15), nextState | 1);
  t = (t + Math.imul(t ^ (t >>> 7), t | 61)) | 0;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: nextState, value };
}

interface StreamCursor {
  readonly state: number;
  readonly drawIndex: number;
}

/**
 * Детерминированная реализация порта. Один seed на инстанс; потоки создаются лениво при первом
 * `draw(streamKey)` и живут независимо друг от друга до конца жизни инстанса.
 */
export class DeterministicRandomSource implements RandomSource {
  private readonly seed: number;
  private readonly streams = new Map<string, StreamCursor>();

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new Error(`RandomSource: seed обязан быть безопасным целым, получено ${String(seed)}`);
    }
    this.seed = seed;
  }

  draw(streamKey: string): RandomDraw {
    const cursor = this.streams.get(streamKey) ?? {
      state: deriveStreamState(this.seed, streamKey),
      drawIndex: 0,
    };
    const stepped = mulberry32Step(cursor.state);
    this.streams.set(streamKey, { state: stepped.state, drawIndex: cursor.drawIndex + 1 });
    return { value: stepped.value, streamKey, drawIndex: cursor.drawIndex };
  }
}
