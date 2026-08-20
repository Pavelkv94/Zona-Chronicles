# Итерационный master-plan реализации

Статус: accepted implementation roadmap  
Дата: 2026-08-20

Этот документ является основным порядком реализации. [[05_ROADMAP_AND_BACKLOG]] хранит укрупнённые этапы и идеи, а здесь определено, что именно делать, проверять и наблюдать по одной итерации.

## 1. Правило движения

Нельзя переходить к следующей итерации только потому, что код написан. Каждая итерация заканчивается одним решением:

- **GO** — критерии выполнены, можно идти дальше;
- **REWORK** — гипотеза верна, но реализация/баланс не прошли gate;
- **SPLIT** — scope оказался слишком большим, остаток превращается в новую итерацию;
- **STOP** — гипотеза или архитектурное решение опровергнуты, сначала нужен ADR/перепроектирование.

Ориентир размера — 1–4 рабочих дня при разработке через AI-агентов. Если итерацию нельзя продемонстрировать и проверить за этот срок, orchestrator обязан разделить её до начала кода.

Внутри итерации допускается несколько TDD Red → Green циклов, но только одна продуктовая гипотеза.

## 2. Обязательный цикл каждой итерации

```text
0. Orchestrator читает предыдущий iteration report.
1. Формулирует одну гипотезу и observable demo.
2. Замораживает command/event/API contracts и file ownership.
3. Spec/test subagent создаёт падающий acceptance test в iteration branch.
4. Implementation subagents выполняют зависимые TDD-задачи.
5. Independent test reviewer ищет ложноположительные тесты и пропуски.
6. Architecture reviewer проверяет границы и replay/determinism.
7. Orchestrator последовательно интегрирует worktrees и запускает gate.
8. Человек смотрит demo/отчёт и записывает GO/REWORK/SPLIT/STOP.
```

Минимальная команда даже для небольшой кодовой итерации:

- orchestrator/lead;
- один spec/test subagent;
- один implementation subagent;
- один независимый reviewer subagent.

Один subagent может выполнить несколько последовательных задач одной роли, но implementer не принимает собственную работу. Полная agent team нужна только когда после заморозки контракта есть независимые области файлов.

Model routing обязателен:

- orchestrator, contract steward, architecture reviewer и simulation analyst — **Opus**;
- acceptance author, все implementers и test reviewer — **Sonnet**;
- lead не выполняет feature implementation на Opus, а делегирует её Sonnet-subagents;
- alias и точный resolved model ID каждого участника записываются в iteration report.

## 3. Evidence package итерации

В `docs/iterations/IXX-name/` сохраняются:

```text
PLAN.md               # гипотеза, scope, contracts, task graph
ACCEPTANCE.md         # Given/When/Then и ручной demo script
REPORT.md             # test output, метрики, наблюдения, решение
artifacts/
  events.jsonl        # выбранный raw canonical log
  initial.json        # начальный snapshot
  final.json          # конечный snapshot
  world-health.json   # distributions и нарушения
  causal-chains.json  # автоматически извлечённые цепочки
  interventions.json  # действия системных controller-ов
  replay-checksum.txt
  limit-checkpoints/  # архив checkpoint/resume evidence, если usage window прерывал работу
  security/           # threat-model delta, scan summaries, exceptions с owner/expiry
  operations/         # migration/restore/load/SLO evidence, когда применимо
  screenshots/        # только если итерация меняет UI
```

`REPORT.md` обязательно отвечает:

1. Что впервые стало возможным наблюдать?
2. Какой тест был красным до реализации?
3. Какие автоматические gates пройдены?
4. Что увидел человек при demo?
5. Какие отклонения/риски найдены?
6. Решение GO/REWORK/SPLIT/STOP и почему?
7. Что является входом следующей итерации?
8. Какие model alias и resolved model ID использовали lead/subagents?

Без `REPORT.md` итерация не завершена.

После появления headless loop действует единый sampling protocol:

- PR: deterministic fixtures и 20 seed × 1 игровой день;
- nightly: 100 seed × 7 игровых дней;
- milestone: неизменяемый regression bank плюс свежий holdout bank;
- hard invariant проходит на 100% прогонов;
- для мягких метрик сохраняются median, p10/p90 и доля seed в допустимом диапазоне;
- seed и временные окна выбираются до просмотра результата, истории нельзя cherry-pick-ать для gate.

Числовые диапазоны сначала помечаются `provisional`. После baseline их можно менять только через iteration report с before/after distributions; ослабление gate ради зелёного CI запрещено.

## 4. Архитектура orchestrator и subagents

### Orchestrator/lead

Единственный владелец:

- iteration plan и dependency graph;
- общих contracts до их freeze;
- root configs, lockfile и dependency installation;
- порядка SQL migrations;
- назначения worktrees и owned paths;
- интеграции веток;
- финального gate и iteration decision.

Orchestrator не разрешает агенту одновременно менять production behavior и ослаблять проверяющий его acceptance test. Если test должен измениться, сначала меняется спецификация и причина фиксируется в `PLAN.md`.

Падающий acceptance commit не сливается отдельно в `main`. Orchestrator запускает его, фиксирует commit SHA и ожидаемую failure signature, затем создаёт implementation worktrees от этого contract-freeze commit. Frozen acceptance paths для implementer read-only. В `main` acceptance test попадает только вместе с прошедшей реализацией после gate.

### Обязательные subagents

**Contract steward**:

- владеет event/command/API schemas и contract tests по заданию lead;
- не пишет domain rules, SQL или UI;
- обязателен, если итерация вводит/ломает публичный contract.

**Spec/test agent**:

- владеет acceptance test и test fixtures;
- доказывает, что тест падает по нужной причине;
- не пишет production implementation.

**Domain implementer**:

- commands, events, reducers, policies, unit/property tests;
- не трогает SQL, HTTP, UI и LLM.

**Persistence implementer**:

- migrations, repositories, transactions и outbox;
- не дублирует доменные правила в SQL.

**Projection/API implementer**:

- read models, Fastify routes, SSE и contract tests;
- не меняет canonical state и migrations без отдельной задачи.

**Frontend implementer**:

- public DTO, observer projections, accessibility и E2E selectors;
- не читает canonical tables и не вычисляет world truth.

**Test reviewer**:

- работает после implementers;
- проверяет rejection paths, idempotency, deterministic seams, false positives;
- сначала возвращает findings; исправления делаются отдельной задачей.

**Architecture reviewer**:

- read-only аудит dependency direction, event semantics, migrations, replay;
- обязателен на milestone gates и при изменении ADR/contracts.

**Simulation analyst**:

- запускает multi-seed/soak сценарии;
- анализирует distributions, stuck agents и causal chains;
- не меняет коэффициенты в том же turn, в котором оценивает результат.

### Изоляция и порядок merge

- каждый code-writing agent получает отдельный git worktree;
- задача содержит base commit, owned paths и запрещённые paths;
- teammates не редактируют один файл одновременно;
- `pnpm-lock.yaml`, root configs и migration sequence меняет только orchestrator;
- contract/spec branch объединяется первой;
- domain и adapters могут идти параллельно только после contract freeze;
- reviewer начинает после объединения candidate branch;
- orchestrator не делает blind merge: читает diff и полный gate output.

Contract, acceptance/replay fixtures, root configs, CI, lockfile и migration sequence являются protected paths. В каждый момент у них ровно один writer. Scope hooks сравнивают `git diff --name-only` с declared write set при завершении subagent/task.

Рекомендуемое именование:

```text
iteration/I03-journey
agent/I03-contract
agent/I03-domain
agent/I03-persistence
agent/I03-frontend
agent/I03-review
```

## 5. Карта milestones и итераций

| Milestone | Итерации | Что доказано |
|---|---|---|
| A. Инженерный фундамент | I00–I03 | Полная вертикаль от команды до карты воспроизводима |
| B. Автономное выживание | I04–I07 | Агенты сами поддерживают жизнь и создают первый долг |
| C. Социальный мир | I08A–I11B | Экономика, организации, базы, контракты, территория и локальная информация образуют работающую инфраструктуру |
| D. Опасный наблюдаемый мир | I12A–I15B | Экипировка, перестрелки, рейды, существа, аномальные поля, буря, UX и 7-дневная устойчивость работают |
| E. Основной template-only прототип | I16–I17 | Архив и легенды доступны зрителю, закрытая проверка пройдена без генеративного ИИ |
| F. Опциональный narrative experiment | I18 | Проверено, даёт ли LLM измеримую пользу поверх готового прототипа |

Каждый milestone имеет отдельный stop/go gate. Нельзя маскировать провал предыдущего milestone интерфейсом или LLM.

Оригинальный visual/content track начинается с moodboard, asset manifest и ручных эскизов на Этапе 0, но не блокирует headless mechanics. Production assets интегрируются отдельной I14B по [[12_VISUAL_AND_CONTENT_DESIGN]]. Content author не меняет mechanics/contracts ради красивого лора; новые системные свойства проходят обычный requirement/ADR/TDD process.

### Dependency map расширенных систем

```text
I08A sources/sinks -> I08B trader/supply -> I08C services
                         |                    |
                         v                    v
I09A organizations -> I09B diplomacy -> I09C bases -> I09D territory influence
        |                                      |
        v                                      v
I10A knowledge/radio -> I10B contracts -> I10C patrols/expeditions
                                      -> I11A scene kernel -> I11B templates

I12A equipment -> I12B firefight -> I12C surrender/loot -> I12D raid/capture
        |                                                    ^
        +------------------------ I09D -----------------------+
        +-> I12E creatures/hunt

I13A fields/scan -> I13B extraction
I13A + I13C storm/shelter -> I13D post-storm reseed -> contracts/economy/territory
I12E + I13C -> I13E weather/ecology/population

all mechanics -> I14A/I14B observer+content -> I15A ablation -> I15B soak
```

Итерация не объединяет обе стороны стрелки. В mechanic slice вводится минимальный original fixture, а массовые варианты контента ждут I14B. I15A–I15B не принимают новые механики: обнаруженный отсутствующий behavior возвращается в отдельную REWORK/SPLIT-итерацию перед балансом.

# Milestone A — инженерный фундамент

## I00 — Repository и agent harness

**Гипотеза:** Claude Code agents могут безопасно работать в репозитории с быстрым единым gate.

**Scope:**

- pnpm/Turborepo workspace;
- strict TypeScript, ESLint import boundaries, Prettier;
- `CLAUDE.md`, `.claude/agents`, task/iteration templates;
- `.claude/settings.json`, deny/ask permissions, sandbox fail-closed profile и tested protected-path/write-set hooks;
- Vitest projects, fast-check, Testcontainers setup;
- Fastify health route, migration runner, пустой worker/CLI;
- Docker Compose и provider-neutral CI commands;
- frozen install, secret/dependency/license/static scan skeleton и machine-readable policy/exception format;
- usage-window monitor port, persisted checkpoint и external wake/resume harness по [[08_TDD_AND_AGENT_WORKFLOW]]; без hard-coded provider UI parsing в domain/code packages.

**Orchestration:** setup implementer → test/tooling reviewer; root files объединяет только lead.

**Автоматическая проверка:** чистый clone выполняет frozen install, format check, lint/boundaries, typecheck, unit test, integration smoke, secret/dependency/license/static scans и build одной документированной командой; hooks fixtures блокируют protected-path, write-set и запрещённый network/install, но разрешают заявленные операции; fake usage telemetry доказывает переходы `2% → checkpoint_only → 1% → wait → reset → resume` без duplicate command/commit.

**Ручной demo:** новый Claude session читает `CLAUDE.md`, находит команды, создаёт намеренно падающий тест и исправляет маленькую test fixture без нарушения boundaries; отдельный accelerated dry-run прерывает его на fake 1%, показывает persisted checkpoint и автоматически продолжает тот же шаг после fake reset.

**GO:** gate воспроизводим локально и в CI; один PostgreSQL container поднимается/останавливается; agent definitions доступны; critical restrictions подтверждены deny/hook/lint/CI tests, а не только ответом агента; auto-resume dry-run сохраняет task/branch/HEAD/diff/test state и не требует ручного повторного prompt.

**STOP/REWORK:** flaky bootstrap, неявные глобальные зависимости, agent может импортировать adapter из domain; runner обещает автоматическое продолжение без telemetry/persisted wake/session resume либо теряет/дублирует работу на reset.

## I01 — Детерминированное доменное ядро

**Гипотеза:** command → events → state полностью проверяется без базы и framework.

**Scope:**

- исполняемые TypeBox envelopes v1;
- Clock, RandomSource, IdFactory, Ruleset ports;
- deterministic runtime profile, numeric units/rounding и canonical serialization v1;
- `decide/evolve` interfaces;
- минимальные world/location/agent fixtures;
- CLI in-memory `world seed` и `world inspect`.

**Автоматическая проверка:** schema round-trip, exhaustive event handling, запрещённые `Date.now/Math.random`, одинаковый seed создаёт одинаковый canonical JSON/checksum; locale/timezone/key insertion order не меняют result; `NaN/Infinity` и неописанное округление отклоняются; snapshot проверяет checksums immutable rules/content/schema bundles.

**Ручной demo:** два независимых запуска seed показывают одинаковый мир; изменение seed даёт другой, но валидный мир.

**GO:** 100 повторов на нескольких seed детерминированы; domain не импортирует adapters.

**STOP/REWORK:** IDs или timestamps зависят от wall clock; schema/types расходятся.

## I02A — Атомарный старт journey

**Гипотеза:** первый настоящий command меняет durable state атомарно и идемпотентно.

**Scope:**

- 1 агент, 2 location и 1 route;
- `journey.start` command и `journey.started` event;
- PostgreSQL migrations для world, command results, events, current state и outbox;
- транзакция command → events/state/outbox;
- optimistic version и idempotency;
- сохранение accepted/rejected command result.

**Автоматическая проверка:** happy/rejection/idempotency, invalid route, inactive actor, duplicate command, rollback в каждой точке транзакции, concurrent command, migration с пустой/предыдущей схемы.

**Ручной demo:** CLI начинает путь; повтор команды возвращает прежний результат; restart CLI/API видит сохранённое journey state.

**GO:** event/state/outbox и command result никогда не расходятся в fault tests.

**STOP/REWORK:** partial commit, duplicate event, DB-типы или транзакции протекли в domain.

## I02B — Scheduler, завершение journey и replay

**Гипотеза:** принятый план автономно завершается, а canonical state переживает crash.

**Scope:**

- `journey.complete` scheduled action и `journey.completed` event;
- stable due ordering, worker lock/lease и reclaim;
- scheduled actions, snapshots и PRNG positions;
- replay/resimulation CLI;
- advisory world lock и `SKIP LOCKED` queue pattern.

**Автоматическая проверка:** concurrent claim, lease timeout, duplicate completion, разные batch sizes, pause/resume, snapshot+suffix=full replay, stable same-timestamp ordering.

**Ручной demo:** остановить worker между start/complete, затем продолжить без пропуска/дубликата и сравнить checksum с непрерывным прогоном.

**GO:** event log/checksum совпадают после restart; manual state repair не нужна.

**STOP/REWORK:** порядок зависит от скорости worker-а, due action исполняется дважды или replay требует PRNG.

## I03 — Journey до браузера

**Гипотеза:** один факт проходит через весь стек и понятен зрителю.

**Scope:**

- расширение fixture до 3 location и нескольких routes;
- snapshot/feed projections;
- Fastify snapshot API и SSE resume;
- минимальный Next.js экран: карта узлов + event feed;
- Playwright journey scenario.

**Автоматическая проверка:** route preconditions, disconnected route rejection, stable order, idempotency, replay, API schemas, SSE `Last-Event-ID`, E2E journey visible.

**Ручной demo:** начать путь через CLI/admin command, увидеть его на карте, дождаться завершения, перезагрузить страницу и восстановить состояние.

**GO:** наблюдаемый результат совпадает с canonical log; restart API/worker/browser ничего не теряет.

**STOP/REWORK:** UI читает canonical tables; SSE является единственным способом восстановить state; journey не объясним из событий.

## Gate A — решение по фундаменту

Перед I04 architecture reviewer и человек подтверждают:

- полный путь contract → domain → PostgreSQL → projection → API/SSE → UI;
- replay/restart/idempotency доказаны;
- CI стабилен минимум на 10 последовательных запусках;
- новый механизм можно добавить без правки несвязанных packages;
- iteration evidence сохранён.

Если хотя бы один пункт не выполнен, новые mechanics запрещены.

# Milestone B — автономное выживание

## I04 — Нужды, предметы, еда и отдых

**Гипотеза:** ресурсы и тело создают реальную необходимость действовать.

**Scope:** hunger/fatigue pulses, inventory ownership, consume/eat/rest, threshold events, basic sources/sinks.

**Автоматическая проверка:** conservation properties, нельзя потратить дважды, bounded needs, dead/inactive restrictions, batch-size independence.

**Ручной demo:** один агент проходит цикл голод → еда → восстановление; отсутствие еды приводит к наблюдаемому ухудшению, а не silent stat change.

**GO:** 24 игровых часа для 5 агентов без invalid state/event spam.

**STOP/REWORK:** агент выживает без resources; pulses создают непросматриваемый поток событий.

## I05 — Utility AI и короткие планы

**Гипотеза:** агенты автономно выбирают объяснимые цели без LLM.

**Scope:** candidate goals, scoring, hysteresis, emergency interrupt, plan 3–6 steps, invalidation, decision trace.

**Автоматическая проверка:** bounded finite scores, deterministic tie-break, no thrashing, invalid precondition causes replanning, property sequences.

**Ручной demo:** 10 агентов автономно проживают сутки; сравнить 3 агентов с разными traits в одинаковой ситуации и объяснить различие через decision trace.

**GO:** 10 агентов проживают сутки без ручных команд; доля бесконечных replans = 0.

**STOP/REWORK:** одинаковые агенты ведут себя случайно при том же seed; goal switching доминирует над действиями.

## I06 — Опасность, субъективный риск и encounter

**Гипотеза:** неполное знание маршрутов меняет решения и создаёт встречи без обязательного боя.

**Scope:** route risk, observation, subjective risk map, detection, avoid/signal/meet outcomes, threat movement MVP.

**Автоматическая проверка:** агент не использует неизвестный canonical risk; encounter требует географического пересечения; provenance observations; stable outcomes.

**Ручной demo:** осторожный агент выбирает обход после наблюдения, любопытный принимает риск; зритель видит только доступный signal.

**GO:** несколько seed дают как встречи, так и избегание; нет телепатии/невозможных контактов.

**STOP/REWORK:** canonical risk протекает в public/agent state; encounter rate почти 0% или 100%.

## I07 — Рана, помощь и обязательство

**Гипотеза:** физическая уязвимость создаёт первую долгосрочную социальную причинность.

**Scope:** wound/bleeding, treatment, request/help/refusal scene, medicine consume, obligation, relationship delta.

**Автоматическая проверка:** medicine atomicity, participant presence, treatment preconditions, obligation provenance, replay causal edges.

**Ручной demo:** раненый просит помощь; один союзник помогает и создаёт долг, другой при заданных условиях отказывает; показать causal chain.

**GO:** цепочка «рана → просьба → помощь/отказ → долг/отношение → следующее решение» воспроизводима и понятна без текста LLM.

**STOP/REWORK:** relationship меняется у тех, кто не знает события; помощь создаётся из воздуха.

## Gate B — решение по автономному выживанию

- 30 seed × 24 игровых часа на мире из 10 агентов без invariant failure;
- нет stuck agents/scenes и необъяснимого resource creation;
- человек может объяснить минимум одну цепочку из 4+ событий;
- LLM выключена;
- UI остаётся минимальным и не скрывает debug evidence.

Если мир не умеет поддерживать жизнь и создавать выбор, социальные системы не добавляются.

# Milestone C — социальный мир

## I08A — Sources, sinks и локальная стоимость

**Гипотеза:** ограниченные sources/sinks и локальный дефицит создают различимую стоимость до появления сложных traders.

**Scope:** four consumable categories, item condition, capped sources/sinks, local scarcity, bounded valuation, atomic barter между двумя агентами, economy metrics.

**Автоматическая проверка:** conservation, atomic deal/rollback, bounded replenishment/price multipliers, no negative inventory, multi-seed stock distributions.

**Ручной demo:** один предмет имеет разную субъективную стоимость в двух местах; дефицит меняет решение обменять/сохранить.

**GO:** 3 игровых дня без необъяснимого создания/исчезновения ресурсов; scarcity влияет на Utility AI.

**STOP/REWORK:** valuation NaN/unbounded; controller подыгрывает конкретному агенту; barter дублирует предмет.

## I08B — Trader, рынок и физические поставки

**Гипотеза:** конечный trader inventory и физические supplier routes превращают опасность маршрута в цены и shortages.

**Scope:** persistent trader/market venue, orders/spread, supplier entry, cargo/shipment journey, arrival/loss/interception outcomes, deferred payment.

**Автоматическая проверка:** inventory ledger, shipment cargo conservation, no magic restock, idempotent arrival/loss, bounded spread, trader knowledge не глобальное.

**Ручной demo:** перервать shipment на маршруте и увидеть shortage/price change; восстановить поставку реальной delivery.

**GO:** trader может отказать/обеднеть/потерять поставку; рынок восстанавливается только через source/journey/trade.

**STOP/REWORK:** `shipment.arrived` без cargo journey; один trader получает >70% оборота из-за бага.

## I08C — Services: медицина, проводник и bounded repair

**Гипотеза:** ограниченные services создают новые экономические и социальные решения без crafting system.

**Scope:** medic/guide/technician roles, service offer/request, staff/location/time/capacity, spare parts/medicine consumption, repair condition delta, payment/obligation.

**Автоматическая проверка:** no service without staff/stock/time/reachability, bounded repair, atomic payment, queue capacity, provider death/absence disables service.

**Ручной demo:** раненому отказывают из-за stock; guide меняет route; technician чинит radio с расходом запчасти.

**GO:** service доступность/цена влияют на plans и не создают items/health из текста.

**STOP/REWORK:** service работает удалённо без channel/rules; repair создаёт новый предмет или превышает max condition.

## I09A — Организации, membership, нормы и репутация

**Гипотеза:** group norms и многомерные отношения меняют будущие решения.

**Scope:** memberships/roles, doctrine/economic base/territory goals, recruitment/expulsion, reputation by organization, trust/fear/respect/suspicion, norms, witness-dependent consequences.

**Автоматическая проверка:** directed relationships/reputation, bounded deltas, witnesses/provenance, membership/norm violation state machines, no global reputation update.

**Ручной demo:** один и тот же отказ имеет разные последствия для союзника, незнакомца и должника.

**GO:** doctrine/membership/reputation меняют access, cooperation и следующее Utility AI решение, а не только карточку.

**STOP/REWORK:** отношения меняются глобально или не влияют ни на одно решение.

## I09B — Diplomacy и truce

**Гипотеза:** отношения организаций меняются из накопленных событий и создают сотрудничество/напряжение без случайного переключателя войны.

**Scope:** directed org trust/fear/grievance/dependency/border pressure, allied/cooperative/neutral/tense/hostile/truce states, hysteresis, truce scope/expiry/violation.

**Автоматическая проверка:** bounded evidence, no one-roll war, stable hysteresis, truce obligations/witnesses, replay.

**Ручной demo:** supply dependency удерживает tense organizations от войны; witnessed truce violation переводит отношения в hostile через causal evidence.

**GO:** diplomacy state объяснима событиями и реально меняет target/contract/access policies.

**STOP/REWORK:** все организации неизбежно скатываются в войну; неизвестное нарушение меняет diplomacy глобально.

## I09C — Bases, modules и outposts

**Гипотеза:** база является снабжаемым физическим местом, потеря modules/staff которого меняет мир.

**Scope:** расширение world fixture с 3 до 5–7 strategic nodes; base ownership claim без capture; минимум 2 снабжаемые базы/крупных outpost разных сторон; shelter/storage/market/medical/workshop/radio/garrison/observation modules, staff/inventory/capacity/condition, outpost/checkpoint data.

**Автоматическая проверка:** module cannot operate without staff/stock/condition, storage ownership, capacity, no service teleport, outpost subset rules.

**Ручной demo:** потеря medicine отключает treatment; damage repeater обрывает channel; repair восстанавливает module реальными parts/time.

**GO:** base services/shelter/storage зависят от физического state и доступны через явные rules.

**STOP/REWORK:** owner flag создаёт ресурсы; пустой/повреждённый module продолжает работать.

## I09D — Influence, checkpoints и мирная смена контроля

**Гипотеза:** физическое присутствие, снабжение и локальная поддержка могут объяснимо менять влияние без реализации штурма.

**Scope:** `territory_node`, directed control claims/pressure factors, unclaimed/influenced/contested/occupied/controlled/isolated states, checkpoint access/toll scenes, supply connectivity, non-combat withdrawal/occupation/consolidation.

**Автоматическая проверка:** no instant flag capture, presence/supply/time preconditions, bounded pressure, deterministic tie-break, isolation decay, checkpoint tied to route edge, control effects whitelist.

**Ручной demo:** организация теряет supply route, база изолируется, rival patrol занимает оставленный outpost и получает control только после доставки и consolidation.

**GO:** смена контроля требует видимой причинной цепочки; контроль меняет доступ/пошлины/patrol policy, но не создаёт ресурсы или всеведение.

**STOP/REWORK:** один персонаж или один roll мгновенно захватывает node; owner flag работает без garrison/supply.

## I10A — Знания, слухи и локальное радио

**Гипотеза:** информация распространяется локально, и разные участники имеют несовместимые версии мира.

**Scope:** knowledge claims, confidence, witnessed/told/inferred/fabricated, transmission/distortion, independent source graph, local radio channels/repeaters and reception.

**Автоматическая проверка:** finite provenance roots, no spontaneous knowledge, source independence, confidence bounds, channel/range/repeater access, replay.

**Ручной demo:** проследить слух через 3 людей и радиоузел, показать потерю детали и сравнить с canonical fact только в researcher mode.

**GO:** два social clusters знают разные версии; выключение repeater разрывает передачу; claim и факт различаются в projection.

**STOP/REWORK:** пересказы считаются независимыми подтверждениями; radio является глобальным broadcast; LLM нужна для работы слуха.

## I10B — Контракты и обязательства

**Гипотеза:** структурированные jobs связывают потребности базы с автономными решениями агентов.

**Scope:** offer/accept/reject/expire/complete/fail, delivery/escort/survey/retrieve/rescue/hunt/patrol/defend/service types, reward/escrow, deadline, issuer knowledge, acceptance capacity.

**Автоматическая проверка:** objective completion only from canonical events, no double accept/reward, issuer solvency/explicit debt, deadline ordering, unavailable knowledge not leaked, replay.

**Ручной demo:** shortage создаёт delivery contract; агент принимает его по reward/risk/obligation, доставляет cargo, а второй contract проваливается из-за witnessed loss.

**GO:** контракты возникают из world needs, влияют на планы и закрываются без текстовой команды/ручного квестодателя.

**STOP/REWORK:** contract создаётся ради зрителя; текстовый отчёт закрывает objective; reward появляется из ничего.

## I10C — Патрули и экспедиционная логистика

**Гипотеза:** группы физически готовят и выполняют совместные sorties вместо фонового teleport encounter.

**Scope:** patrol shifts/routes/abort conditions; expedition proposed/recruiting/provisioning/departing/active/returning/debriefed/stranded/missing/failed; leader, members, cargo, detector/medical needs and radio policy; temporary field camps и physical caches.

**Автоматическая проверка:** membership/location/cargo conservation, provisioning preconditions, leader loss/replan, return threshold, no patrol spawn near target, missing is not death, camp/cache item conservation и knowledge provenance, deterministic scheduling.

**Ручной demo:** survey expedition не выходит без detector, затем комплектуется, теряет связь и возвращается с расходами/знанием; patrol сменяет checkpoint по маршруту.

**GO:** sortie имеет подготовку, путь, расходы и aftermath; failure создаёт новые contracts/claims, а не исчезает из state.

**STOP/REWORK:** expedition является одним success roll; отсутствующие участники одновременно действуют в другом месте.

## I11A — Универсальное ядро сцен

**Гипотеза:** общий конечный scene kernel безопасно координирует несколько участников и последствия.

**Scope:** join/leave, initiative/order, intents, bounded rounds/timeouts, interrupt/cancel, location/channel access, structured outcomes; без художественного dialogue layer.

**Автоматическая проверка:** no incompatible double scene, bounded transitions, participant access, crash/retry idempotency, scheduled timeout ordering.

**Ручной demo:** встреча переходит в help/dispute и завершается; interruption опасностью корректно отменяет незавершённые действия.

**GO:** scene не может зависнуть или скрыто изменить state; outcomes являются typed events.

**STOP/REWORK:** правила отдельных сцен дублируют coordination kernel; реплика становится command.

## I11B — Социальные/service-сцены и template-only подача

**Гипотеза:** structured speech acts и шаблоны делают trade/help/dispute/service/radio/shelter/briefing понятными без генеративной модели.

**Scope:** scene policies перечисленных типов, offer/request/refuse/warn/report acts, deterministic templates, observer signals, grounding links к intent/claim/event.

**Автоматическая проверка:** template grounding, knowledge/access rules, bounded dialogue turns, representation cannot create facts, LLM/provider dependency absence.

**Ручной demo:** посмотреть торговую, briefing и конфликтную сцену; каждая реплика трассируется до доступного claim/intent.

**GO:** template-only эфир помогает понять события и не является источником canonical изменений.

**STOP/REWORK:** сцены требуют generated prose; текст раскрывает неизвестное или меняет outcome.

## Gate C — решение по социальной симуляции

- 50 seed × 3 игровых дня на мире из 20 агентов;
- минимум в 80% holdout seed возникают три causal chains глубиной 4+ meaningful events, с 2+ агентами, 2+ системами и последствием спустя 24 игровых часа;
- knowledge provenance violations = 0;
- экономика остаётся в установленных ranges;
- базы и services зависят от staff/stock/condition, а supply shipments физически достижимы;
- diplomacy, contracts, patrols и non-combat territory control имеют causal evidence и влияют на решения;
- вручную просмотрены минимум 3 разные causal chains;
- ни одна цепочка не зависит от заранее написанного sequence или LLM.

# Milestone D — опасный наблюдаемый мир

## I12A — Экипировка, оружие, защита и детекторы

**Гипотеза:** физические свойства снаряжения меняют risk/route/loadout decisions ещё до полноценного боя.

**Scope:** equipment slots, condition/weight, weapon ammo/magazine/range/reliability/noise, protection zones/resistance/durability, detector range/sensitivity/power, contamination/exposure profiles, equip/reload/maintain/repair/treat contracts.

**Автоматическая проверка:** ownership/equip preconditions, ammunition conservation, bounded protection/detector modifiers, condition degradation, no incompatible slots, deterministic malfunction, encumbrance limits.

**Ручной demo:** два агента выбирают разные loadout/route; пустой magazine требует reload, слабый detector не подтверждает опасность, повреждённая защита меняет оценку риска.

**GO:** экипировка влияет на Utility AI и имеет sources/sinks; ни один item не является декоративным stat card.

**STOP/REWORK:** weapon создаёт ammunition; detector выдаёт global truth; repair обходит parts/time.

## I12B — Перестрелка между людьми

**Гипотеза:** конечная explainable combat scene создаёт необратимые последствия, сохраняя возможность избежать боя и отступить.

**Scope:** warn/aim/fire/move-cover/suppress/retreat/assist, discrete rounds, range/visibility/cover slots, hit resolution, wounds/shock/bleeding/morale, medical stabilization, death.

**Автоматическая проверка:** terminal death, ammo conservation, bounded scene/rounds, valid cover and line-of-fire, retreat paths, dead/incapacitated restrictions, batch/replay identity.

**Ручной demo:** одна напряжённая встреча заканчивается отступлением, другая — ранением и эвакуацией; decision trace объясняет aim/fire/retreat.

**GO:** бой конечен и причинно объясним; outcome не переписывается ради популярного агента.

**STOP/REWORK:** любой hostile encounter автоматически становится боем; battle loop не имеет terminal bound; лечение происходит внутри выстрела без ресурсов.

## I12C — Сдача, плен, loot и aftermath

**Гипотеза:** поражение не всегда означает смерть, а последствия боя расходятся по телам, предметам, знаниям и отношениям.

**Scope:** offer/demand/accept surrender, disarm/custody/release/exchange/escape, body/cargo loot claims, item transfer/damage/loss, casualty knowledge, grievance/reputation/contract aftermath.

**Автоматическая проверка:** consent/incapacity/custody rules, no double loot, each item/person outcome, no action by captive, witness/provenance, corpse terminal state, replay.

**Ручной demo:** одна сторона сдаётся, теряет оружие и позже обменивает пленного; после другого боя witnesses по-разному распространяют сведения о потерях.

**GO:** каждый участник и важный item получает явный aftermath; surrender определяется morale/risk/doctrine/reputation, не scripted mercy.

**STOP/REWORK:** inventory меняет владельца общей кнопкой; неизвестная смерть мгновенно известна всем; пленный продолжает обычный plan.

## I12D — Рейды, штурм базы и силовой захват территории

**Гипотеза:** организации способны автономно спланировать ограниченный конфликт за route/base, а контроль меняется только через физический outcome и снабжение.

**Scope:** raid/interdict/defend/evacuate objectives, reconnaissance, force assembly/provisioning, breach/withdraw/surrender outcomes, module damage, occupation/consolidation, relief attempt and isolated control decay.

**Автоматическая проверка:** depends on I09D/I12B/I12C; objective/target knowledge, no teleport force, attacker supply/ammo, base capacity, owner unchanged before outcome, item/person/module outcomes, deterministic retreat, control transition sequence.

**Ручной demo:** raid перехватывает shipment, затем организация пытается занять outpost; защита отступает, модуль повреждён, а новый owner закрепляется только после garrison и supply delivery.

**GO:** захват образует цепочку разведка → подготовка → столкновение → aftermath → occupation → supply → consolidation; не вся вражда приводит к total war.

**STOP/REWORK:** capture — один roll/event; война поглощает экономику; controller подбирает силы для драматического результата.

## I12E — Существа, охота и вытеснение

**Гипотеза:** оригинальные ecotypes создают разные признаки, риски и способы охоты, а не являются reskin человеческого боя.

**Scope:** минимум два ecotype: pack-territory и solitary-ambush; habitat, hunger, track/cue, stalking/avoid/flee/defend/attack, hunt/drive-off contract, trophy/resource sinks with original content.

**Автоматическая проверка:** habitat/reachability, cue provenance, distinct behavior distributions, pack membership, no human weapon logic reuse as behavior, population conservation, bounded encounter.

**Ручной demo:** patrol обходит территориальную стаю по следам; hunter выманивает одиночное засадное существо и возвращается с подтверждаемым contract outcome.

**GO:** ecotypes статистически различаются до и во время контакта; охота влияет на route safety/economy/population.

**STOP/REWORK:** существа спавнятся возле нужного агента; отличаются только HP/damage; trophy появляется без source event.

## I13A — Аномальные поля, признаки и detector scan

**Гипотеза:** локальные признаки и качество detector позволяют исследовать опасность без omniscient map marker.

**Scope:** 3 original field families, cells/slots/activity phases, visual/audio/environmental cues, enter/probe/scan/mark/avoid, detector uncertainty and knowledge claims.

**Автоматическая проверка:** geography/reachability, cue/claim provenance, no detector global truth, bounded scan error, field transitions replay, equipment power/condition.

**Ручной demo:** новичок видит только признаки и уходит; подготовленный исследователь сканирует поле и формирует локальную карту риска.

**GO:** знание поля изменяет route/expedition decisions; семейства требуют различимых способов наблюдения.

**STOP/REWORK:** поле — обычная damage zone; UI раскрывает cells без observations; detector гарантирует безопасность.

## I13B — Поиск, извлечение и свойства ценных находок

**Гипотеза:** опасное извлечение уникальной находки создаёт provenance, риск и экономическую ценность.

**Scope:** find slots, hidden/present/detected/claimed/extracted/lost/exported states, probe/approach/extract, container/tool requirements, original find property discovery, ownership/trade/research/export.

**Автоматическая проверка:** unique source event, one extraction, slot/field provenance, no text-created property, tool/knowledge preconditions, item conservation, bounded value.

**Ручной demo:** экспедиция обнаруживает, извлекает и продаёт находку; другой trader оценивает её иначе из-за локального спроса/неизвестных свойств.

**GO:** find проходит путь field → detection → extraction → ownership → use/trade/export и влияет на экономику.

**STOP/REWORK:** ценность фиксирована для всех; находка появляется в inventory; extraction не несёт риска/time cost.

## I13C — Территориальная буря и shelters

**Гипотеза:** предсказуемая по признакам, но опасная буря перестраивает планы и создаёт конкуренцию за ограниченные shelters.

**Scope:** calm/warning/front/impact/aftermath/recovery, forecast claims/channels, route hazard escalation, shelter capacity/access/protection, seek/admit/refuse/evacuate/shelter outcomes, module/agent/field consequences.

**Автоматическая проверка:** warning-before-impact, deterministic schedule, no impossible travel, shelter capacity/protection, outside consequences, radio failure/unknown warning, replay identity.

**Ручной demo:** предупреждение отменяет expedition; rival agents договариваются или спорят за shelter; потерявший radio получает только локальные признаки.

**GO:** буря влияет на планы до impact, имеет последствия после него и не является global damage pulse.

**STOP/REWORK:** все всегда знают точное время; shelter бесконечен; последствия выбираются для драматизма.

## I13D — Post-storm изменение полей и появление находок

**Гипотеза:** aftermath детерминированно обновляет поля и создаёт новые возможности, которые запускают экспедиции и конфликт.

**Scope:** field eligibility/capacity/cooldown, stable slot ordering, dedicated PRNG stream `storm:{storm_id}:field:{field_id}:slot:{slot_id}`, reseed/relocate/exhaust outcomes, spawn caps, source event/version provenance and discovery separation.

**Автоматическая проверка:** same snapshot/seed/rules/content = identical slots/items/IDs; no spawn before aftermath; capacity/cooldown; no duplicate slot/item; batch/restart/replay identity; spawned does not mean publicly known.

**Ручной demo:** сравнить два replay одной бури; после aftermath разные подготовленные стороны узнают о части изменений и начинают конкурирующие экспедиции.

**GO:** каждую новую находку можно трассировать к конкретной буре/полю/slot; spawn меняет contracts, цены и territory pressure.

**STOP/REWORK:** находки периодически возникают без причины; restart меняет spawn; UI раскрывает все новые слоты.

## I13E — Погода, экология и пополнение населения

**Гипотеза:** ограниченные глобальные controllers поддерживают изменчивость мира без спасения конкретных героев и организаций.

**Scope:** weather route/visibility/noise modifiers, habitat pressure/migration, capped resource recovery, newcomer entry/succession, population/economy controller interventions and cooldowns.

**Автоматическая проверка:** controller actions evented, global thresholds/caps/delays, no named target rescue, population/resources bounds, no clone replacement, modifier expiry, replay.

**Ручной demo:** погода меняет patrol; существа мигрируют из истощённого habitat; после долгого дефицита supply/newcomer появляется с внешней причиной и задержкой.

**GO:** пробный 7-дневный прогон не замирает и не маскирует bug rescue-механикой.

**STOP/REWORK:** controller спасает конкретную сторону; мир стабилен только за счёт скрытого создания ресурсов/людей.

## I14A — Observer UX: понять мир

**Гипотеза:** новый зритель за минуту понимает текущее событие и минимум одну причину.

**Scope:** location page, agent/organization/creature-anomaly cards, trader/shelter views, факт/signal/claim markers, «почему?», causal links, last seen sequence, mobile baseline, researcher mode protection.

**Автоматическая проверка:** API visibility contracts, inaccessible canonical fields, Playwright critical flows, accessibility checks.

**Ручной demo:** 5–8 человек без контекста выполняют blind-сценарий «что происходит / кто важен / почему».

**GO:** provisional thresholds: 80% за 60 секунд верно описывают происходящее, 70% восстанавливают две причины, 80% различают факт/signal/слух; неполнота воспринимается как информация, не баг.

**STOP/REWORK:** UI раскрывает omniscient truth или требует чтения debug log.

## I14B — Оригинальный visual/content vertical

**Гипотеза:** собственный визуальный язык и полный атмосферный набор делают мир узнаваемым без копирования IP GSC и без сокрытия причинности декором.

**Scope:** style tokens, original logo/wordmark, 36–48 SVG icons, organization emblems, modular portrait kit, 2 creature designs, 3 location key arts, scene backdrops/loops, 3 location ambience beds + radio/weather/camp cues, asset manifest/build pipeline, content fixtures всех опор [[12_VISUAL_AND_CONTENT_DESIGN]] §7.

**Автоматическая проверка:** asset provenance/license/checksum, SVG sanitization, responsive outputs, no hotlinks, contrast/a11y, marker visibility contracts, deterministic `appearance_seed`, content fixture coverage.

**Ручной demo:** 5 людей различают affiliation/role, fact/signal/claim, creature/anomaly/shelter/trader markers и risk states без легенды и без одного только цвета; content/IP review подтверждает оригинальность.

**GO:** все public assets имеют provenance; critical flow работает без декоративных images и sound; 5–7 locations (3 hero key arts + modular presentation остальных), 2 организации, независимые, малый research/logistics interest, 2 creature ecotype, trader/medic/guide/technician, 3 anomaly family, shelter/camp/radio и territory storm представлены оригинальными data/assets.

**STOP/REWORK:** визуал узнаваемо копирует GSC; чужой/неясный asset попал в build; атмосфера существует только в key art/codex и не связана с executable fixtures.

## I15A — Подсистемный баланс и ablation

**Гипотеза:** каждая крупная механика заметно влияет на решения, не захватывая всю симуляцию.

**Scope:** только instrumentation, controlled pairs, ablation, bug fixes и ruleset tuning; новые mechanics запрещены. Отдельные suites для экономики/снабжения, дипломатии/территории, combat, существ, полей/находок, бури/shelter и знаний/contracts. По измерениям I03–I14 до запуска I15B замораживаются provisional budgets CPU time, DB queries/IO, memory, event/snapshot growth, replay duration и worker/projection lag для 30–50 агентов.

**Автоматическая проверка:** 50 seed × 3 дня на suite; impact deltas для route/goal/trade/conflict/claim chains; concentration, scarcity, mortality, combat frequency, control churn, find rates, denied services, controller interventions.

**Ручной demo:** simulation analyst показывает случайный baseline и пары с одной отключённой системой; человек подтверждает различимое, но не катастрофическое влияние.

**GO:** ни одна заявленная core-механика не декоративна; provisional ranges откалиброваны с before/after evidence; hard invariants не ослаблены.

**STOP/REWORK:** одна система не меняет outcomes либо доминирует; баланс достигается скрытой режиссурой или ослаблением gate.

## I15B — Недельный интеграционный soak

**Гипотеза:** собранный мир устойчив и производит разные причинные истории без ручного вмешательства.

**Scope:** только integration instrumentation, reproducible bug fixes и подтверждённый tuning. Новые mechanics запрещены.

**Автоматическая проверка:** 100 seed × 7 дней, holdout/regression banks, replay samples, все invariants, distributions ресурсов/цен/смертности/целей/сцен/control churn, stuck detection, performance budget; coverage/impact report всех систем [[13_WORLD_SYSTEMS_SPEC]] и атмосферных опор [[12_VISUAL_AND_CONTENT_DESIGN]] §7.

**Ручной demo:** simulation analyst выбирает случайные, а не лучшие, 10 прогонов; человек просматривает минимум 5 и классифицирует скучные/сломанные/интересные периоды.

**GO:** минимум 3 типа долгосрочных causal stories, приемлемые ranges, reproducible failures, ни одного скрытого invariant breach; каждая core-система имеет executable fixture и хотя бы в части holdout seeds влияет на решения/causal chains, а не только на UI.

**STOP/REWORK:** истории находятся только cherry-picking; экономика/популяция схлопывается; бесконечная война/control ping-pong; большая часть времени пуста по одной причине.

## Gate D — готовность движка к завершению core prototype

До LLM фиксируется baseline rules/content version и отчёт:

- почему мир интересен без generated prose;
- где он скучен и какие механики реально отвечают за это;
- стоимость CPU/DB одного игрового дня;
- replay duration и snapshot size;
- перечень известных balance limitations;
- доказательство цепочек supply → цена → contract, storm → field change → find → expedition, raid → battle aftermath → occupation → consolidation;
- отчёт по combat frequency/mortality, control churn, base viability, diplomacy diversity, find economy и controller interventions;
- asset provenance/IP audit и coverage report атмосферных опор из [[12_VISUAL_AND_CONTENT_DESIGN]] §7.

Если связной истории без LLM нет, I16–I17 запрещены до исправления симуляции. Gate D не разрешает подключать генеративный ИИ: сначала основной прототип должен пройти template-only проверку людей на Gate E.

# Milestone E — основной template-only прототип

## I16 — Летопись, causal stories и легенды

**Гипотеза:** историю мира можно исследовать после события, а социальная известность возникает из распространения фактов/слухов без генеративной модели.

**Scope:** causal clustering, deterministic daily summary, archive/search, past map baseline, truth/social legend scores, permalinks, template renderer.

**Автоматическая проверка:** каждое factual предложение имеет sources, cluster rules стабильны, false legend divergence сохраняется, projections rebuild детерминирован, unknown facts не публикуются.

**Ручной demo:** от live signal пройти к персонажу, прошлому событию, causal cluster и расхождению слуха с правдой.

**GO:** человек восстанавливает историю без researcher mode; легенда объяснима исходными событиями и распространением; в dependency graph нет narrative/provider SDK.

**STOP/REWORK:** летописец объединяет несвязанные события ради драматургии; legend score назначает героя заранее; template text становится источником фактов.

## I17 — Template-only закрытая проверка и prototype review

**Гипотеза:** люди возвращаются к миру и пересказывают возникшие истории без генеративного текста и подсказки автора.

**Scope:** deployment hardening, versioned threat model и ASVS applicability matrix, least-privilege DB/network roles, backups/PITR drill, onboarding, permission/auth для researcher/admin mode, SLI/SLO + RPO/RTO + alerts/runbooks, release SBOM/provenance, migration compatibility/rollback exercise, privacy/retention закрытой проверки, cost dashboard core infrastructure и bug fixes. Новые core mechanics заморожены; LLM SDK/keys/prompts запрещены.

**Автоматическая проверка:** full CI/nightly/release gate; restore из backup/PITR в изолированную среду укладывается в принятые RPO/RTO и подтверждает checksum/replay; load baseline включает bounded abusive requests и slow SSE clients; permission/auth/DB-role negative checks; current/previous migration compatibility и worker graceful drain; secret/dependency/license/SAST/container/IaC gates; SBOM/checksum/provenance verification; template groundedness и dependency audit на отсутствие LLM SDK/network calls из representation.

**Ручное наблюдение:** минимум 2 недели; до набора участников заморожены sampling/consent/exclusion/analysis plan и минимально достаточный размер выборки; короткие интервью; возвращаемость к персонажам/локациям; понимание причинности; скучные периоды; стоимость дня мира. Отдельно проводится tabletop incident: credential compromise или stuck worker → alert → runbook → recovery без ручного редактирования canonical history.

**GO:** сформирован core prototype report и concept deck для обращения в GSC либо план перехода на собственный IP; security/operations exceptions не имеют просроченного owner/expiry, release/restore/incident evidence воспроизводимы; зафиксировано отдельное решение, нужен ли I18.

**STOP/REWORK:** зрители не видят причинность без красивых реплик; мир требует ежедневного ручного спасения; стоимость core-инфраструктуры неприемлема.

## Gate E — основной прототип завершён

Gate E требует:

- выполненные Gate A–D и I16–I17;
- template-only build проходит acceptance, replay, soak и restore;
- threat model, least-privilege access, migration compatibility, verified SBOM/provenance, принятые SLO/RPO/RTO и incident/restore exercises прошли I17;
- минимум 70% участников закрытой проверки восстанавливают две причины выбранного события;
- минимум три истории из holdout-прогонов пересказаны без researcher mode;
- LLM/provider dependencies отсутствуют в core build;
- опубликован core prototype report с известными ограничениями и решением **GO/REWORK/STOP**.

Только решение **GO** разрешает I18. Решение начать I18 не автоматическое: template-only продукт может остаться финальным вариантом.

# Milestone F — опциональный narrative experiment

## I18 — Narrative gateway и grounded LLM

**Гипотеза:** LLM измеримо улучшает подачу готового мира, не меняя факты, доступность и надёжность core prototype.

**Scope:** отдельный optional package, provider port, prompt/version registry, structured output, validator, cache/budget/moderation, template fallback, 2–3 значимых representation types, kill switch.

**Автоматическая проверка:** unknown facts rejected, unavailable knowledge rejected, timeout/failure no canonical effect, package removal test, cache/idempotency, versioned eval set, LLM on/off identity для event/snapshot/claim/signal/cluster IDs.

**Ручной demo:** вслепую сравнить сохранённые template и LLM representations одного набора событий; во время live run выключить provider и затем удалить optional package из build.

**GO:** groundedness blocking facts = 100%; отключение/удаление модели незаметно для simulation health; слепое сравнение показывает заранее установленное улучшение; стоимость и moderation приемлемы.

**STOP/REMOVE:** validator пропускает выдуманные сущности/знания; model output нужен для canonical решения; зависимость протекла в core; LLM не превосходит templates. При STOP продукт остаётся template-only.

## 6. Что запрещено между итерациями

- начинать следующий slice при REWORK/STOP предыдущего;
- одновременно разрабатывать несколько mechanics, меняющих одни события/state;
- добавлять LLM, embeddings, provider SDK/keys/prompts или runtime generation до Gate E;
- улучшать UI вместо исправления неверной canonical логики;
- обновлять golden artifacts без causal explanation;
- ослаблять invariant/coverage gate ради deadline;
- объединять worktree, если handoff не содержит test commands/output;
- разрешать implementer-у быть единственным reviewer-ом;
- вносить «заодно» refactor вне owned scope;
- менять rules и оценивать их успешность одним и тем же agent turn без независимого анализа.

## 7. Сквозной validation protocol

Каждый milestone проверяется строго в трёх слоях:

1. **Canonical simulation** — raw state/events/decision traces без UI и генеративного ИИ.
2. **Observer projection** — facts/signals/claims с детерминированными labels.
3. **Presentation** — интерфейс и template-only текст; LLM добавляется только в опциональной I18.

Провал первого слоя нельзя закрыть изменением второго или третьего. В I18 при LLM on/off canonical event log, snapshot checksum, claims, causal clusters и observer signal IDs обязаны совпадать; различаться могут только representations.

### Sensitivity и ablation

На Gate B–D simulation analyst сравнивает контролируемые пары и прогоны с отключённой механикой:

- traits on/off;
- relationships on/off;
- knowledge/communication on/off;
- obligations on/off;
- low/high scarcity;
- low/high danger;
- organization doctrines/territory goals on/off;
- persistent trader/supply routes on/off;
- distinct creature ecotypes vs generic threat;
- anomaly fields/finds on/off;
- territory storm/shelter capacity on/off;
- local radio/camp information channels on/off;
- EcologyController on/off.

Если отключение заявленной ключевой механики почти не меняет маршруты, помощь, торговлю, конфликты или causal chains, механика декоративна и следующий milestone блокируется.

### Boredom/degeneracy audit

Начиная с I05 raw logs анализируются без имён и художественного текста:

- entropy goal/action types;
- top повторяющихся action motifs;
- idle/stuck duration;
- доля system pulses среди meaningful events;
- концентрация значимых событий по агентам и локациям;
- доля агентов, чьё состояние заметно изменилось за сутки;
- глубина и разнообразие causal chains.

Стартовые guardrails до калибровки:

- один non-system action type — не более 60% meaningful actions;
- технически stuck/idle более 12 игровых часов — не более 5% живых агентов;
- один агент — не более 25% значимых событий мира без явной структурной причины;
- широкий ожидаемый диапазон — 0.5–6 meaningful events на agent-day и 5–30 потенциально публикуемых событий на world-day.

Это диагностические диапазоны, а не цель режиссуры. Выход требует изучения причины; controller не имеет права искусственно подгонять события под числа.

### Единые hard stop conditions

Любой milestone блокируется, если:

- нарушен hard invariant или replay недетерминирован;
- успех показан только на выбранном после просмотра seed;
- gate flaky или невоспроизводим;
- более 20% агентов находятся в одном stuck/повторяющемся режиме;
- заявленная механика не проходит sensitivity/ablation test;
- баланс держится на скрытом адресном вмешательстве controller-а;
- raw causal chain отсутствует, но выглядит убедительно после UI/LLM;
- acceptance/golden/threshold был ослаблен без отдельного decision record.

## 8. Вопросы, которые не блокируют I00

До соответствующей итерации можно отложить:

- конкретного LLM provider/model — до решения GO на Gate E и старта I18;
- production hosting — до I17, пока достаточно Docker Compose;
- Redis/S3 — только после измерения; pgvector дополнительно запрещён до Gate E;
- финальные названия, лор и ассеты — отдельный IP/content поток;
- точные balance thresholds — они выводятся из I04–I15B и versioned rulesets.

Перед I14A потребуется выбрать 3–5 людей для короткой usability-проверки. Перед I14B — утвердить asset provenance manifest и привлечь автора/художника для проверки оригинальности. Перед I17 потребуется решение о площадке template-only закрытой проверки и доступе тестировщиков. Перед I18 требуется отдельное письменное решение о пользе, бюджете и допустимых данных для внешнего provider-а.
