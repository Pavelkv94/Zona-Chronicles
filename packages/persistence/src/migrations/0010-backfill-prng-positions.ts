/**
 * 0010 — восстановление позиций PRNG у миров прежней поставки (B1, второй раунд верификации I02B).
 *
 * Миграция 0009 добавила `worlds.prng_stream_positions` с `default '{}'` и обосновала это тем,
 * что «до этой миграции ни одна команда не могла сделать розыгрыш, поэтому у любого
 * существующего мира позиции пусты по факту». Про КОМАНДЫ это верно, но розыгрыши делает
 * ГЕНЕЗИС: `seedAgents` распределяет агентов по локациям через `DeterministicRandomSource`, по
 * одному розыгрышу на агента. Значит у мира, созданного до 0009, настоящие позиции не пусты, а
 * 0009 объявила их пустыми.
 *
 * Цена ошибки — не косметическая: первый будущий розыгрыш по потоку агента повторил бы
 * генезисный при том же seed. Поймать это нечем. Позиции не входят в `WorldState`, поэтому
 * сверка checksum в `world replay` их не видит, а checksum снимка накрывает
 * `prng_stream_positions` и потому остаётся внутренне непротиворечивым с НЕВЕРНЫМ значением.
 *
 * Источник истины для восстановления — последний снимок мира: до 0009 позиции жили только там,
 * и именно там они записаны как факт, а не как пересчёт. Восстанавливаются ТОЛЬКО миры, у
 * которых колонка сейчас пуста: мир, уже имеющий позиции, их сам и записал (0009 и позже), и
 * перезаписывать его снимком, который может быть старее, нельзя.
 *
 * Мир БЕЗ единого снимка эта миграция не чинит и не может: его позиции — детерминированная
 * функция seed и контента, а `statements` — чистый SQL без доступа к PRNG (и это намеренное
 * свойство контракта миграций, см. `types.ts`). Такой мир чинит `world migrate` на уровне CLI,
 * пересчитывая генезис из `worlds.seed`.
 *
 * `phase: 'backfill'` — данные переносятся под уже существующую схему; ни одной колонки не
 * добавляется и не удаляется.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `update worlds w
      set prng_stream_positions = latest.prng_stream_positions
     from (
       select distinct on (world_id) world_id, prng_stream_positions
         from world_snapshots
        order by world_id, last_sequence desc
     ) latest
    where w.world_id = latest.world_id
      and w.prng_stream_positions = '{}'::jsonb`,
];

export const backfillPrngPositionsMigration: Migration = {
  id: '0010',
  name: 'backfill-prng-positions',
  phase: 'backfill',
  statements,
};
