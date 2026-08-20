# MVP mechanics specification

Статус: baseline specification  
Дата: 2026-08-20

Этот документ превращает концепцию из [[02_SIMULATION_DESIGN]] в набор решений, которые можно реализовывать через тесты. Числовые коэффициенты являются стартовыми конфигурациями, а не частью кода.

Территории, базы, дипломатия, контракты, логистика, оружие/защита/detectors, перестрелки и точный post-storm find lifecycle нормативно расширены в [[13_WORLD_SYSTEMS_SPEC]].

## 1. Что должен доказать прототип

Один seed-мир с 5–7 strategic locations и 30–50 людьми автономно проживает 7 игровых дней. Ранние I01–I08 используют fixture из 3 узлов и не обязаны заранее нести финальную content density. За это время:

- ресурсы перемещаются и расходуются;
- возникают встречи, помощь, торговля, отказ и хотя бы один конфликт;
- знания распространяются только через наблюдение и коммуникацию;
- отношения меняют последующие решения;
- смерть и потеря имеют долгосрочные последствия;
- организации снабжают базы, патрулируют и могут причинно оспаривать/менять контроль strategic nodes;
- перестрелки сохраняют ammo/gear/wound/surrender/loot outcomes и допускают retreat;
- territory storm меняет поля и запускает детерминированный, ограниченный spawn новых valuable finds с provenance;
- минимум три причинные цепочки можно восстановить из event log;
- replay любого committed sequence даёт тот же canonical snapshot.

Красивый текст не является доказательством. Прототип считается успешным при отключённой LLM.

## 2. Границы мира

### Стартовый контент

- 5–7 узловых локаций: минимум 2 снабжаемые базы/крупных outpost разных сторон, resource/anomaly area, опасный transit node и 1–3 neutral/contested nodes;
- 8–12 двунаправленных/направленных маршрутов с разной длительностью, заметностью и риском;
- минимум 2 полноценные человеческие организации с разными нормами/экономикой, независимые одиночки и малый внешний research/logistics interest;
- 30–50 людей, из них часть объединена в отряды по 2–5;
- устойчивые роли trader, medic, guide/scout, technician, guard и scavenger; роль влияет на доступные цели/услуги, но не является жёстким RPG-классом;
- 2 оригинальных ecotype изменённой фауны/существ с разным поведением: стайный территориальный и одиночный засадный;
- 4 категории ресурсов: еда, медицина, боеприпасы, универсальный товар;
- редкие оригинальные anomalous finds как уникальные valuable items поверх четырёх расходуемых категорий;
- 3 family аномальных полей, 1 погодный риск и 1 редкая территориальная буря;
- постоянная торговая точка, минимум 2 shelter, camp/listening points и локальные/групповые/аварийные radio channels;
- 8–12 шаблонов целей и 12–20 канонических event families; конкретные versioned types добавляются только в реализующей их итерации.

Названия, существа, эмблемы, география и визуальный контент остаются оригинальными до решения GSC. Полная content taxonomy и asset provenance: [[12_VISUAL_AND_CONTENT_DESIGN]].

### География

Каноническая навигация — ориентированный граф, а не свободное движение по карте. Геометрия нужна для отображения и пространственных запросов, но допустимость пути определяется `route`.

Маршрут содержит:

- `from`, `to`, базовую длительность;
- проходимость и требования;
- базовые risk/visibility/capacity;
- текущие модификаторы погоды, контроля и угроз;
- `content_version`.

Агент в пути находится на route с progress и ETA. Смена координаты UI не является доменным событием.

## 3. Время и порядок обработки

### Каноническое время

- время мира хранится отдельно от wall clock;
- публичная стартовая скорость: 1 реальная минута = 4 игровые минуты;
- dev/test режим работает без привязки к wall clock и может мгновенно пройти неделю;
- downtime не создаёт невидимую историю: мир продолжает с последнего committed world time;
- pause/resume не меняют причинный результат.

Старое предположение «1 реальная секунда = 4 игровые минуты» отклонено: игровой день проходил бы за 6 реальных минут, и зритель не успевал бы сформировать привязанность.

### Scheduled action

```text
action_id
world_id
due_world_time
priority
actor_id
action_type
payload
expected_actor_version
preconditions
status
```

При одинаковом времени порядок стабилен: priority → actor/entity id → action id. System actions используют явный `actor_id` вида `system:*`. Новые действия не могут быть запланированы в прошлом; несвязанное изменение глобальной версии мира не инвалидирует action другого агента.

## 4. Жизненный цикл агента

### Верхнеуровневые состояния

```text
available -> planning -> executing -> scene -> recovering -> available
                      \-> incapacitated -> dead
                      \-> missing
```

`dead` — терминальное состояние. `missing` означает неизвестный зрителю/группе статус и не заменяет canonical состояние.

### Постоянные параметры

- идентичность, возрастная группа и происхождение;
- черты `[0, 1]`: осторожность, эмпатия, дисциплина, жадность, любопытство;
- навыки `[0, 1]`: выживание, медицина, бой, торговля, навигация;
- ценности и табу как versioned tags;
- организация, роль и отряд;
- состояние тела;
- нужды и мораль;
- инвентарь, деньги/универсальный товар и долги;
- отношения, знания, воспоминания, обязательства;
- текущая цель, план и cooldowns.

Черты почти не меняются. Навыки меняются медленно. Нужды, мораль и отношения меняются часто.

## 5. Нужды и состояние тела

MVP использует нормализованные показатели `[0, 1]`:

- здоровье: 1 — здоров, 0 — смерть;
- голод, усталость, стресс: 0 — нет проблемы, 1 — критично;
- мораль: 0 — сломлен, 1 — устойчив;
- кровотечение и инфекция — отдельные conditions с severity и progression.

Нужды обновляются scheduled pulse-ами, но событие публикуется только при пересечении значимого порога. Это предотвращает event spam.

Пороги по умолчанию:

```text
normal < 0.45 <= warning < 0.75 <= critical
```

Смерть определяется правилами тела, а не одной случайной проверкой. Любое ухудшение имеет причину: рана, голод, инфекция или hazard exposure.

## 6. Utility AI и планы

### Кандидатные цели MVP

- обеспечить себя едой;
- отдохнуть;
- получить лечение или лечить другого;
- пополнить ресурсы;
- выполнить обещание/долг;
- заработать через поиск или торговлю;
- безопасно добраться до места;
- помочь союзнику;
- избежать/покинуть угрозу;
- исследовать известную возможность;
- сообщить важное знание;
- отомстить или отказаться от сотрудничества.

### Оценка цели

```text
score(goal) = urgency
            + expected_value
            + personality_fit
            + relationship_pressure
            + obligation_pressure
            - risk_cost
            - time_cost
            - switching_cost
```

Каждый член нормализуется и конфигурируется ruleset-ом. После выбора используется hysteresis: агент не меняет цель, пока новая не лучше текущей на `switch_margin`, кроме emergency interrupt.

Decision trace хранит входные факторы, кандидатов, score и выбранную цель. Это debug-data, не публичная цепочка рассуждений.

### Короткий план

План содержит не более 3–6 проверяемых шагов. Перед шагом проверяются preconditions. Ошибка предусловия создаёт `plan.invalidated`, после чего агент перепланирует действие. Движок не пытается заранее построить сценарий на сутки.

## 7. Случайность и детерминизм

- запрещены прямые `Math.random()`, `Date.now()` и случайные UUID в домене;
- PRNG является versioned dependency мира;
- поток случайности разделён по stable stream key: мир, агент, сцена, система;
- canonical event хранит outcome и достаточные audit-поля: stream key, draw index/range, rules version;
- replay событий применяет сохранённый outcome и не бросает кубики заново;
- resimulation с теми же snapshot, seed, rules/content bundle и поддерживаемым runtime profile обязана породить тот же log;
- все сравнения, сортировки и tie-breakers используют явно заданный порядок; locale, collation, порядок ключей object/map и план выполнения SQL не могут определять canonical outcome;
- физические количества, деньги, время, вероятность и коэффициенты имеют документированную единицу, диапазон и правило округления. Для сохраняемых ресурсов/цен предпочтительны целые minor units или fixed-point; `NaN`, `Infinity`, неявное locale-округление и сравнение на точное равенство вычисленных float запрещены;
- canonical serialization фиксирует UTF-8, порядок ключей, представление дат, чисел и отсутствующих полей; смена алгоритма serialization является versioned migration;
- Node.js major/minor profile, timezone/ICU и версия PRNG фиксируются для canonical worker. Обновление runtime не принимается, пока compatibility suite не сравнит replay и resimulation regression bank на старом и новом profile;
- каждый snapshot ссылается на неизменяемые rules/content/schema bundles по версии и checksum. Эти bundles хранятся не меньше соответствующих snapshot/event retention и доступны для restore/replay; одной строки semantic version недостаточно.

Полный golden log используется только для маленьких эталонных сценариев. Для больших прогонов главные проверки — инварианты, статистические диапазоны и контрольные causal milestones, иначе любое корректное изменение баланса будет создавать бесполезный diff.

## 8. Перемещение и встречи

### Выбор маршрута

Стоимость маршрута для агента:

```text
travel_cost = duration
            + perceived_risk * caution_weight
            + resource_cost
            + uncertainty_penalty
            - goal_relevance
```

Используется субъективная карта риска агента, а не canonical risk. Неизвестный маршрут может казаться безопасным или слишком опасным.

### Встреча

Encounter создаётся при пересечении участников по route/location и успешном обнаружении. Возможные решения:

- не заметили друг друга;
- заметили и разошлись;
- обменялись сигналом;
- начали social/trade/help scene;
- спрятались/отступили;
- начали combat scene.

Выбор зависит от видимой силы, отношений, целей, морали и неожиданности. Сам контакт не обязан стать опубликованным событием.

## 9. Ресурсы, торговля и экономика

Экономика нужна для создания решений, а не для финансового симулятора.

### Sources

- ограниченные находки на опасных маршрутах;
- периодическое восстановление еды/универсального товара;
- контролируемый приток через входы мира;
- имущество погибших и потерянные грузы.

### Sinks

- питание и лечение;
- боеприпасы;
- потери, порча, ограниченный ремонт снаряжения и плата за услуги;
- экипировка новичков.

### Торговля

У агента есть субъективная ценность предмета:

```text
value = base_value
      * scarcity
      * personal_need
      * location_modifier
      * relationship_modifier
```

Сделка возможна только при положительной ожидаемой выгоде обеих сторон либо под давлением долга/отношений. Предмет передаётся атомарно. Обещание заплатить создаёт obligation с due time и свидетелями.

Trader — постоянная роль конкретного агента и/или venue, а не безличное меню. Его inventory конечен и пополняется из supplier entry, возвратившихся экспедиций и реальных сделок. Цена учитывает локальный дефицит, риск доставки, желаемый spread, отношения и обязательства. Trader может отказать, потерять поставку, сменить место, погибнуть; succession создаёт отдельное событие и не восстанавливает inventory магически.

Technician выполняет только bounded maintenance/repair существующего предмета: расходует универсальный товар/запчасть, время и создаёт `item.repaired`. Полное производство и crafting не добавляются.

Полная логистика, contracts, physical shipments, services и balance metrics: [[13_WORLD_SYSTEMS_SPEC]] §5–7.

EcologyController не подбрасывает ресурс конкретному любимому герою. Он регулирует только глобальные sources/sinks по прозрачным правилам и с событиями.

## 10. Отряды, организации и социальные нормы

Организация определяет membership, doctrine, роли, экономическую основу, territory goals, общие нормы, recruitment и известные каналы связи. Отряд — временная operational group. Для каждой организации content data обязана задавать минимум одну причину сотрудничества, две причины конфликта и различимое поведение Utility AI; эмблема и цвет без механического влияния недостаточны.

Diplomacy, territory pressure, bases/outposts/checkpoints и capture/consolidation rules: [[13_WORLD_SYSTEMS_SPEC]] §2–4.

Минимальные нормы:

- делиться критической помощью с членом отряда;
- не красть у союзника;
- выполнить принятое обязательство;
- сообщать об общей угрозе.

Нарушение нормы имеет:

- canonical факт;
- намеренность: случайность, необходимость или сознательное решение;
- свидетелей;
- распространяемое знание;
- изменение отношений только у тех, кто узнал и поверил.

## 11. Отношения и обязательства

Направленное отношение A → B:

- trust, affinity, fear, respect, suspicion `[0, 1]`;
- familiarity `[0, 1]`;
- список обязательств вместо одного числа debt.

Изменения ограничены максимальной дельтой на событие и имеют decay только там, где он правдоподобен. Например, страх может ослабевать, но невыполненный долг не исчезает от таймера.

Обязательство содержит creditor, debtor, предмет/действие, due time, status, origin event и известных свидетелей. Предательство — это нарушение конкретного обязательства или нормы ради конкурирующей цели.

## 12. Знания, наблюдения, слухи и ложь

### Knowledge claim

```text
claim_id
holder_id
subject/predicate/object
confidence
acquired_at
source_type: witnessed | told | inferred | fabricated
source_claim_id | source_event_id
expires_or_stales_at
```

Одинаковые утверждения могут существовать у разных агентов с разной уверенностью. Canonical fact не копируется автоматически всем.

### Передача

При разговоре передаётся claim, а не canonical event. Уверенность получателя зависит от доверия к источнику, количества независимых подтверждений и давности. Искажение выбирается структурированным правилом: потеря детали, неверная атрибуция, преувеличение или сознательная ложь.

Независимые подтверждения считаются по provenance graph, а не по количеству пересказов одной исходной истории.

### Наблюдаемость для зрителя

Observer signal возникает из физического наблюдения, открытого радио, доступной точки прослушивания или поздней публикации летописца. У сигнала есть precision, confidence, observed_at и reveal_at.

UI не получает canonical координаты и внутренние stats по умолчанию. Dev researcher mode — отдельный защищённый projection.

## 13. Сцены

Сцена — конечный state machine с участниками, местом/каналом, причиной, доступными объектами и deadline.

Типы MVP:

- rest/camp;
- trade;
- service/repair;
- help/medical;
- dispute;
- combat;
- radio exchange;
- shelter/wait-out;
- expedition briefing/debriefing.

```text
proposed -> assembling -> active -> resolving -> closed
                         \-> aborted
```

Участник не может одновременно находиться в двух физических сценах. Сцена завершается структурированным outcome до генерации художественного текста.

## 14. Бой, раны и смерть

Бой — дискретная сцена с раундами, а не real-time physics.

1. обнаружение и surprise;
2. решение engage/avoid/retreat/surrender;
3. выбор абстрактной позиции;
4. действие: move, suppress, attack, aid, retreat;
5. разрешение попаданий и морали;
6. exit condition.

Outcome зависит от навыка, состояния, оружия, дистанции, укрытия и сохранённого random draw. Попадание сначала создаёт wound; непосредственная смерть редка. Bleeding и infection дают время на помощь и создают социальные решения.

Бой заканчивается при отходе, сдаче, потере способности действовать или отсутствии противника. Нельзя вести бесконечную сцену: есть round/time budget и forced disengagement rule.

Weapon/ammo/protection/detection contracts, combat actions, surrender/custody и loot подробно определены в [[13_WORLD_SYSTEMS_SPEC]] §7–10.

## 15. Существа, аномальные поля, погода и экология

MVP не симулирует каждое существо вне значимой встречи. EcologyController хранит population pressure по локациям и создаёт encounter entities по правилам. Два обязательных оригинальных ecotype различаются не только stats: стайный территориальный охраняет habitat/пищу и реагирует на численность, одиночный засадный использует concealment, следы и короткую атаку с отходом.

- существа мигрируют между соседними habitat nodes, оставляют observer cues и могут быть обнаружены/обойдены до боя;
- аномальное поле имеет family, geometry/route attachment, activity state, detection cues, cooldown и последствия контакта;
- anomalous find создаётся только явным source event после рискованного исследования и получает уникальный item provenance;
- погода меняет риск, видимость и длительность маршрутов;
- редкая территориальная буря заранее имеет слабые сигналы, запускает shelter goals и затем меняет routes/resources/threat pressure;
- ресурсы восстанавливаются с cap и cooldown;
- controller предотвращает только технически мёртвый мир, но не отменяет последствия решений.

Любая коррекция controller-а является canonical событием и видна в debug metrics.

Точный field scan/extraction lifecycle, territory storm phases и идемпотентный post-storm find spawn определены в [[13_WORLD_SYSTEMS_SPEC]] §11.

## 16. Популяция

- смерть окончательна;
- новые люди входят пакетами через определённые entry points;
- newcomer имеет причину прибытия, стартовые ресурсы и связи, но не выдуманную длинную биографию;
- target population — конфигурационный диапазон, а не жёсткое число;
- пополнение реагирует на долгосрочный дефицит с задержкой и не заменяет погибшего «клоном».

Если популяция вышла за safety range из-за бага, soak test падает. Runtime controller не маскирует нарушение инвариантов.

## 17. Память и обучение

Эпизодическая память создаётся только из значимых claims/events. Importance зависит от угрозы жизни, изменения отношений, редкости и связи с целью.

Рефлексия — детерминированное структурированное правило MVP: объединяет несколько эпизодов в belief/route preference. После Gate E внешний renderer может переформулировать её только для показа, не меняя вывод или память агента.

Навык растёт через bounded diminishing returns после завершённого действия. Один эпизод не превращает новичка в мастера.

## 18. Разговоры и representation

Canonical сцена создаёт `conversation_intent` до любого текста:

- цель;
- допустимые speakers;
- claims, которые можно сообщить;
- отношения и mood;
- разрешённые speech acts;
- запрещённые факты;
- structured outcome.

В основном прототипе детерминированный шаблон создаёт representation после commit. Fact validator проверяет entity ids, claim provenance, место, время и запрещённые утверждения. Не прошедший текст заменяется безопасным шаблоном; canonical сцена остаётся завершённой.

Core representation хранит renderer/version, input hash и validation result отдельно от world events. Только в опциональной I18 отдельная запись generation attempt добавляет prompt/output version, provider, model, latency и token usage; эти поля не добавляются в canonical event или core state.

## 19. Летопись и легенды

Chronicle сначала строит машинный causal cluster по `caused_by`, участникам, месту и времени. Затем renderer создаёт сводку. Любое предложение сводки должно ссылаться на event ids или явно маркироваться как интерпретация.

Legend status считается из:

- редкости и трудности подтверждённых событий;
- независимых свидетелей;
- распространения имени между social clusters;
- продолжительности внимания;
- влияния на ресурсы, маршруты и отношения.

Truth legend и social legend считаются отдельно. Поэтому возможен миф, который не совпадает с фактами.

## 20. Минимальная taxonomy событий

### World/navigation

- `weather.changed`, `route.condition_changed`, `hazard_field.changed` и значимые изменения фазы/состояния мира;
- `journey.started`, `journey.interrupted`, `journey.completed`;
- `creature.sign_observed`, `creature.migrated`, `threat.observed`, `encounter.started`, `encounter.avoided`;
- `territory_storm.warned`, `territory_storm.started`, `territory_storm.ended`;
- `shelter.entered`, `shelter.denied`, `expedition.started`, `expedition.returned`, `expedition.missing`;
- `territory.influenced`, `territory.contested`, `territory.occupied`, `territory.controlled`, `territory.isolated`;
- `base.module_damaged`, `checkpoint.passed`, `checkpoint.denied`, `patrol.started`, `patrol.relieved`.

### Body/resources

- `need.threshold_crossed`, `wound.received`, `treatment.applied`;
- `item.acquired`, `item.extracted`, `item.transferred`, `item.consumed`, `item.repaired`, `item.lost`;
- `item.equipped`, `weapon.reloaded`, `weapon.malfunctioned`, `ammunition.consumed`;
- `combat.started`, `combat.shot_fired`, `combat.retreat_completed`, `combat.resolved`;
- `agent.incapacitated`, `agent.surrendered`, `agent.died`, `agent.arrived`, `custody.started`, `custody.ended`.

### Social/information

- `obligation.created`, `obligation.fulfilled`, `obligation.broken`;
- `relationship.changed`;
- `trade.completed`, `shipment.arrived`, `organization.membership_changed`, `organization.norm_violated`;
- `diplomacy.changed`, `truce.started`, `truce.violated`, `truce.expired`;
- `contract.offered`, `contract.accepted`, `contract.completed`, `contract.failed`;
- `claim.observed`, `claim.inferred`, `claim.transmitted`, `claim.fabricated`;
- `scene.started`, `scene.resolved`.

Event names не обязаны появляться в публичном API один к одному. Published feed — отдельная projection.

Обычное продвижение scheduler clock не создаёт `world.time_advanced` на каждый due timestamp: canonical world time фиксируется в event envelope/snapshot. Отдельное событие времени нужно только когда сам переход фазы является значимым фактом.

## 21. Обязательные инварианты

К инвариантам из [[02_SIMULATION_DESIGN]] добавляются:

- `world.sequence` строго монотонен и уникален внутри мира;
- `world_time` не уменьшается;
- scheduled action не исполняется дважды;
- агент не участвует одновременно в несовместимых сценах;
- сумма количества уникального предмета сохраняется между source/sink событиями;
- unique anomalous find имеет ровно один source root и не появляется при restock/replay повторно;
- trader inventory меняется только через trade/supply/loss/source events;
- shelter occupancy не превышает capacity, отказ/вытеснение фиксируются событием;
- неизвестное агенту/зрителю anomaly field не раскрывает exact geometry через decision trace/public projection;
- relationship меняется только из события, известного субъекту изменения;
- два пересказа одного источника не считаются независимыми подтверждениями;
- ошибка любого representation renderer не меняет canonical snapshot;
- изменение wall clock или скорости worker-а не меняет event order;
- rules/content/schema bundle version и checksum присутствуют в snapshot и прогоне, а соответствующие immutable bundles доступны для restore/replay;
- любой published факт трассируется до observer signal и canonical/claim provenance;
- никакая корректирующая системная механика не работает скрытно.

Дополнительные инварианты territory/base, economy/logistics, combat/custody и storm/find lifecycle из [[13_WORLD_SYSTEMS_SPEC]] §17 обязательны наравне с этим списком.

## 22. Метрики здоровья мира

### Технические

- simulation lag, due queue depth, transaction retries;
- events per game hour, snapshot size, replay duration;
- stuck actions/scenes, invariant failures;
- latency/failure template renderer отдельно от simulation health; LLM cost/tokens появляются только в опциональной I18.

### Системные

- смертность, среднее здоровье, population range;
- sources/sinks и дефицит по каждому ресурсу;
- доля времени в пути/сценах/idle;
- разнообразие целей и типов событий;
- число social edges и изоляция агентов;
- скорость и глубина распространения слухов;
- концентрация торговли и насилия по локациям.

### Нарративные

- причинная глубина историй;
- число независимых участников и точек зрения;
- последствия спустя сутки и более;
- доля опубликованных сигналов, которые зритель может объяснить;
- повторяемость текста и сцен.

Метрики не должны автоматически «режиссировать» конкретных героев. Они нужны для тестов, балансировки и обнаружения скучных режимов.

## 23. Явно не в MVP

- свободная геометрическая навигация и физика;
- полноценное производство/crafting;
- политика с десятками организаций;
- размножение и семейные поколения;
- LLM как decision maker (вне текущего product scope и после MVP);
- векторная память;
- голос, procedural music и изображения событий;
- влияние зрителя на канонический мир;
- несколько одновременно активных публичных миров.
