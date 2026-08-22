# Requirements traceability

Статус: normative baseline до появления executable repository  
Дата: 2026-08-20

Этот документ связывает продуктовую идею с механикой, реализацией и проверкой. Он не заменяет подробные specs. Если требование меняется, в одном change должны быть обновлены его источник, строка этой таблицы, acceptance criteria и затронутый ADR/contract.

## 1. Определение результата

**Основной прототип** — автономный template-only мир, прошедший Gate E в [[10_ITERATION_MASTER_PLAN]]. Он не содержит runtime LLM dependencies и доказывает причинность без generated prose.

**Опциональный narrative experiment** — I18 после отдельного решения GO. Он может улучшать только representation и не входит в определение готовности основного прототипа.

## 2. Трассировка требований основного прототипа

| ID | Проверяемое требование | Нормативный источник | Реализация / контракт | Acceptance / gate |
|---|---|---|---|---|
| PR-01 | Зритель наблюдает и не отправляет команды каноническому миру | [[01_PRODUCT_DESIGN]] §1–2 | read-only `/v1/*`; admin API изолирован | I03, I14A; public contract не содержит write routes |
| PR-02 | За 60 секунд зритель понимает, что происходит, и называет причину | [[01_PRODUCT_DESIGN]] §2, §9 | map/feed, causal links, «почему?» | I14A usability: 80% понимают событие, 70% находят две причины |
| PR-03 | Fact, signal, claim и interpretation визуально/семантически различимы | [[01_PRODUCT_DESIGN]] §8; ADR-005 | observer signal и representation contracts | I10A, I14A; visibility contract + blind task |
| PR-04 | Мир существует и меняется без открытого браузера | [[01_PRODUCT_DESIGN]] §1, §4 | worker, scheduler, PostgreSQL event log | I02B — **выполнено частично** (уточнено M8): путь, начатый командой, доводится до конца БЕЗ участия браузера и без памяти процесса — завершение делает свежий процесс, читающий только то, что предыдущий закоммитил (C7, настоящие `spawnSync`), мировое время двигают события (C2). Но мир пока НЕ идёт сам: `apps/worker` остаётся скелетом I00 с `step` — честным no-op, а расписание разбирает `world tick`, который запускает оператор. «Без открытого браузера» доказано, «непрерывно» — нет. Остаётся: перенос `runWorldTick` в цикл worker-а; I15B: 7-day soak |
| PR-05 | Историю можно исследовать по времени, людям, местам и причинам | [[01_PRODUCT_DESIGN]] §2 | projections, archive/search, causal clusters, permalinks | I16; rebuild + ручной путь от signal к источникам |
| SIM-01 | Одинаковые snapshot, seed, immutable rules/content/schema bundles и runtime profile дают одинаковый canonical результат | [[07_MVP_MECHANICS_SPEC]] §7, §21 | injected Clock/PRNG/IdFactory; fixed units/rounding; canonical serialization; bundle checksums | I01 — **выполнено частично**: A1 (100 процессов × 4 seed по пути CLI), A11 (та же схема для цепочки decide→evolve), A3 (TZ=Pacific/Chatham, LC_ALL=tr_TR.UTF-8), counter-based PRNG без пересечения потоков, checksum над воспроизводимым содержимым. I02A: канонический результат не зависит от прохода через БД — checksum состояния из базы совпадает с in-memory прогоном той же команды, И `event_id` из журнала совпадает с id независимого in-memory прогона (B8). `event_checksum`, снятый до записи, делает точность round-trip через `jsonb` проверяемой. Уровень изоляции транзакции задан явно и входит в наблюдаемую семантику отказа. I02B: replay на durable-журнале доказан (C9/C10 — состояние и checksum сверяются с непрерывным прогоном, расхождение даёт ненулевой exit); позиции PRNG стали колонкой `worlds` и двигаются в транзакции команды (M4). Остаётся: resimulation regression bank и compatibility suite профиля (§7) |
| SIM-02 | 30–50 агентов автономно проживают 7 игровых дней | [[07_MVP_MECHANICS_SPEC]] §1–2 | staged scale 1–5 → 10 → 20 → 30–50 | I15B; 100 seed × 7 дней и Gate D |
| SIM-03 | Потребности, риск, ресурсы и черты меняют выбор цели | [[07_MVP_MECHANICS_SPEC]] §5–9 | Utility AI, hysteresis, short plans | I04–I06; decision trace + sensitivity/ablation |
| SIM-04 | Помощь, долг, нормы и отношения влияют на будущие решения | [[07_MVP_MECHANICS_SPEC]] §10–11 | directed relationships, obligations, witnessed outcomes | I07, I09A–I09B; causal chain и holdout scenarios |
| SIM-05 | Знание не появляется без provenance; пересказы одного корня не независимы | [[07_MVP_MECHANICS_SPEC]] §12, §21 | knowledge claims и source graph | I10A; property/replay tests, violations = 0 |
| SIM-06 | Сцены конечны, локальны и не создают невозможных участников/ресурсов | [[07_MVP_MECHANICS_SPEC]] §13–14 | bounded state machines, preconditions | I11A–I11B, I12B–I12C; bounded transitions/property tests |
| SIM-07 | Смерть окончательна; loot и уникальные предметы не дублируются | [[07_MVP_MECHANICS_SPEC]] §14, §16, §21 | terminal state, atomic inventory transfer | I12B–I12C; model/property tests |
| SIM-08 | EcologyController не спасает выбранного героя и фиксирует вмешательства событиями | [[07_MVP_MECHANICS_SPEC]] §15–16 | global rules, sources/sinks, interventions log | I13E–I15B; ablation, distribution и audit |
| SYS-01 | База и территория меняют владельца только через присутствие, исход конфликта/withdrawal, occupation, снабжение и consolidation | [[13_WORLD_SYSTEMS_SPEC]] §2, §4 | territory claims, base modules, control transitions, supply connectivity | I09C–I09D, I12D; sequence/property tests + capture demo |
| SYS-02 | Экономика сохраняет физические sources/sinks; trader и service не создают товар/лечение/ремонт из текста | [[13_WORLD_SYSTEMS_SPEC]] §6 | inventory ledger, shipments, venues/services, bounded prices | I08A–I08C, I15A; conservation + scarcity/supply ablation |
| SYS-03 | Diplomacy, contracts, patrols и экспедиции возникают из известных потребностей и событий | [[13_WORLD_SYSTEMS_SPEC]] §3, §5 | diplomacy evidence, contract state, patrol/expedition schedules | I09B, I10B–I10C; provenance/replay + causal demos |
| SYS-04 | Снаряжение, боеприпасы, защита, перестрелка, сдача, плен и loot имеют конечные физические outcomes | [[13_WORLD_SYSTEMS_SPEC]] §7, §9 | equipment/items, combat scene, custody and aftermath events | I12A–I12C; conservation, bounded combat, terminal-state tests |
| SYS-05 | Поля исследуются локально; находки извлекаются с provenance; новые slots/items появляются только в aftermath конкретной бури | [[13_WORLD_SYSTEMS_SPEC]] §8, §11 | hazard fields, find slots/provenance, dedicated storm PRNG streams | I13A–I13D; replay/resimulation identity + storm loop demo |
| SYS-06 | Оригинальные существа, охота, погода, миграция и population recovery меняют мир без hidden director | [[13_WORLD_SYSTEMS_SPEC]] §10, §12–15 | ecotypes/habitats, controllers, interventions log | I12E, I13E, I15A–I15B; distinct distributions + controller audit |
| NAR-01 | Scene outcome и передача claims завершаются до построения текста | [[07_MVP_MECHANICS_SPEC]] §18 | committed event/claim → representation job | I11B; renderer removal не меняет snapshot |
| NAR-02 | Основной прототип использует только deterministic templates | ADR-006; [[10_ITERATION_MASTER_PLAN]] Gate E | `packages/representation`, без network/provider SDK | I11B, I16, I17; dependency/network audit |
| NAR-03 | Каждое фактическое предложение летописи имеет event/claim sources | [[07_MVP_MECHANICS_SPEC]] §19 | machine causal cluster + validated template | I16; blocking groundedness = 100% |
| OPS-01 | Crash/restart не теряет и не дублирует canonical работу | [[03_TECHNICAL_DESIGN]] §3–5 | transaction event/state/outbox; leases; snapshots | I02A — одна транзакция event/state/outbox/command result, инъекция сбоя после каждого шага записи (B5), идемпотентность по `command_id` включая устаревшую версию (B3), конкурентные команды без дыр в `sequence` (B6), состояние переживает перезапуск процесса (B9). I02B — конкурентные worker-ы через `SKIP LOCKED` без дублей и дыр (C5), стабильный порядок при равном `due_at` (C4), монотонность мирового времени (C12), снимок плюс суффикс журнала равен непрерывному прогону и `world replay` возвращает ненулевой код при расхождении (C9/C10). **Уточнено M8:** перехват аренды (C6) доказан на ИСТЁКШЕЙ аренде, а не на умершем процессе — смерть worker-а посреди действия моделируется временем, а не убийством процесса; отвергнутое действие получает конечный исход и не возвращается в очередь (миграция 0008). Остаётся: убийство настоящего процесса под нагрузкой; I15B soak |
| OPS-02 | Public UI не читает canonical tables и восстанавливается без SSE history | [[03_TECHNICAL_DESIGN]] §7, §9 | read models, snapshot endpoint, resumable SSE | I03; contract/E2E tests |
| OPS-03 | Observer/admin/worker/migration и CI/release границы имеют deny-by-default, least privilege и проверяемый software supply chain | [[03_TECHNICAL_DESIGN]] §11–12; ADR-008 | threat model, DB/network roles, ASVS applicability, scans, SBOM/checksum/provenance | I00 skeleton; I02A — разделение ролей исполнено В РАБОТАЮЩЕМ ПУТИ: рантайм ходит под `zona_worker`, observer API под `zona_api`, миграции под отдельным `MIGRATION_DATABASE_URL` (`docker-compose.yml`); канонический путь `init → run → read` проверен под `zona_worker` с `rolsuper=false`/`rolbypassrls=false`, `update`/`delete` на `world_events` отвергаются правами, фактические гранты сверяются со всей матрицей `GRANT_MATRIX`, а не со списком таблиц. Секреты: паттерны `password`/credential-URL добавлены в secret scan и проверены пробой. I17 release gate |
| OPS-04 | Canonical history восстанавливается после deploy/migration/incident в принятые RPO/RTO без ручного переписывания событий | [[03_TECHNICAL_DESIGN]] §12; ADR-008 | expand/migrate/contract, compatible app rollback, PITR, graceful drain, alerts/runbooks | I02B foundation, I17; migration/restore/incident exercises + checksum/replay evidence |
| OPS-05 | Мир на 30–50 агентов и observer traffic работают в измеренных capacity budgets с диагностируемым headroom | [[03_TECHNICAL_DESIGN]] §10, §12 | telemetry, CPU/DB/storage budgets, load profiles, slow-client protection | I15A–I15B, I17; frozen budgets, soak/load report и alert thresholds |
| ~~DEV-01~~ | **Снято 2026-08-21 (ADR-009).** Автопродолжение через пятичасовое usage window не является требованием проекта: адаптеров telemetry/wake/resume нет, `capability-check` отвечал `LIMIT_AUTOCONTINUE_UNAVAILABLE`. Пауза обрабатывается внешним runner-ом и человеком; репозиторий автопродолжения не обещает | ADR-009 | — | — (требование снято) |
| DEV-02 | Critical agent restrictions исполняются вне model instructions | [[08_TDD_AND_AGENT_WORKFLOW]] §8–9; ADR-008 | permissions, sandbox, hooks, protected write sets, lint/import rules и CI | I00; allowed/denied fixtures + clean-session adversarial demo |
| IP-01 | До письменного разрешения нет публикации как S.T.A.L.K.E.R.-проекта и чужих ассетов | [[04_IP_AND_RESEARCH]] §1 | neutral/original content manifest | Этап 0 и pre-alpha content audit |
| VIS-01 | Каждый public asset оригинален либо имеет совместимую лицензию и provenance | [[12_VISUAL_AND_CONTENT_DESIGN]] §5–6 | asset manifest, checksum, CI license gate | I14B; неизвестный source блокирует build |
| VIS-02 | Карта, affiliations, roles, facts/signals/claims и risks различимы без одного только цвета | [[12_VISUAL_AND_CONTENT_DESIGN]] §2–4 | SVG system, tokens, portrait/location assets | I14B; blind recognition + contrast/a11y tests |
| ATM-01 | Организации, traders, guides, medics, technicians и independents отличаются поведением, а не только названием | [[07_MVP_MECHANICS_SPEC]] §9–10; [[12_VISUAL_AND_CONTENT_DESIGN]] §7–8 | doctrine/roles, finite inventory, bounded services, territory/radio policies | I08A–I11B, I15A; fixture + impact/ablation report |
| ATM-02 | Оригинальные creatures, anomaly fields/finds и territory storm влияют на маршруты, экономику и выживание | [[07_MVP_MECHANICS_SPEC]] §15; [[12_VISUAL_AND_CONTENT_DESIGN]] §7–8 | ecotypes, hazards, provenance items, shelter goals | I12E–I13E, I15A–I15B; distinct distributions + causal chains |
| ATM-03 | Экспедиции, shelters, camps, radio, rumors, scarcity и loss создают локальную атмосферу | [[12_VISUAL_AND_CONTENT_DESIGN]] §7 | plans/scenes/channels/resources/events | I10A–I13E, I15B; coverage report без scripted sequence |

## 3. Ограничения опциональной I18

| ID | Требование | Автоматическое доказательство | Решение |
|---|---|---|---|
| LLM-01 | LLM меняет только representation | LLM on/off identity для events, snapshot, claims, signals, causal clusters и IDs | Любое расхождение = STOP/REMOVE |
| LLM-02 | Optional package физически удаляем | build/test без package и provider config | Ошибка core build = STOP/REMOVE |
| LLM-03 | Неизвестные/недоступные факты не публикуются | versioned eval + blocking validator | Groundedness blocking facts < 100% = STOP/REMOVE |
| LLM-04 | Есть измеримая польза сверх templates | заранее зафиксированное blind comparison | Нет улучшения = оставить template-only продукт |
| LLM-05 | Цена, данные и moderation приемлемы | budget cap, redacted logs, kill switch, cost report | Нарушение лимита/политики = disable/remove |

## 4. Матрица gates

| Gate | Что считается доказанным | Что ещё запрещено |
|---|---|---|
| A | deterministic end-to-end journey, persistence, projection, UI | новые социальные механики при нестабильном фундаменте |
| B | автономное выживание и первая причинная социальная цепочка | усложнение social world, если базовый выбор не работает |
| C | экономика, организации, базы, contracts, patrols, territory influence, claims и template scenes создают истории | боевой/экологический масштаб при сломанной причинности |
| D | полный опасный мир устойчив 7 дней: бой/захват, существа, поля, буря/post-storm spawn и observer UX | runtime LLM; сначала архив и template-only проверка |
| E | основной прототип и закрытая проверка завершены без генеративного ИИ | I18 без отдельного решения GO |
| F/I18 | LLM доказал пользу как optional renderer либо удалён | влияние модели на canonical/knowledge/signal слои |

## 5. Открытые решения с дедлайном

Открытый вопрос не должен тихо превращаться в код. До указанной точки нужен ADR, content decision или iteration report.

| Вопрос | Не блокирует | Решить до |
|---|---|---|
| Финальное собственное IP или разрешённый фан-проект | I00–I16 при нейтральном контенте | внешней публикации / набора закрытой альфы |
| Конкретные названия, лор и финальные visual assets | headless domain mechanics | I14B visual/content vertical |
| Production hosting и площадка закрытой проверки | локальный Docker Compose | I17 |
| Identity provider, admin roles и session policy | headless/local development | до начала I17 hardening |
| SLO, RPO/RTO, alert owners и retention тестировщиков | I00–I16 с provisional telemetry | до набора участников I17 |
| Hosted release builder, signing/provenance mechanism и vulnerability patch SLA | локальные artifacts | до первого внешнего deployment в I17 |
| Performance/capacity budgets для 30–50 агентов | функциональную разработку I00–I14 | конец I15A, до I15B |
| Sampling/consent/exclusion/analysis plan и достаточный размер I17 проверки | I00–I16 | до набора участников I17 |
| Нужен ли вообще runtime LLM | весь основной прототип | после отчёта Gate E |
| LLM provider/model, бюджет и допустимые данные | I00–I17 | старт I18 |
| Redis, S3, Temporal | основной прототип | только после измеренного bottleneck и отдельного ADR |
| pgvector/embeddings | весь основной прототип | после Gate E, измеренного ограничения поиска и отдельного ADR |

## 6. Change protocol

1. Изменение начинается с observable behavior и ID требования.
2. Обновляются нормативный design/spec и при необходимости ADR.
3. До кода замораживаются command/event/API contracts и acceptance test.
4. Реализация проходит Red → Green → Refactor, invariant/replay checks и ручной demo.
5. В iteration report указываются затронутые requirement IDs и доказательства.
6. Новое требование без строки трассировки не считается принятым scope.
