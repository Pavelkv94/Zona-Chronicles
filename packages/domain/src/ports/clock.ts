/**
 * `Clock` port (ADR-003, SIM-01, A6).
 *
 * Единственный источник времени внутри `decide`/`evolve`. `now()` отдаёт МИРОВОЕ время —
 * `Instant` из `@zona/contracts` — а не wall clock: `recorded_at` события операционен и домена
 * не касается (`world-event.ts`: "не участвует в доменной логике и replay"). Слой, который
 * когда-нибудь проставит `recorded_at` при записи факта, живёт вне домена (I02A) и здесь не
 * реализуется.
 */
import { type Instant, requireInstant } from '@zona/contracts';

export interface Clock {
  now(): Instant;
}

/**
 * Детерминированная тестовая/оркестраторская реализация: всегда отдаёт один и тот же
 * инъектированный момент. Часы не тикают сами — вызывающий код собирает новый `FixedClock`
 * (или использует другой момент) на каждый шаг симуляции, который должен продвинуть время.
 */
export class FixedClock implements Clock {
  private readonly instant: Instant;

  constructor(iso: string) {
    this.instant = requireInstant(iso, 'FixedClock');
  }

  now(): Instant {
    return this.instant;
  }
}
