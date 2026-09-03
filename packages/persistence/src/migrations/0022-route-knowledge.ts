/**
 * 0022 — субъективная карта риска: что агент знает о дорогах (I06-B, §12).
 *
 * ## Почему таблица, а не колонка
 *
 * У знания переменный размер и собственная жизнь: записей столько, сколько дорог агент прошёл, и
 * каждая помнит, откуда она взялась. Колонка с jsonb дала бы то же самое хранилище, но лишила бы
 * базу возможности что-либо проверить — а проверять здесь есть что: чужая дорога, чужой агент,
 * опасность вне диапазона.
 *
 * ## Почему `source_event_id` обязателен
 *
 * SIM-05: знание не появляется без provenance. Nullable-колонка означала бы, что знание МОЖЕТ
 * взяться ниоткуда, — и однажды взялось бы. Обязательность здесь не строгость, а формулировка
 * требования на языке, который его исполняет.
 *
 * Внешнего ключа на `world_events` при этом НЕТ, и это осознанно: журнал append-only и живёт
 * дольше состояния, а снимок восстанавливается вместе со знанием, события которого могут быть
 * старше горизонта хранения. Ссылка остаётся смысловой, а её целостность проверяет replay.
 *
 * Один элемент `statements` — ровно один SQL-оператор без завершающей точки с запятой.
 */
import type { Migration } from './types.ts';

const statements: readonly string[] = [
  `create table agent_route_knowledge (
     world_id        text    not null,
     agent_id        text    not null,
     route_id        text    not null,
     risk            integer not null,
     learned_at      text    not null,
     source_event_id text    not null,
     primary key (world_id, agent_id, route_id),
     foreign key (world_id, agent_id) references agents (world_id, agent_id),
     foreign key (world_id, route_id) references routes (world_id, route_id),
     constraint agent_route_knowledge_risk_check check (risk between 0 and 1000)
   )`,
];

/** `phase: 'expand'` — добавляется таблица; существующие данные не трогаются. */
export const routeKnowledgeMigration: Migration = {
  id: '0022',
  name: 'route-knowledge',
  phase: 'expand',
  statements,
};
