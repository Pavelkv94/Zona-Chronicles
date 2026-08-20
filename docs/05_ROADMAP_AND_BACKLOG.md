# Roadmap и backlog

Статус: derived overview; нормативный порядок находится в [[10_ITERATION_MASTER_PLAN]]  
Дата: 2026-08-20

Этот файл — укрупнённый обзор фаз и backlog. Обязательный рабочий порядок, размеры итераций, demo и stop/go gates определены в [[10_ITERATION_MASTER_PLAN]]. При расхождении приоритет имеет master-plan.

## Этап 0. Режим прототипирования и рамки — 1 неделя

Результат:

- выбран текущий маршрут: закрытый некоммерческий пет-проект до готовности прототипа, затем письменный запрос в GSC;
- сформулированы название, возрастной тон и границы контента;
- зафиксирован оригинальный visual/content baseline и правила asset provenance из [[12_VISUAL_AND_CONTENT_DESIGN]];
- определён игровой масштаб времени;
- зафиксированы 3 стартовые локации и 8–12 типов событий.

Стоп-условие: до письменного разрешения GSC не публиковать и не распространять прототип как проект по вселенной S.T.A.L.K.E.R. и не включать в него чужие карты, музыку, текстуры, модели или тексты. Для прототипа использовать оригинальные или нейтральные временные материалы.

## Этап 1. Headless world — 2–4 недели

Без frontend и без LLM:

- Node.js/TypeScript pnpm monorepo и package boundaries;
- Vitest, fast-check, Testcontainers и быстрый CI gate;
- WorldClock, event log, snapshot/replay;
- граф из 3 локаций;
- сначала 1–5, затем 10 агентов с потребностями и чертами; масштаб 30–50 включается только после доказательства механик;
- перемещение, отдых, еда, лечение;
- простые опасности и смерть;
- CLI-отчёт о событиях.

Работа идёт vertical slices в порядке: repository/agent harness → deterministic kernel → atomic journey → scheduler/replay → debug observer → needs/Utility AI → help/obligation. Готово, когда одинаковый seed/rules version даёт одинаковый log, restart восстанавливает мир, а 10 агентов автономно проходят 24 игровых часа без нарушения инвариантов. Полный 7-дневный масштаб 30–50 агентов проверяется позднее в I15B.

## Этап 2. Социальная инфраструктура — 5–8 недель

- sources/sinks, barter, traders, физические поставки и bounded services;
- организации, membership, нормы, репутация и diplomacy/truce;
- снабжаемые базы, modules, outposts и checkpoints;
- influence и мирная смена контроля территории;
- знания, свидетели, слухи и локальное радио;
- contracts, patrols и экспедиционная логистика;
- универсальное ядро сцен и template-only социальная подача;
- автоматические тесты цепочек.

Готово на Gate C, когда экономика, инфраструктура и отношения создают несколько причинных цепочек без заранее написанного sequence, а контроль территории требует присутствия, снабжения и времени. Подробное дробление: I08A–I11B в [[10_ITERATION_MASTER_PLAN]].

## Этап 3. Опасный системный мир — 6–9 недель

Механики вводятся отдельными короткими slices, а не одной боевой/экологической итерацией:

- экипировка, оружие, защита, боеприпасы и detectors;
- перестрелки, ранения, сдача, плен, loot и aftermath;
- рейды, защита баз и силовой захват территории с occupation/consolidation;
- оригинальные существа, следы, охота и вытеснение;
- аномальные поля, поиск и извлечение ценных находок;
- предупреждение, shelters и последствия территориальной бури;
- детерминированный post-storm spawn находок с provenance;
- погода, миграция, population/economy controllers;

Готово, когда отдельные combat/territory/creature/field/storm петли из [[13_WORLD_SYSTEMS_SPEC]] проходят собственные acceptance и replay tests. Это I12A–I13E; общий баланс и Gate D проверяются только после observer/visual vertical.

## Этап 4. Observer UI и интеграционная стабилизация — 4–7 недель

Тонкий researcher/debug observer появляется уже в I03, чтобы проверить end-to-end архитектуру. На этом этапе он превращается в продуктовый observer UI:

- Next.js shell;
- карта MapLibre;
- snapshot API и SSE;
- лента «сейчас»;
- экран локации;
- карточка агента;
- переходы по event links;
- оригинальный logo/wordmark, SVG icon system, organization/creature/location assets и asset manifest pipeline;
- адаптивный mobile layout.
- controlled-pair ablation каждой крупной механики;
- 100 seed × 7-day soak, replay sampling и общий balance/impact report.

Готово на Gate D, когда новый человек за 60 секунд понимает текущее состояние мира и может объяснить причину одного события, visual/content vertical проходит I14B, а I15A–I15B доказывают устойчивость и влияние всех core-систем. Все public assets оригинальны/лицензированы, имеют provenance и отображают executable systems, а не декоративный лор.

## Этап 5. Летопись и архив без генеративного ИИ — 2–4 недели

- шаблонные бытовые реплики;
- детерминированная дневная сводка;
- причинные кластеры и ссылки на источники;
- scoring и социальное распространение славы;
- карта прошлого, поиск, фильтры и permalinks;
- fact/signal/claim validation для всех representation.

Готово, когда зритель восстанавливает историю без researcher mode, а каждое фактическое утверждение трассируется до события или claim. В сборке нет LLM SDK, ключей и runtime-вызовов.

## Этап 6. Template-only закрытая проверка — минимум 2 недели наблюдения

Не добавлять новые механики каждый день. Смотреть:

- к кому привязываются зрители;
- понимают ли они причинность;
- какие периоды скучны;
- повторяется ли речь;
- какие агенты застревают;
- не схлопывается ли экономика;
- сколько стоит один день мира;
- какие истории люди пересказывают без подсказки.

Готово, когда выпущен core prototype report, причинность понятна без художественной генерации, а решение Gate E — GO. Это завершение основного прототипа.

## Этап 7. Опциональный LLM-эксперимент — 1–2 недели

Только после Gate E:

- отдельный narrative package без обратных зависимостей из core;
- provider adapter, prompt registry, budget/cache/moderation;
- LLM для 2–3 значимых типов representation;
- слепое сравнение LLM и сохранённых template outputs на одинаковых входах;
- аварийное удаление/отключение optional package без миграции core state.

Эксперимент сохраняется, только если groundedness blocking facts = 100%, LLM заметно улучшает понимание/выразительность и цена приемлема. Иначе продукт остаётся template-only.

## Приоритетный backlog

### P0

- [x] Зафиксировать режим IP: закрытый пет-проект → прототип → письменный запрос в GSC.
- [ ] Определить перечень элементов прототипа, зависящих от IP GSC, и нейтральные замены для них.
- [x] Выбрать единый Node.js/TypeScript стек и границы архитектуры.
- [x] Зафиксировать базовые механики MVP.
- [x] Зафиксировать TDD и AI-assisted multi-agent workflow.
- [x] Зафиксировать различие между Utility AI, runtime LLM и coding agents.
- [x] Зафиксировать original visual/content direction, atmospheric pillars и asset provenance.
- [ ] Создать одностраничную product vision для будущего concept deck.
- [ ] Создать code repository и executable skeleton.
- [ ] Реализовать tested permissions/sandbox/hooks для protected paths, write sets, network/dependency install и secret access; критичные правила не оставлять только в `CLAUDE.md`.
- [ ] Добавить frozen install, secret/dependency/license/static scans и versioned exception format с owner/expiry.
- [ ] Реализовать и dry-run проверить persisted Claude usage checkpoint + automatic wake/resume при остатке пятичасового окна `<= 1%`.
- [x] Draft v1 схем команд, `world_event`, scheduler и observer signals.
- [ ] Перенести draft contracts в исполняемые TypeBox schemas и SQL migrations.
- [ ] Десять инвариантов как executable tests.
- [ ] Headless deterministic loop.
- [ ] Snapshot/replay.
- [ ] Три локации и маршруты.
- [ ] Нужды, цели и Utility AI.
- [ ] Смерть и пополнение населения.
- [ ] Минимальная карта и event feed.
- [ ] Создать content manifest skeleton и placeholder-only asset pipeline.

### P1

- [ ] Sources/sinks, локальная стоимость, traders и физические supply routes.
- [ ] Организации, reputation, diplomacy/truce и различимые doctrine.
- [ ] Снабжаемые bases/modules, outposts, checkpoints и territory influence.
- [ ] Контракты, patrols и expedition lifecycle.
- [ ] Экипировка, оружие/ammunition, защита и detectors.
- [ ] Перестрелки, surrender/custody, loot и aftermath.
- [ ] Рейды, защита базы, occupation и consolidation территории.
- [ ] Два оригинальных creature ecotype, следы, охота и миграция.
- [ ] Три anomaly field family, extraction lifecycle и provenance ценных находок.
- [ ] Territory storm, shelters и детерминированный post-storm spawn.
- [ ] Отношения и обязательства.
- [ ] Наблюдения, знания, слухи.
- [ ] Сцены разговора и торговли.
- [ ] Причинные рёбра событий.
- [ ] Карточка агента.
- [ ] Летопись дня.
- [ ] Fact/signal/claim validation для template representations.
- [ ] Оригинальные logo/wordmark, 36–48 SVG icons и style tokens.
- [ ] Modular portrait kit, 2 creature designs и 3 location key arts с provenance.
- [ ] 3 оригинальных location ambience beds и radio/weather/camp cues с provenance.
- [ ] Executable content fixtures для organizations/traders/guides/medics/technicians, anomaly fields/finds, shelters/storm, camps/radio/expeditions.
- [ ] 24-hour, подсистемные ablation и 100 seed × 7-day soak tests.
- [ ] До I17: threat model + ASVS applicability, least-privilege DB/network roles, SBOM/build provenance, migration compatibility, SLO/RPO/RTO, PITR restore и incident tabletop.

### P2

- [ ] Автоматические сюжетные кластеры.
- [ ] Карта прошлого.
- [ ] Легенды и ложные легенды.
- [ ] Подписки и «с прошлого визита».

### Не сейчас

- [ ] 3D-клиент.
- [ ] Управление миром зрителями.
- [ ] TTS каждой реплики.
- [ ] Собственное обучение больших моделей.
- [ ] Семантическая память/pgvector.
- [ ] Микросервисы/Kubernetes/Kafka.
- [ ] Runtime LLM, embeddings и provider integration — только после Gate E/I18.

## Первые 12 семейств событий

1. Агент начал/закончил путь или экспедицию.
2. Замечены признаки аномального поля; изменилось состояние поля/маршрута.
3. Обнаружены следы существа; встреча принята/избежана.
4. Получена рана; оказана/отказана помощь.
5. Оригинальная valuable find извлечена, передана или потеряна.
6. Сделка/поставка завершена или сорвана.
7. Заключено/исполнено/нарушено обязательство.
8. Изменилось отношение или нарушена норма организации.
9. Изменилось membership/territory claim организации.
10. Получено наблюдение; claim/слух передан по локальному каналу/радио.
11. Агент погиб, пропал, прибыл или сменил роль.
12. Территориальная буря предупреждена/началась/закончилась; shelter принял/отказал.

## Шаблон новой идеи

Создавать отдельную заметку только когда идея влияет минимум на один из пунктов: поведение мира, наблюдаемость, причинность, стоимость или IP.

```markdown
# IDEA — название

## Наблюдаемое поведение
Что увидит зритель?

## Причина в мире
Какие факты и правила это создают?

## Новые события и данные
Какие event types / поля нужны?

## Инварианты и злоупотребления
Что не должно стать возможным?

## Цена
CPU, storage, LLM calls, контент, поддержка.

## MVP-версия
Самый маленький способ проверить ценность.
```

## ADR-шаблон

```markdown
# ADR-NNN — решение

Статус: proposed | accepted | superseded

## Контекст
## Решение
## Альтернативы
## Последствия
## Когда пересмотреть
```

## Ближайшее конкретное действие

Создать **I00 — Repository и agent harness** из [[10_ITERATION_MASTER_PLAN]]:

- pnpm/Turborepo workspace;
- strict TypeScript и import boundaries;
- Vitest/fast-check/Testcontainers;
- Fastify health endpoint, PostgreSQL migration runner и CLI `--help`;
- `CLAUDE.md`, `.claude/agents`, iteration/task templates и worktree protocol;
- Docker Compose smoke;
- CI с format, lint, typecheck и tests;
- deny-by-default permissions/sandbox/hooks и security scan skeleton из ADR-008;
- deterministic runtime/serialization profile и immutable rules/content/schema bundle checksums.

После demo и GO по I00 автоматически не начинать следующую работу: создать `REPORT.md`, показать gate человеку и только затем открыть I01. Полная последовательность I00–I18 находится в master-plan.
