# Event and command contracts v1

Статус: draft baseline before executable schema  
Дата: 2026-08-20

Документ фиксирует форму контрактов до создания code repository. Исполняемая TypeBox-схема и SQL migration должны быть написаны TDD и считаются окончательным источником после реализации.

## 1. Идентификаторы

- статический content: стабильный slug с namespace, например `loc:quiet-yard`;
- runtime entity: time-sortable ID через injected `IdFactory`;
- event: глобальный `event_id` плюс уникальная пара `(world_id, sequence)`;
- command: уникальный `command_id`, одновременно idempotency key на границе приложения;
- причинность использует event IDs, не текстовые описания;
- ID не переиспользуются после удаления/смерти.

Конкретную библиотеку ID выбрать в executable skeleton. Домен не вызывает её напрямую.

## 2. Command envelope

```json
{
  "command_id": "cmd_01...",
  "world_id": "world:prototype",
  "type": "journey.start",
  "schema_version": 1,
  "actor_id": "agent:rook",
  "issued_at_world_time": "2034-05-17T18:20:00Z",
  "expected_world_version": 184232,
  "correlation_id": "corr_01...",
  "caused_by_event_id": "evt_01...",
  "payload": {
    "route_id": "route:yard-to-bridge"
  }
}
```

Правила:

- command выражает намерение, а не факт;
- повторный `command_id` возвращает сохранённый результат и не создаёт новые события;
- command handler возвращает `accepted(events)` или typed rejection;
- accepted и rejected result одинаково сохраняются в command journal для idempotency;
- ожидаемые отказы не являются исключениями;
- `expected_world_version` защищает от устаревшего решения;
- системные команды используют явного actor `system:*`.

Минимальные rejection codes:

```text
invalid_schema
stale_world_version
actor_not_actionable
precondition_failed
resource_unavailable
route_unavailable
conflicting_scene
```

Дубликат `command_id` возвращает прежний accepted/rejected result и не является новым доменным отказом. Техническая ошибка базы или bug не маскируются доменным rejection.

## 3. World event envelope

```json
{
  "event_id": "evt_01...",
  "world_id": "world:prototype",
  "sequence": 184233,
  "world_time": "2034-05-17T18:20:00Z",
  "recorded_at": "2026-08-20T12:01:02Z",
  "type": "journey.started",
  "schema_version": 1,
  "rules_version": "0.1.0",
  "content_version": "0.1.0",
  "actor_ids": ["agent:rook"],
  "subject_ids": ["route:yard-to-bridge"],
  "location_id": "loc:quiet-yard",
  "correlation_id": "corr_01...",
  "causation_id": "evt_01...",
  "caused_by": ["evt_01..."],
  "command_id": "cmd_01...",
  "random_audit": null,
  "payload": {
    "route_id": "route:yard-to-bridge",
    "expected_arrival": "2034-05-17T18:52:00Z"
  }
}
```

### Семантика полей

- `world_time` — время факта внутри мира;
- `recorded_at` — операционный wall clock, не участвующий в доменной логике/replay;
- `sequence` — строгий порядок commit внутри мира;
- `correlation_id` — весь workflow/scene/plan;
- `causation_id` — непосредственное событие-триггер;
- `caused_by` — дополнительные причинные рёбра для летописи;
- `command_id` — идемпотентный источник, если событие создано командой;
- `random_audit` — stream/draw metadata только если outcome использовал случайность;
- `payload` — TypeBox discriminated schema конкретного event type.

Canonical event не содержит художественный текст, UI importance и observer visibility. Они принадлежат projections/representations.

## 4. Event naming и версия

- `noun.past_tense`, например `journey.started`, `obligation.broken`;
- тип означает уже произошедший факт;
- поля envelope не дублируются в payload;
- breaking change payload увеличивает `schema_version` конкретного type;
- semantic change правил увеличивает `rules_version`;
- изменение исходного world content увеличивает `content_version`;
- старые события не переписываются; upcaster преобразует их для нового reducer/projection;
- upcaster не выдумывает данные. Если поля невозможно восстановить, projection учитывает старую форму явно.

## 5. Event batch и транзакция

Одна принятая команда может породить упорядоченный batch событий. Sequence присваивается внутри транзакции.

```text
BEGIN
  acquire world/version lock
  check idempotency
  decide -> event batch
  append events
  evolve/update materialized canonical state
  update scheduled actions
  insert outbox records
  persist command result
COMMIT
```

Любая ошибка откатывает весь batch. Narrative generation и тяжёлые projections происходят после commit.

## 6. Scheduled action contract

```json
{
  "action_id": "act_01...",
  "world_id": "world:prototype",
  "due_world_time": "2034-05-17T18:52:00Z",
  "priority": 50,
  "actor_id": "agent:rook",
  "type": "journey.complete",
  "schema_version": 1,
  "correlation_id": "corr_01...",
  "scheduled_by_event_id": "evt_01...",
  "expected_actor_version": 17,
  "preconditions": [{"type": "agent.is_on_route", "route_id": "route:yard-to-bridge"}],
  "payload": {"route_id": "route:yard-to-bridge"}
}
```

Scheduled action не фиксирует глобальный `expected_world_version`: несвязанное событие другого агента не должно делать его stale. Используется версия затронутой сущности/aggregate и явные preconditions. Для системного action `actor_id` обязателен и имеет вид `system:world`, `system:weather` и т.п.; nullable actor не допускается.

Worker выбирает due actions по:

```text
due_world_time ASC, priority ASC, actor_id ASC, action_id ASC
```

`status`: pending → claimed → completed/cancelled. Lease timeout возвращает зависший `claimed` в pending. Повторное завершение предотвращает unique link с resulting command/event batch.

## 7. Observer signal

```json
{
  "signal_id": "sig_01...",
  "world_id": "world:prototype",
  "observed_world_time": "2034-05-17T18:24:00Z",
  "revealed_world_time": "2034-05-17T18:24:10Z",
  "source_type": "open_radio",
  "source_id": "radio:emergency",
  "precision": "approximate",
  "confidence": 0.72,
  "event_ids": ["evt_01..."],
  "claim_ids": ["claim_01..."],
  "payload": {}
}
```

Signal может ссылаться на claim без подтверждённого canonical event. UI обязан различать это визуально. Удаление/скрытие representation не удаляет signal или event.

## 8. Representation contract (template-only core)

```json
{
  "representation_id": "rep_01...",
  "purpose": "radio_message",
  "source_signal_ids": ["sig_01..."],
  "source_event_ids": ["evt_01..."],
  "renderer": "template",
  "renderer_version": "radio-message/1",
  "input_hash": "sha256:...",
  "status": "validated",
  "validation": {
    "grounded": true,
    "violations": []
  },
  "content": {"text": "..."}
}
```

Representation можно перегенерировать. Она не участвует в canonical checksum. `input_hash + renderer + renderer_version` образуют core cache/idempotency key.

До Gate E это весь обязательный контракт: provider/model/prompt/token поля и generation queue не создаются заранее. Опциональная I18 добавляет отдельный `generation_attempt` с provider, model, prompt/output version, usage, latency и validation result. Он ссылается на `representation_id`, но не расширяет world event и не меняет signal/claim.

## 9. Snapshot contract

Snapshot содержит:

- world id, last sequence и world time;
- rules/content/schema bundle versions и checksums;
- deterministic runtime profile: canonical serialization version, PRNG version, numeric/rounding policy и поддерживаемый Node.js/ICU/timezone profile;
- canonical state;
- PRNG stream positions;
- pending scheduled actions либо ссылку на их согласованный DB state;
- checksum канонически сериализованного содержимого;
- created_at wall clock только как metadata.

Checksum считается как SHA-256 над канонической JSON-сериализацией: UTF-8, стабильный порядок object keys, фиксированное представление дат/чисел и отсутствие операционных lease/claim полей. Snapshot валиден, если replay событий после `last_sequence` приводит к тому же checksum, что полный replay. Указанные immutable bundles должны разрешаться по checksum из retention store; snapshot с отсутствующим/mismatched bundle не запускается «на ближайшей версии», а отклоняется как невосстановимый до возврата точного artifact.

Нужно различать:

- **replay** — применение сохранённых event outcomes без PRNG;
- **resimulation** — повторный `decide` с тем же snapshot, rules/content version и versioned PRNG streams.

Оба режима тестируются, но только replay используется для обязательного восстановления production state.

## 10. Projection contract

Каждая projection хранит:

- `projection_name` и code/schema version;
- последний применённый `(world_id, sequence)`;
- idempotent handler на event type;
- rebuild command с нуля или snapshot boundary;
- lag/error metrics.

Map/feed/profile/chronicle не читают внутренние таблицы друг друга. Публичное API читает projection models и никогда не выдаёт canonical tables целиком.

Публичный `world snapshot` является отдельным DTO observer projection, а не формой canonical snapshot из §9. SSE `Last-Event-ID` относится к projection sequence. Если запрошенная sequence старше retention window, server возвращает versioned `reset_required` с текущей observer snapshot sequence; он не догоняет клиента выдачей canonical events.

Researcher/debug UI читает отдельную защищённую research projection, а не выдаёт публичному UI доступ к canonical tables.

## 11. Первый executable contract slice

До реализации всех event types код должен содержать только:

- envelope schemas;
- `journey.start` command;
- `journey.started`, `journey.completed`, `plan.invalidated` events;
- scheduled `journey.complete` action;
- snapshot checksum;
- SSE event envelope для feed projection.

Это достаточно, чтобы проверить type sharing, transaction boundary, idempotency, scheduling и replay до роста домена.

## 12. Реестр следующих contract slices

Этот раздел фиксирует границы из [[13_WORLD_SYSTEMS_SPEC]], но не разрешает заранее реализовать все schemas. Payload каждого семейства замораживается только в соответствующей итерации [[10_ITERATION_MASTER_PLAN]] после acceptance test. Один command может создать упорядоченный batch перечисленных фактов; событие не заменяет state machine одним «успешным» флагом.

| Slice | Намерения/commands | Ключевые canonical events |
|---|---|---|
| I08A–I08C economy/services | `trade.propose`, `trade.accept`, `shipment.dispatch`, `service.request`, `item.repair` | `trade.completed/rejected`, `shipment.dispatched/arrived/lost/intercepted`, `service.started/completed/denied`, `item.repaired` |
| I09A–I09D organizations/territory | `membership.request`, `truce.propose`, `checkpoint.inspect`, `territory.occupy`, `territory.consolidate` | `membership.changed`, `diplomacy.changed`, `truce.started/violated/expired`, `territory.influenced/contested/occupied/controlled/isolated`, `checkpoint.passed/denied` |
| I10B–I10C work groups | `contract.offer/accept`, `patrol.form`, `expedition.provision/start/abort`, `camp.establish`, `cache.place/retrieve` | `contract.offered/accepted/completed/failed/expired`, `patrol.started/relieved/aborted`, `expedition.proposed/provisioned/started/missing/returned/failed`, `camp.established/abandoned`, `cache.placed/retrieved/tampered` |
| I12A equipment | `item.equip`, `weapon.reload`, `equipment.maintain` | `item.equipped/unequipped/degraded`, `weapon.reloaded/malfunctioned`, `ammunition.consumed` |
| I12B–I12C combat/aftermath | `combat.warn/aim/fire/move/retreat/assist`, `surrender.offer/accept`, `custody.release`, `loot.take` | `combat.started/shot_fired/suppression_applied/retreated/resolved`, `wound.received`, `agent.incapacitated/died/surrendered`, `custody.started/ended`, `item.transferred/lost/damaged` |
| I12D raid/capture | `raid.plan/start/withdraw`, `base.defend/evacuate`, `territory.occupy/consolidate` | `raid.prepared/started/repelled/succeeded`, `base.module_damaged`, `base.evacuated`, затем отдельные territory transitions вместо `territory.captured` |
| I12E creatures | `hunt.start`, `creature.track/drive_off` | `creature.sign_observed/tracked/encountered/fled/driven_off/died/migrated`, `hunt.completed/failed` |
| I13A–I13B fields/finds | `field.probe/scan/mark`, `find.extract` | `hazard_field.cue_observed/scanned/changed`, `find.detected/claimed/extracted/lost/exported`, `item.source_recorded` |
| I13C–I13D storm | `shelter.request/enter`, system `storm.advance`, system `field.reseed_after_storm` | `territory_storm.warned/started/impacted/ended`, `shelter.entered/denied`, `hazard_field.reseeded`, `find.spawned` |

Обязательные contract rules для этих slices:

- `territory.controlled` требует causal links на occupation, supply delivery и истёкшее consolidation action; общего `territory.capture` command/event нет;
- `find.spawned` создаёт уникальные `item_id`, `field_id`, `slot_id`, `storm_id`, `source_event_id`, rules/content version и random audit; событие не создаёт claim или observer signal автоматически;
- `combat.shot_fired` содержит resolved ammunition source и outcome, поэтому replay не выполняет hit draw повторно;
- `shipment.arrived` ссылается на исходный cargo ownership chain и journey; restock без shipment/source event запрещён;
- `contract.completed` ссылается на canonical objective evidence, а не на representation/utterance;
- base module, custody, expedition и storm phase transitions используют expected entity version и явные preconditions в scheduled actions.
