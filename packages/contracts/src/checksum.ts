/**
 * Канонический checksum (`09_EVENT_AND_COMMAND_CONTRACTS` §9).
 *
 * Определение из документа взято буквально: SHA-256 над канонической JSON-сериализацией.
 * Никакой «доменной соли» и никакого префикса версии внутри хешируемых байтов — иначе
 * значение перестало бы быть проверяемым независимой реализацией (`sha256sum` над
 * каноническим текстом обязан давать тот же hex).
 *
 * Версия алгоритма сериализации при этом всё равно часть контракта: она хранится рядом с
 * checksum, в `deterministic_runtime_profile.canonical_serialization_version` снапшота
 * (§9 требует его явно). Так две несовместимые версии алгоритма отличимы, а сам checksum
 * остаётся обычным SHA-256.
 */
import {
  type CanonicalizationError,
  canonicalize,
  isCanonicalizationError,
  requireCanonical,
} from './canonical-json.ts';
import { sha256Hex } from './sha256.ts';

export const CHECKSUM_ALGORITHM = 'sha256';

/** Форма checksum: `sha256:` и ровно 64 hex-символа в нижнем регистре. */
export const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface CanonicalChecksum {
  readonly checksum: string;
}

export type ChecksumResult = CanonicalChecksum | CanonicalizationError;

export function isChecksum(value: string): boolean {
  return CHECKSUM_PATTERN.test(value);
}

/** SHA-256 над канонической сериализацией значения либо ошибка канонизации с путём. */
export function canonicalChecksum(value: unknown): ChecksumResult {
  const canonical = canonicalize(value);
  if (isCanonicalizationError(canonical)) {
    return canonical;
  }
  return { checksum: `${CHECKSUM_ALGORITHM}:${sha256Hex(canonical.json)}` };
}

/** Checksum либо `Error` с меткой источника — для мест, где отказ обязан быть громким. */
export function requireChecksum(value: unknown, sourceLabel: string): string {
  return `${CHECKSUM_ALGORITHM}:${sha256Hex(requireCanonical(value, sourceLabel))}`;
}
