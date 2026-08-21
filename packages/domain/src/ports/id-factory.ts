/**
 * `IdFactory` port (ADR-003, `identifier.ts` в `@zona/contracts`, A6).
 *
 * Единственный источник runtime id (`evt_…`, `cmd_…`, `corr_…`) внутри домена. Формат — ULID:
 * 26 символов Crockford base32 в верхнем регистре (решение lead-а I01, зафиксировано в
 * `identifier.ts`); `isRuntimeId`/`RUNTIME_ID_PATTERN` оттуда же — источник истины для формы.
 *
 * ## Что эта реализация ГАРАНТИРУЕТ, а что нет
 *
 * `SequentialIdFactory` — детерминированный тестовый/оркестраторский порт: тот же (seed,
 * порядок вызовов) даёт тот же id, разные вызовы в рамках одного инстанса не повторяются, и
 * форма всегда проходит `isRuntimeId`. Он НЕ гарантирует ту сортировку id по времени создания,
 * ради которой в проде выбран именно ULID (`identifier.ts`) — настоящий time-sortable ULID
 * (wall clock + секьюрная случайность) выдаёт адаптер персистентности в I02A; домен часы не
 * читает (SIM-01) и здесь этот адаптер не реализуется.
 *
 * `crypto` запрещён в домене, поэтому тело id строится тем же детерминированным FNV-1a-хешем,
 * что и `RandomSource` (`internal/deterministic-hash.ts`), растянутым до 130 бит (26 символов
 * × 5 бит) и закодированным в алфавит Crockford base32.
 */
import { ULID_ALPHABET, ULID_BODY_LENGTH, type RuntimeIdPrefix } from '@zona/contracts';
import { fnv1a32 } from '../internal/deterministic-hash.ts';

export interface IdFactory {
  next(prefix: RuntimeIdPrefix): string;
}

const ULID_BODY_BITS = BigInt(ULID_BODY_LENGTH * 5);

/** Растягивает `seedText` до `bitsNeeded` бит повторным FNV-1a по счётчику — просто и детерминированно. */
function expandBits(seedText: string, bitsNeeded: bigint): bigint {
  let bits = 0n;
  let collected = 0n;
  let counter = 0;
  while (collected < bitsNeeded) {
    const chunk = fnv1a32(`${seedText}#${counter}`);
    bits = (bits << 32n) | BigInt(chunk);
    collected += 32n;
    counter += 1;
  }
  return bits >> (collected - bitsNeeded);
}

function encodeUlidBody(bits: bigint): string {
  const chars: string[] = new Array<string>(ULID_BODY_LENGTH);
  let remaining = bits;
  for (let index = ULID_BODY_LENGTH - 1; index >= 0; index -= 1) {
    chars[index] = ULID_ALPHABET[Number(remaining & 31n)]!;
    remaining >>= 5n;
  }
  return chars.join('');
}

export class SequentialIdFactory implements IdFactory {
  private readonly seed: number;
  private counter = 0;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new Error(`IdFactory: seed обязан быть безопасным целым, получено ${String(seed)}`);
    }
    this.seed = seed;
  }

  next(prefix: RuntimeIdPrefix): string {
    const seedText = `${this.seed}:${prefix}:${this.counter}`;
    this.counter += 1;
    return `${prefix}_${encodeUlidBody(expandBits(seedText, ULID_BODY_BITS))}`;
  }
}
