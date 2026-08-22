/**
 * 0005 — checksum канонического события, вычисленный ДО записи (M-3 аудита I02A).
 *
 * `payload` хранится в `jsonb`, а `jsonb` не сохраняет каноническую форму: он сортирует ключи
 * по (длина, байты), тогда как канонический порядок проекта — по кодовым точкам
 * (`compareByCodePoint`). Порядки расходятся уже на четырёх ключах:
 *
 * ```text
 * '{"bb":1,"a":2,"ccc":3,"z":1.50}'::jsonb::text -> {"a": 2, "z": 1.50, "bb": 1, "ccc": 3}
 * ```
 *
 * Сегодня расхождение безвредно, потому что прочитанный объект канонизируется заново. Но именно
 * на это опирается replay в I02B, а «безвредно, потому что никто пока не смотрит» — не свойство.
 * Checksum, снятый с события ДО того, как оно попало в `jsonb`, превращает предположение о
 * точности round-trip в проверяемый факт: чтение сверяется с ним и падает громко.
 *
 * `not null default ''` со снятием default: существующие dev-строки получают пустой checksum и
 * будут отвергнуты при чтении, новые обязаны приносить настоящий (тот же приём, что в 0004).
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `alter table world_events add column event_checksum text not null default ''`,
  `alter table world_events alter column event_checksum drop default`,
];

/** `phase: 'expand'` — колонка добавляется, ничего существующего не ломая. */
export const eventChecksumMigration: Migration = {
  id: '0005',
  name: 'event-checksum',
  phase: 'expand',
  statements,
};
