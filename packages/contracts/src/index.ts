/**
 * Публичные контракты мира. Пакет — leaf: не импортирует внутренние пакеты приложения
 * (ADR-002).
 *
 * Сейчас здесь только контракт момента времени. Он написан строгим намеренно:
 * `Date.parse` зависит от локали хоста и принимает несуществующие даты, а world time
 * обязан быть детерминированным (SIM-01). Смещение обязательно — момент без смещения
 * не является моментом.
 *
 * Envelopes команд и событий появятся в I01.
 */
export {
  type Instant,
  type InstantError,
  isInstantError,
  STRICT_ISO_8601_INSTANT_PATTERN,
  parseInstant,
  requireInstant,
  compareInstants,
  addMinutes,
} from './instant.ts';
