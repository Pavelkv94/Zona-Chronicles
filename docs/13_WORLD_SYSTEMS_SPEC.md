# World systems specification

Статус: normative mechanics extension  
Дата: 2026-08-20

Документ расширяет [[07_MVP_MECHANICS_SPEC]] системами организаций, территорий, баз, экономики, экипировки, перестрелок, аномальных полей и post-storm появления ценных находок. При конфликте действуют инварианты [[07_MVP_MECHANICS_SPEC]] и приоритет документов из [[00_README]].

Это функциональная спецификация самостоятельной аномальной территории. Она не переносит названия, точный лор, виды существ, артефакты, карты, группировки или визуальные решения GSC.

## 1. Системная петля мира

```text
потребности и цели людей
  → контракты / торговля / патрули / экспедиции
  → движение по маршрутам и столкновения
  → добыча, потери, знания и изменение отношений
  → снабжение баз и влияние организаций
  → спор за маршруты, находки и shelters
  → контроль / рейды / перестрелки / дипломатия
  → изменившиеся цены, риски и новые цели

территориальная буря
  → предупреждение и борьба за shelter
  → изменение полей, маршрутов и ecology pressure
  → детерминированное появление новых находок
  → экспедиции, торговый всплеск и территориальный конфликт
```

Ни одна петля не зависит от зрителя, LLM или скрытого сценариста.

## 2. География, территории и влияние

### Единица контроля

Территория — не произвольный пиксель карты, а `territory_node`, обычно совпадающий с location и прилегающими route segments. Node содержит:

- strategic value: shelter, рынок, радиоузел, проход, anomaly field или ресурс;
- access rules и route adjacency;
- текущие `control_claims` организаций;
- presence: люди, patrol, garrison, наблюдательные точки;
- supply connectivity к friendly base/entry point;
- recent outcomes: trade, помощь, raid, defeat, norm violation;
- public/subjective knowledge о контроле отдельно от canonical state.

### Состояние контроля

```text
unclaimed
  -> influenced
  -> contested
  -> occupied
  -> controlled
  -> isolated -> contested/unclaimed
```

- `influenced`: организация присутствует, но не запрещает доступ другим;
- `contested`: минимум две стороны имеют значимое pressure либо идёт конфликт;
- `occupied`: одна сторона удерживает точку физически, но supply/legitimacy ещё нестабильны;
- `controlled`: есть garrison/patrol, supply line и пройден consolidation time;
- `isolated`: supply line потеряна, services деградируют, control pressure убывает.

Захват не происходит одним roll или событием `territory.captured`. Нужна причинная последовательность:

```text
разведка/claim
  -> давление, checkpoint или raid
  -> contested state
  -> retreat/surrender/assault outcome
  -> occupation scheduled action
  -> supply delivery + consolidation
  -> controlled
```

### Pressure

Стартовая explainable-модель:

```text
control_pressure(org, node) = present_force
                            + base_or_outpost_weight
                            + supplied_patrol_weight
                            + local_support
                            + recent_success
                            - opposing_pressure
                            - isolation_penalty
                            - casualty_and_fatigue_penalty
```

Pressure не публикуется числом. Decision trace сохраняет factors. Один сильный персонаж не захватывает базу мгновенно; thresholds, minimum occupation duration и supply preconditions обязательны.

### Эффекты контроля

Контроль может менять только явно перечисленные правила:

- доступ/пошлины на route и market;
- patrol/checkpoint frequency;
- shelter priority и service prices;
- radio/repeater access;
- вероятность безопасной поставки;
- правила ношения оружия/торговли;
- известность anomaly fields и доступ к экспедициям.

Он не выдаёт организации всеведение, не телепортирует patrol и не создаёт ресурсы.

## 3. Организации, дипломатия и репутация

### Организация

Versioned content задаёт:

- doctrine, taboos и tolerance к насилию;
- economic base и желаемые ресурсы;
- territory goals;
- recruitment/expulsion rules;
- radio policy;
- отношение к independents и другим организациям;
- предпочтительные contracts, patrol size и retreat threshold.

### Дипломатия

Направленная пара организаций имеет:

```text
trust
fear
grievance
dependency
border_pressure
state: allied | cooperative | neutral | tense | hostile | truce
```

State меняется только через накопленные события и hysteresis. Убийство свидетеля, нарушение truce, raid, помощь, торговая зависимость или общий враг создают evidence. Один random draw не начинает войну.

`truce` содержит стороны, scope, start/end, запреты и witnesses. Нарушение создаёт canonical fact и знание только для свидетелей/получателей сообщения.

### Репутация человека

Репутация хранится отдельно по организациям и social clusters:

- reliability;
- violence/threat;
- trade fairness;
- obligation record;
- known services/skills;
- trespass/hostility flags.

Reputation влияет на prices, access, contracts, surrender и recruitment, но не заменяет личные отношения A → B.

## 4. Базы, аванпосты и checkpoints

### Base state

База — location с owner claim и modules:

- `shelter`: capacity, storm protection, access priority;
- `storage`: physical inventory и ownership;
- `market`: trader inventory/orders;
- `medical`: supplies, beds, treatment capability;
- `workshop`: bounded repair, spare parts, queue;
- `radio`: range/repeater, power/condition;
- `garrison`: members, readiness, ammo/morale;
- `observation`: known routes/fields, detection bonus без omniscience.

Module имеет condition, staff, inventory, capacity и operational state. Пустой medical storage не лечит; сломанный repeater не передаёт radio; workshop не создаёт запчасти.

### Outpost/checkpoint

Outpost легче базы: limited shelter/storage/radio/garrison, без полного набора services. Checkpoint контролирует конкретный route edge и может проверить доступ, потребовать toll, пропустить, задержать или вызвать scene.

### Потеря базы

Base control меняется только после evacuation/surrender/assault outcome, occupation и consolidation. Storage/раненые/пленные не переходят владельцу «по флагу»: каждый item/person получает outcome. Services могут быть повреждены или продолжить работу при согласии staff.

### Scope ограничения

Основной прототип не строит базы из свободной геометрии. Locations/modules заданы content data; разрешены repair, damage, staff/supply changes и смена owner. Полное строительство/upgrade tree — post-prototype.

## 5. Контракты, работы, патрули и экспедиции

Контракт — структурированное предложение внутри мира, не player quest:

```text
contract_id
issuer_id
type
objective + target constraints
known_context_claim_ids
reward/escrow
required_items/skills
deadline
risk_estimate_from_issuer
visibility/channel
status
accepted_by
caused_by events
```

Типы core:

- delivery/supply;
- escort/guide;
- survey anomaly/route;
- retrieve valuable find/cargo;
- rescue/search missing;
- hunt/drive-off creature;
- patrol/checkpoint relief;
- defend base/outpost;
- raid/interdict supply;
- medical/repair service.

Utility AI сравнивает reward, need, loyalty, risk, time, skill fit и competing obligations. Reward резервируется либо issuer явно рискует нарушить обещание. Выполнение проверяется canonical events; текстовый отчёт не закрывает contract.

### Patrol

Patrol имеет route, goal, shift window, members, supplies, radio policy и abort conditions. Он не появляется из probability около нужной сцены: сначала формируется и физически проходит маршрут.

### Expedition

```text
proposed -> recruiting -> provisioning -> departing
         -> active -> returning -> debriefed
                   -> stranded/missing/failed
```

Экспедиция требует цель, leader, members, supplies, detector/medical needs, route и return threshold. Потеря связи создаёт `missing` observer state, а не canonical смерть.

### Полевые лагеря и тайники

Field camp — временный scene/location anchor, созданный физически присутствующей группой. Он требует времени и carried supplies, даёт bounded rest/heat/light/radio/first-aid benefits, но увеличивает заметность из-за света, дыма, шума и следов. После ухода camp сворачивается либо остаётся abandoned entity с decay/loot risk; это не безопасная точка по умолчанию.

Cache — physical storage entity с location, container condition, ownership и access state. `cache.place/retrieve/tamper` перемещают реальные items. Местоположение тайника известно только создателю, свидетелям и получателям claim; отметка в UI или слух не создают тайник и не гарантируют, что содержимое осталось на месте.

## 6. Экономика и логистика

### Категории

- consumables: food, medicine, ammunition, spare parts/universal goods;
- equipment: weapon, armor/protection, detector, radio, backpack/tool;
- services: treatment, repair, guide, shelter, transport/escort, information;
- unique valuable finds с provenance и исследованными свойствами;
- debt/obligation и универсальная расчётная единица как ledger, не бесконечный предмет.

### Sources

- world entry supply shipments;
- ограниченные location resources;
- возвращение экспедиций;
- loot/lost cargo;
- post-storm valuable finds по правилам §11;
- newcomer starting kit как явный population source.

### Sinks

- питание, лечение, ammunition use;
- repair parts и equipment degradation;
- lost/destroyed/abandoned items;
- shelter/toll/service payments;
- expedition provisioning;
- research consumption/long-term export valuable finds;
- newcomer outfitting.

### Цена

```text
price = reference_value
      * local_scarcity
      * replacement_risk
      * quality_condition
      * organization_tariff
      * relationship_modifier
      * urgency
```

Каждый multiplier bounded. Trader использует собственные inventory/orders/knowledge; он не видит глобальные stocks. Spread и цены логируются в decision trace. Trade атомарен, отрицательный inventory/двойная оплата запрещены.

### Поставки

Supply shipment — физическая expedition/delivery с cargo ownership, route и escort. Перехват/потеря меняют рынок. `shipment.arrived` не может возникнуть без исходного cargo и journey.

### Баланс

Ecology/economy controllers задают только глобальные capped sources с задержкой. Они не выдают ресурс конкретной организации или герою. Регулирование создаёт event и попадает в interventions report.

Контрольные метрики:

- stock days и shortage duration;
- sources/sinks по category;
- price median/p10/p90 и spread;
- trade concentration по trader/org/location;
- доля wealth верхних 10%;
- supply success/loss;
- valuable find spawn/extraction/export rate;
- services denied из-за stock/capacity;
- money/ledger velocity и inflation proxy.

## 7. Предметы, оружие, защита и детекторы

### Item identity

Уникальный предмет содержит owner/location, condition, weight class, tags, source event и content version. Stackable consumables сохраняют amount и source/sink audit.

### Equipment slots

- primary/secondary weapon;
- protection/armor;
- detector/tool;
- radio;
- carried medical;
- backpack/cargo capacity.

### Оружие

Core использует абстрактные категории без копирования конкретного арсенала:

- sidearm: мобильность, низкая suppression;
- close-range long gun: высокая близкая threat, ограничение дистанции;
- general long gun: средняя дальность/точность/расход;
- precision weapon — только поздний content variant тех же правил.

Weapon задаёт range bands, accuracy, damage/wound profile, suppression, noise, ammo class, magazine/cycle abstraction, condition и jam risk. Reload тратит action и ammunition. Не моделировать каждый патрон в полёте, но conservation боеприпасов обязательна.

### Protection

Protection уменьшает вероятность/severity конкретных wound/hazard profiles, имеет condition и mobility/fatigue cost. Она не превращает damage в одно число armor rating.

### Detector

Detector имеет detectable field families, range band, uncertainty, condition, power/use cost и calibration. Он создаёт observation/claim, а не раскрывает exact canonical geometry.

Уровни core:

- improvised/basic: подтверждает наличие и направление;
- calibrated: даёт approximate boundary/activity;
- research tool: редкий service/equipment для точных measurements, но не безопасной добычи.

### Воздействие среды

Тело отдельно накапливает contamination/exposure profiles от field contact, storm, опасной воды/пыли и повреждённого equipment. Profile имеет source, dose, decay/treatment rules и наблюдаемые симптомы. Protection снижает конкретный профиль, detector может предупредить о нём, а medicine/service лечит только допустимый диапазон с расходом ресурсов. Нельзя свести все опасности к одной универсальной «радиации» или мгновенно обнулить exposure отдыхом.

## 8. Обнаружение, скрытность и встреча

Обнаружение используется для людей, существ, fields и следов:

```text
detection = observer_skill
          + equipment
          + target_signature
          + proximity
          + shared_intel
          - concealment
          - darkness/weather/interference
```

Результат: unnoticed, cue only, approximate, identified. До identified решение опирается на claim/cue, а не canonical type.

Засада требует подготовленной позиции/behavior state и failed detection; она не является случайным bonus без физической причины. Radio/report может передать claim другим, но не превращает его в независимое подтверждение.

## 9. Перестрелки и бой

### До боя

Encounter сначала допускает observe, warn, hide, avoid, negotiate, surrender, retreat или call support. Доктрина, отношения, цель, видимая сила, ammo, wounds, cover и escape route влияют на решение.

### Combat scene

```text
contact -> positioning -> exchange
        -> pressure/morale checks
        -> advance/flank/aid/reload/retreat/surrender
        -> resolved: disengaged | surrendered | incapacitated | dead
```

State содержит:

- participants/sides и recognized identity;
- abstract position/cover slots и range bands;
- line-of-effect/visibility;
- weapon/ammo/condition;
- wounds, fatigue, stress, morale/suppression;
- escape/support routes;
- round/time budget.

Actions core:

- move/change cover;
- observe/identify;
- fire aimed/suppressive;
- reload/clear jam;
- advance/flank;
- aid/drag wounded;
- signal/call support;
- retreat/surrender/accept surrender.

### Resolution

Hit не равен смерти. Saved outcome включает target, range, cover, action, roll audit и wound profile. Wounds вызывают bleeding, pain/stress, mobility/action penalties и лечение. Friendly fire возможен только при явном risky shot/visibility condition и сохраняется как факт.

Morale оценивает casualties, suppression, leader, escape, loyalty и objective value. Forced disengagement завершает scene при budget exhaustion; бесконечная перестрелка невозможна.

### Пленные и surrender

Surrender создаёт custody/obligation scene, а не автоматическую казнь. Организационные нормы определяют disarm, release, exchange, recruit или violation. Пленные физически занимают escort/capacity и могут быть освобождены.

### Loot

Loot доступен после scene и физического контроля над location. Каждый item переносится отдельно; carry capacity и опасность ограничивают сбор. Corpse/abandoned cache остаётся entity до transfer/decay/cleanup event.

### Баланс боя

- combat не более 10% meaningful events в обычном мире до калибровки;
- большинство контактов допускают avoid/retreat;
- одна сторона не получает глобальный accuracy bonus только из affiliation;
- death rate, ammo consumption, surrender/retreat и wound survival измеряются по seed;
- популярность персонажа не влияет на hit/death.

## 10. Существа и охота

Creature ecotype задаёт habitat, activity window, senses, cues, pack/solitary state, hunger/territory pressure, target preference, fear/retreat и ecology impact.

### Pack-territory ecotype

- den/feeding corridor;
- scout/alarm/group response;
- численное pressure и retreat при потерях;
- миграция при depleted food или storm aftermath.

### Solitary-ambush ecotype

- concealment site;
- узнаваемые следы;
- короткая атака, drag/withdraw behavior;
- смена места после failed ambush или disturbance.

Hunt contract требует evidence/track/area, а не omniscient marker. Уничтожение creature/den временно снижает pressure, но ecologyController может мигрировать популяцию только через capped evented rules.

## 11. Аномальные поля, охота за находками и post-storm spawn

### Field

```text
field_id
family
location/route geometry
activity: dormant | unstable | active | saturated | recovering
intensity
detection cues
contact effects
safe windows/approach constraints
depletion
find slots/cap
last_storm_id
cooldown
```

Три family обязаны различаться механически: например navigation distortion, pulsed pressure/resonance и surface/material transformation. Visual names находятся в [[12_VISUAL_AND_CONTENT_DESIGN]], а rules не зависят от названия.

### Поиск и добыча

```text
получить claim/cue
  -> подготовить detector/protection/supplies
  -> travel and observe
  -> scan approximate boundary/activity
  -> choose approach/window
  -> extract attempt
  -> find acquired OR wound/equipment loss/field change
  -> return/trade/research/report
```

Добыча — scheduled action/scene с duration и interrupt. Find не появляется в inventory из текста. До observation его existence/position не доступен агенту и public UI.

### Find identity/properties

Valuable find имеет unique ID, source storm/field event, condition/stability, mass class и набор измеряемых свойств. Свойства сначала unknown/claimed, затем уточняются observation/research service. Bounded practical effects допустимы для detectors/protection/medicine/research value, но не переписывают физические правила и не создают магические бесконечные ресурсы.

### Территориальная буря

```text
forecast signal
  -> warned
  -> onset
  -> peak
  -> decay
  -> ended
  -> field reseed/recovery jobs
  -> aftermath
```

- forecast может быть неточным claim; canonical schedule известен только system;
- warned запускает shelter/preparation/recall goals;
- onset/peak меняют route safety, radio interference, field states и creature behavior;
- unsheltered outcome зависит от protection, location и exposure, но имеет hard danger floor;
- shelter capacity/access реальные; teleport в shelter запрещён;
- ended не мгновенно нормализует routes/fields.

### Детерминированный post-storm spawn

После `territory_storm.ended` scheduler создаёт `field.reseed_after_storm` для каждого eligible field в стабильном порядке `(field_id, slot_id)`.

Eligibility:

- field пережил storm и поддерживает find family;
- slot свободен;
- field не превышает cap;
- cooldown окончен;
- предыдущий unique find не остаётся в том же slot;
- content/rules version определяет allowed property profiles.

```text
spawn_score = storm_intensity
            + field_saturation
            + recovery_age
            - recent_extraction_pressure
            - active_find_count_penalty
```

Versioned PRNG stream: `storm:{storm_id}:field:{field_id}:slot:{slot_id}`. Outcome сохраняется в `find.spawned` с `caused_by = [territory_storm.ended, hazard_field.changed]`. Replay применяет сохранённый outcome и не бросает roll снова.

Spawned find:

- получает unique `item_id` и source root;
- canonical position остаётся скрытой;
- не создаёт observer signal сам по себе;
- обнаруживается через cue/detector/свидетеля;
- может стать причиной конкурирующих expeditions/contracts;
- decay/destabilization происходит только через scheduled event;
- не respawn-ится из-за того, что зритель/агент давно не находил ценностей.

### Анти-эксплойт

- storm не гарантирует find в каждом field;
- cap ограничивает накопление;
- exact spawn time/position не доступен Utility AI;
- один claim о find не создаёт дубликат item;
- organization control повышает access/safety, но не spawn probability без explicit rule;
- ecologyController не создаёт find для спасения экономики.

## 12. Погода, день/ночь и окружающая среда

Погода и освещение меняют visibility, noise masking, route duration, exposure, detector uncertainty и creature activity. Они не являются только visual skin.

Минимум:

- clear/overcast/rain/fog profiles;
- day/dusk/night/dawn visibility phases;
- wind/interference modifier для radio и fields;
- shelter/rest modifiers;
- scheduled forecast claims от наблюдателей/станций.

Weather transition versioned и детерминирован по world seed/rules. Rare territory storm — отдельная система, не обычная погода.

## 13. Радио, информация и базы

- squad channel: members + working radios;
- organization channel: policy + repeater coverage;
- open/emergency: короткие сообщения в range;
- base broadcast: market, warning, contract, propaganda;
- interference/jamming: weather/storm/equipment effects;
- courier/face-to-face: fallback без radio.

Message передаёт claim. Repeater ownership влияет на reach, но не меняет truth. Захват radio base не раскрывает старые private claims автоматически; для этого нужен captured storage/log event с access rules.

## 14. Population, смерть и преемственность

Смерть окончательна. Она может вызвать:

- leadership vacancy;
- contract failure/transfer;
- trader/medic/technician service loss;
- base morale/garrison change;
- unclaimed storage/loot;
- funeral/memory/rumor;
- revenge, retreat или diplomacy pressure.

Role succession выбирается из доступных людей с knowledge/skill/relationship, занимает время и не восстанавливает inventory/reputation. Newcomers приходят через entry points с причиной, kit source и возможными organization offers.

## 15. Controllers без скрытого режиссёра

Допустимые controllers:

- resource replenishment caps;
- newcomer inflow window;
- creature population pressure/migration;
- weather/storm schedule по versioned rules;
- anomaly field recovery/reseed после storm;
- cleanup/decay abandoned entities.

Недопустимо:

- создать помощь рядом с любимым героем;
- снизить hit/death из-за popularity;
- выдать find для красивой истории;
- мгновенно ослабить организацию ради баланса;
- скрытно пополнить trader/base storage;
- менять outcome после publication.

Любая коррекция evented, bounded и попадает в `interventions.json`.

## 16. Commands и events верхнего уровня

### Commands

```text
territory.claim
outpost.establish
territory.occupy / territory.consolidate
patrol.form
contract.offer / contract.accept
expedition.prepare / expedition.depart
trade.propose
service.request
combat.warn / combat.aim / combat.fire / combat.retreat
surrender.offer / surrender.accept / loot.take
field.scan / find.extract
camp.establish / cache.place / cache.retrieve
shelter.request_entry
radio.transmit
```

### Events

```text
territory.influenced / contested / occupied / controlled / isolated
base.module_damaged / restored
checkpoint.established / abandoned
diplomacy.changed / truce.started / violated / expired
contract.offered / accepted / completed / failed
patrol.started / checkpoint.reached / patrol.returned / patrol.missing
expedition.started / returned / stranded / missing
shipment.dispatched / arrived / lost / intercepted
trade.completed / service.completed / service.denied
combat.started / shot_fired / retreated / resolved
weapon.reloaded / malfunctioned / ammunition.consumed
wound.received / agent.surrendered / agent.died
creature.sign_observed / creature.migrated / den.disrupted
hazard_field.cue_observed / scanned / changed / reseeded
camp.established / abandoned / cache.placed / retrieved / tampered
territory_storm.warned / started / impacted / ended
find.spawned / detected / extracted / destabilized / lost
shelter.entered / denied / exited
```

Конкретный payload вводится только в своей итерации и расширяет [[09_EVENT_AND_COMMAND_CONTRACTS]] через discriminated schema.

## 17. Обязательные инварианты

- territory control не меняется без presence/outcome/occupation/supply causal chain;
- один node не имеет двух canonical owners в `controlled`, но может быть `contested`;
- base storage, market и garrison не создают items/people;
- checkpoint действует только на физически связанный route;
- organization diplomacy/reputation меняются только из известных/зафиксированных событий;
- contract не выполнен без canonical objective evidence;
- shipment cargo сохраняется между source, transfer, loss и arrival;
- ammunition не становится отрицательной и каждый shot имеет ammo/weapon source;
- dead/incapacitated actor не выполняет combat action;
- combat scene терминальна и сохраняет surrender/retreat path, если он физически возможен;
- каждый unique find имеет один `find.spawned` root и один owner/location;
- `field.reseed_after_storm` одного storm/slot идемпотентен;
- storm spawn не зависит от viewer count, LLM, popularity или wall clock;
- agent/public UI не видят exact hidden find/field без observation provenance;
- shelter occupancy не превышает capacity;
- service не выполняется без staff, inventory, time и reachable location/channel;
- camp/cache не создают safe state или items; их location/content не известны без provenance;
- environmental exposure имеет source и не исчезает без time/treatment rule;
- control, economy и population controllers не работают скрытно;
- replay сохраняет territory owner, base inventory, diplomacy, combat outcomes, field state и find IDs.

## 18. Сквозные метрики и hard stops

### Territory/organizations

- control share и duration по organization;
- contested time, capture/reversal rate;
- supplied vs isolated nodes;
- patrol/checkpoint activity;
- casualties/resources на один capture;
- diplomacy state duration и truce violations.

Hard stop: одна организация получает >80% strategic nodes в большинстве holdout seeds без измеримой причины; control меняется без supply/presence; perpetual war/peace из-за bug.

### Economy

- sources/sinks, shortage, price distributions;
- trader/service concentration;
- shipment loss, wealth concentration, find flow;
- base stock days и denied services.

Hard stop: magic restock, infinite money/items, один trader >70% оборота без structural cause, essential stock нулевой/бесконечный в большинстве seeds.

### Combat

- encounter → combat/avoid/surrender/retreat;
- shots/ammo, wounds/deaths, duration;
- side advantage vs skills/gear/cover;
- friendly fire и stuck scenes.

Hard stop: combat >10% meaningful events после tuning, retreat практически невозможен, scene превышает round budget, popularity влияет на outcome.

### Fields/storm/finds

- warning lead time и shelter success/denial;
- fields changed/reseeded;
- spawn/extraction/decay/export rate;
- time-to-discovery и detector impact;
- deaths/losses per expedition.

Hard stop: find duplicate, spawn без storm/source, каждый storm гарантирует богатство, exact hidden position leaks, economy живёт только за счёт controller rescue.

## 19. Scope основного прототипа и extensions

Core включает перечисленные системы на уровне 5–7 strategic locations, 2 основных organizations + independents + малого research/logistics interest, 30–50 людей, 2 creature ecotypes, 3 field families и одной territory storm family. Ранний инженерный fixture из 3 locations расширяется в I09C; production art может иметь 3 hero key arts, а остальные nodes — modular backdrops/map language.

После Gate E, только при доказанной необходимости:

- новые organizations/locations/ecotypes/field families как content packs;
- production/crafting и base construction tree;
- сложная политика/выборы/иерархии;
- vehicles и свободная геометрическая навигация;
- детальная ballistics/armor simulation;
- dozens of weapon families;
- несколько публичных миров.

Расширение количества контента не должно предшествовать доказательству каждой core system через executable fixture, multi-seed impact и causal history.
