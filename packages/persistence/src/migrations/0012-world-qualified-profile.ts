/**
 * 0012 — мир записывает профиль выполнения, под которым он квалифицирован (I03, M-C).
 *
 * ## Зачем
 *
 * Проверка профиля (M3 аудита I02B) стоит на ЧТЕНИИ снимка, а канонический мир изменяет
 * `executeCommand`, который снимков не читает вовсе. Процесс с неквалифицированным профилем
 * беспрепятственно дописывал события, а `world replay` — единственный детектор расхождения
 * детерминизма — именно в этот момент переставал запускаться. Детектор выключался ровно тогда,
 * когда он нужен.
 *
 * Чтобы сравнивать было с чем, профиль обязан быть записан у САМОГО МИРА, а не только в снимках:
 * снимок берётся по решению оператора и может отсутствовать.
 *
 * ## Backfill из генезисного снимка
 *
 * Колонка допускает `null` — «мир не квалифицирован». Заполняется у миров, у которых генезисный
 * снимок есть: там профиль записан фактом. Тот же приём, что в 0010, и по той же причине —
 * восстановить можно только то, что где-то записано, а придумывать значение контроля нельзя.
 *
 * Мир без снимка остаётся `null`, и это ВИДИМОЕ состояние: писатель обязан отказаться, а не
 * молча принять. Миры, созданные начиная с I03, снимок имеют всегда.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `alter table worlds add column qualified_runtime_profile jsonb`,
  `update worlds w
      set qualified_runtime_profile = genesis.deterministic_runtime_profile
     from world_snapshots genesis
    where genesis.world_id = w.world_id
      and genesis.last_sequence = 0
      and w.qualified_runtime_profile is null`,
];

/** `phase: 'expand'` — колонка добавляется и заполняется из уже записанного; данные не теряются. */
export const worldQualifiedProfileMigration: Migration = {
  id: '0012',
  name: 'world-qualified-profile',
  phase: 'expand',
  statements,
};
