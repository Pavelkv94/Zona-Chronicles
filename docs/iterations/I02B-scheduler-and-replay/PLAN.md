# I02B — PLAN

Итерация: I02B «Scheduler, завершение journey и replay»
Ветка: `iteration/I00-harness` (продолжение практики I01/I02A)
Дата открытия: 2026-08-22
Вход: I02A (`dbbb86c`) — durable canonical core

## 0. Объём решён владельцем

Владелец выбрал **полный объём по мастер-плану**, без переноса replay и PRNG-позиций за I03:
«давай делать качественно, если сначала нужно всё сделать а потом визуал». Урезанный вариант
(только то, что нужно для картинки) отклонён.

Церемония остаётся сокращённой в том же виде, что и в I02A (§0 того плана), **с одним
изменением**: раунда ревью снова будет не один. I02A показала, что второй раунд находит
blocker, внесённый исправлениями первого, а узкие раунды 3–4 дали больше полного. Поэтому
здесь заранее планируются: один полный проход двумя ролями, затем **узкий** проход по
изменённым механизмам. Это не расширение церемонии, а перераспределение того же бюджета.

## 1. Гипотеза

Принятый план завершается сам, а canonical state переживает падение процесса: worker доводит
journey до конца без участия человека, остановка между началом и завершением ничего не теряет
и не дублирует, а пересимуляция из снимка и суффикса журнала даёт тот же checksum.

## 2. Observable demo

```sh
export DATABASE_URL=postgres://zona:zona_local_dev_only@localhost:5432/zona
pnpm world migrate && pnpm world init --seed 42

pnpm world run --agent agent:rook --route route:yard-to-bridge
pnpm world state            # traveling, запланировано завершение
pnpm world tick             # worker обрабатывает due actions
pnpm world state            # agent:rook уже в loc:bridge, idle
pnpm world events           # journey.started, journey.completed

# остановка между стартом и завершением ничего не теряет:
pnpm world run --agent agent:kite --route route:yard-to-bridge
# (worker не запускался)
pnpm world tick
pnpm world events           # ровно одно journey.completed на каждое journey.started

pnpm world replay           # пересимуляция из снимка: checksum совпадает
```

## 3. Требования (`11_REQUIREMENTS_TRACEABILITY`)

| ID | Что закрывает эта итерация |
| --- | --- |
| OPS-01 | Завершение: lease/reclaim, отсутствие пропусков и дублей при остановке worker-а между шагами |
| PR-04 | Мир меняется без открытого браузера — впервые буквально: время идёт, события появляются сами |
| SIM-01 | Персистентные позиции PRNG и replay: снимок + суффикс журнала = непрерывный прогон, побайтово |
| OPS-04 | Снимок как точка восстановления; сверка checksum после restore |

## 4. Scope

1. `scheduled_actions`: due_at (мировое время), priority, entity_id, action_id, состояние,
   lease_owner, lease_until.
2. `world_snapshots`: last_sequence, world_time, checksum, prng_stream_positions,
   canonical_state, deterministic_runtime_profile.
3. `journey.complete` как scheduled action; `journey.completed` уже в замороженном контракте.
4. Worker loop: захват due actions в стабильном порядке `(due_at, priority, entity_id,
   action_id)`, `SKIP LOCKED`, lease с истечением и reclaim.
5. Продвижение мирового времени к обработанному due timestamp.
6. Персистентные позиции PRNG; `UnavailableRandomSource` заменяется настоящим источником,
   восстанавливающим позиции из снимка.
7. `world tick` и `world replay` в CLI; replay сверяет checksum с непрерывным прогоном.
8. Уровень изоляции входит в `deterministic_runtime_profile` снимка (ADR-010 §10.1).
9. Гранты на новые таблицы в том же change (ADR-010 §10.3).

## 5. Out of scope

- projections, HTTP API, SSE, UI — I03;
- несколько миров одновременно и горизонтальное масштабирование worker-ов сверх двух в тесте;
- любые механики сверх `journey.start`/`journey.complete`.

## 6. Долги I02A, закрываемые здесь

| Долг | Что сделать |
| --- | --- |
| p-2 | Golden-реестр миграций сверять с предыдущим git-тегом в CI, а не только с литералами в дереве |
| p-3 | База сравнения `upgrade-path` берётся из тега, а не из текущего текста миграций; смоделировать поставку из двух миграций |
| n-7 | Три дополнительных запроса на принятую команду внутри замка — измерить и записать в бюджет |
| m-5 | `worlds.version` ≡ `last_sequence`: с батчем событий решить осознанно |
| Одна команда = одно событие | `decide` ставит `sequence + 1` каждому событию; снять вместе с батчем |

Закрыты ДО начала итерации: worktree для reviewer-сессий, ADR-010 (три решения).

## 7. Инварианты

1. Каждое `journey.started` получает ровно одно `journey.completed` — ни одного пропуска, ни
   одного дубля, независимо от того, сколько раз worker останавливали.
2. Порядок обработки due actions не зависит от скорости процесса: при равном `due_at` он задан
   `(priority, entity_id, action_id)`.
3. Истёкший lease освобождается и действие подхватывается другим worker-ом ровно один раз.
4. Мировое время монотонно и не обгоняет обработанный due timestamp.
5. Снимок + суффикс журнала даёт то же состояние и тот же checksum, что непрерывный прогон.
6. Replay не выполняет ни одного розыгрыша: outcome берётся из записанного события.

## 8. Отклонения от нормативного процесса

1. **Одна ветка вместо ветки итерации** — продолжение практики I01/I02A.
2. **Lead выполняет реализацию**, приёмку делают независимые reviewer-сессии — как в I02A.
   Теперь они работают в собственных worktree от проверяемого коммита.

Записаны ДО начала реализации.

## 9. Stop conditions

- due action исполняется дважды или теряется при остановке worker-а;
- порядок обработки зависит от скорости процесса;
- replay требует розыгрыша PRNG или даёт другой checksum;
- мировое время идёт назад;
- типы БД протекли в `@zona/domain` или `@zona/simulation`.
