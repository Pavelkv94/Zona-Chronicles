# Architecture decisions

Статус: accepted для прототипа  
Дата: 2026-08-20

## ADR-001 — единый TypeScript/Node.js стек

### Контекст

Проект будет разрабатываться в основном через Claude Code и несколько параллельных агентов. Главный риск на старте — не производительность, а расхождение контрактов, механик и тестов между частями системы. MVP содержит 30–50 агентов и дискретную симуляцию; тяжёлых численных расчётов, обучения моделей и обработки больших массивов в памяти нет.

### Решение

Использовать Node.js 24 LTS и TypeScript в строгом режиме для frontend, API, worker, домена и инструментов разработки.

Python не входит в основной прототип. После Gate E его можно добавить как изолированный сервис только для конкретной измеренной задачи и отдельного ADR: обучение/оценка моделей, сложная оптимизация, data science или пакетная аналитика. Каноническая симуляция при этом остаётся в TypeScript.

### Почему Node.js/TypeScript быстрее именно здесь

| Критерий | TypeScript/Node.js | Python |
|---|---|---|
| Общие контракты frontend/backend | Один пакет типов и runtime-схем | Генерация клиента и синхронизация двух языков |
| Работа AI-агентов | Один набор соглашений, тестов и инструментов | Больше контекста, две системы сборки и два стиля |
| Доменная симуляция | Достаточно: чистые функции и дискретные события | Также подходит, но не даёт решающего преимущества |
| LLM API | Полноценные SDK и structured output | Полноценные SDK; паритет для нашего сценария |
| Гео/SQL | PostgreSQL/PostGIS делает тяжёлую работу | Аналогично |
| TDD feedback loop | Vitest, fast-check, типы, общий monorepo | Pytest/Hypothesis сильны, но не компенсируют второй язык |
| Научные вычисления/ML | Слабее | Сильнее, но в MVP их нет |

Это решение не утверждает, что Node.js универсально лучше Python. Оно минимизирует стоимость координации конкретного проекта.

### Последствия

- доменные события и API-контракты определяются один раз;
- frontend может импортировать только публичные DTO и схемы, но не доменные сущности;
- один test runner покрывает большую часть репозитория;
- процесс симуляции изолируется от API на уровне процесса, хотя написан на том же языке;
- CPU-профилирование обязательно до попытки переписывать компоненты на другом языке.

### Когда пересмотреть

- один worker не успевает обрабатывать мир в пределах заданного lag после оптимизации запросов и алгоритмов;
- появляется доказанная потребность в NumPy/PyTorch/OR-Tools или другом Python-first инструменте;
- пакетный анализ сотен тысяч прогонов становится отдельным продуктовым контуром.

## ADR-002 — конкретный стек прототипа

### Runtime и monorepo

- Node.js 24 LTS, закреплённый в `.nvmrc`/`.tool-versions` и CI;
- TypeScript с `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`;
- ESM; не использовать TypeScript `enum`, runtime namespaces и decorators;
- pnpm workspaces;
- Turborepo для task graph и локального/CI cache;
- Corepack и точная версия package manager в `packageManager`;
- ESLint flat config + Prettier; не смешивать несколько formatter-ов.

Встроенное удаление типов Node.js допустимо для маленьких служебных скриптов. Приложения всё равно проходят отдельный `tsc --noEmit`; production-артефакты собираются явно.

### Frontend

- Next.js App Router + React + TypeScript;
- MapLibre GL JS;
- TanStack Query для server state;
- Zustand только для локальных фильтров карты/эфира, если React state станет неудобен;
- Tailwind CSS + CSS variables для токенов темы;
- доступные headless-примитивы только по необходимости, без крупной UI-системы;
- SSE для live-дельт; HTTP snapshot для восстановления после разрыва.

Async Server Components проверяются E2E-тестами, а не попыткой глубоко мокать Next.js runtime.

### Backend

- Fastify с JSON Schema-first маршрутами;
- TypeBox и официальный Fastify type provider для общих runtime-схем и TypeScript-типов;
- OpenAPI генерируется из тех же route schemas;
- Kysely + `pg` как прозрачный type-safe SQL layer;
- миграции Kysely с явным SQL для PostGIS, индексов, ограничений и триггеров;
- PostgreSQL + PostGIS — единственное обязательное состояние;
- Pino structured logs из Fastify;
- OpenTelemetry и Sentry подключаются после первой вертикали, когда появляются реальные сигналы.

Fastify выбран вместо NestJS: API в MVP небольшой и read-only, а функциональное доменное ядро не нуждается в decorator-based DI и модульной метасистеме. Fastify даёт явные plugins, lifecycle hooks, быстрый `inject` для тестов и schema-first validation с меньшим количеством framework-кода для AI-агента.

Kysely выбран вместо тяжёлого ORM: проект зависит от транзакций, append-only журнала, `FOR UPDATE`, `SKIP LOCKED`, PostGIS и явных запросов. Скрывать это за active-record моделью вредно. Prisma или Drizzle можно пересмотреть для обычного CRUD, но не смешивать два data-access подхода без причины.

### Тестирование

- Vitest — unit, component, integration и replay tests;
- fast-check — property-based и model-based tests;
- Testcontainers — настоящий PostgreSQL/PostGIS в integration tests;
- Playwright — критические пользовательские маршруты;
- MSW — только для изоляции frontend component tests;
- Stryker mutation testing — позднее и выборочно для критических чистых модулей;
- k6 или Artillery — только после появления измеримой live-нагрузки.

### Инфраструктура

- Docker Compose: `web`, `api`, `worker`, `postgres`;
- Redis, Kafka, Temporal и Kubernetes отсутствуют в MVP;
- фоновые задания и outbox забираются из PostgreSQL через короткие транзакции и `FOR UPDATE SKIP LOCKED`;
- один канонический worker владеет одним миром через transaction-level advisory lock;
- production: managed PostgreSQL с PITR и контейнерный хостинг;
- S3-совместимое хранилище добавляется при появлении тяжёлых snapshot/export/audio файлов.

## ADR-003 — функциональное ядро и императивная оболочка

Каноническое поведение строится вокруг двух чистых операций:

```text
decide(state, command, context) -> domain events | rejection
evolve(state, domain event)     -> new state
```

`context` содержит только явные зависимости: world time, PRNG, rules version и ID factory. Домен не импортирует Fastify, Kysely, `process.env`, системные часы или LLM SDK.

Императивная оболочка:

1. загружает snapshot и due action;
2. берёт lock мира;
3. вызывает чистый домен;
4. в одной транзакции пишет события, текущее состояние и outbox;
5. после commit запускает производные проекции и template representation jobs; optional narrative jobs появляются только в I18.

Такой разрез делает TDD быстрым и позволяет нескольким агентам менять адаптеры, не затрагивая правила мира.

### Поверхность недетерминизма определяется возможностью, а не синтаксической формой (SIM-01)

Правка от 2026-08-21 по blocker B-2 третьего раунда верификации I00.

Запрет недетерминизма в `packages/domain` и `packages/simulation` формулировался через
`no-restricted-globals`/`no-restricted-syntax`, то есть покрывал только обращение к глобалу.
Форма импорта того же самого источника не ловилась ничем: `import { randomUUID } from 'node:crypto'`
проходил и eslint, и dependency-cruiser, тогда как `Math.random()` отклонялся. Форма импорта
идиоматичнее — именно её пишут по умолчанию.

Решение:

- запрет описывает **источник недетерминизма**, а не способ обращения к нему. Каждый источник
  закрывается одновременно в трёх местах: `no-restricted-globals`, `no-restricted-imports`
  и regex правила `core-has-no-adapter-dependencies` в dependency-cruiser;
- в перечень входят как минимум: время (`Date`, `node:perf_hooks`, `process.hrtime`),
  случайность (`Math.random`, `node:crypto`), сеть (`fetch`, `node:http`, `node:https`,
  `node:net`, `node:tls`, `node:dgram`, `node:http2`, `node:dns`), файловая система (`node:fs`
  и голые формы), процесс и окружение (`node:process`, `node:os`, `node:child_process`,
  `node:worker_threads`), локаль (`Intl`, `toLocale*`, `localeCompare`);
- **правило без фикстуры считается несуществующим.** Каждый вход обязан иметь фикстуру в
  `boundary-fixtures.test.ts`, которая запускает настоящие eslint и dependency-cruiser и
  проверяет конкретный `ruleId`/`rule.name`. Добавление входа в список без фикстуры —
  изменение, не прошедшее Definition of Done.

Обоснование последнего пункта: раунд 3 показал, что мутационное тестирование не обнаруживает
отсутствующее правило, потому что для отсутствующего правила нет мутанта. Единственный контроль,
который ловит пробел в перечне, — исполняемая фикстура на каждый вход.

#### Известный предел контроля (верификация I01, M2)

Правило ловит **синтаксические формы обращения**, а не сам факт обращения. Закрыты: прямой
доступ (`Date.now()`), computed-доступ (`Date['now']()`), обращение через `globalThis.*`,
форма импорта (`node:crypto`).

**Не закрыт алиасинг:** `const D = Date; D.now()` проходит, потому что связать идентификатор
с исходным объектом можно только type-aware правилом, которого в конфигурации нет. Это
зафиксировано как предел, а не подразумевается закрытым: недоказанное абсолютное правило хуже
задокументированного частичного, потому что первое создаёт ложную уверенность.

Компенсирующие контроли: обязательный независимый review каждой итерации и acceptance-критерий
A1, который ловит любое чтение системных часов по результату — расхождением canonical JSON
между процессами, независимо от того, какой синтаксической формой часы были прочитаны.

## ADR-004 — дискретно-событийное время вместо глобального тика

Основная симуляция переходит к очереди запланированных действий. Worker двигает каноническое время к ближайшему due action и обрабатывает все действия этого timestamp в стабильном порядке.

Периодические процессы — погода, голод, восстановление ресурсов, рефлексия — сами являются scheduled actions. Минутный tick не перебирает всех агентов без необходимости.

Стабильный порядок:

```text
(due_world_time, priority, entity_id, action_id)
```

Это упрощает fast-forward, replay и catch-up. При одинаковом snapshot, rules version и seed результат одинаков независимо от скорости машины.

## ADR-005 — четыре слоя правды

Нельзя смешивать:

1. **Canonical fact** — что реально произошло в симуляции.
2. **Knowledge claim** — что конкретный агент считает правдой и почему.
3. **Observer signal** — что мог заметить зритель через выбранный сенсор/эфир.
4. **Representation** — текст, иконка или статья, представляющая сигнал.

В основном прототипе четвёртый слой строит детерминированный template renderer. После Gate E LLM может экспериментально работать только на четвёртом слое. Она не формирует observer signals, не пишет canonical facts, не создаёт claims и не влияет на их visibility/provenance.

## ADR-006 — генеративный ИИ только после основного прототипа

### Контекст

Главная гипотеза проекта — связная история возникает из правил мира, памяти и локальной информации. Раннее подключение LLM способно замаскировать слабую симуляцию убедительным текстом, усложнить детерминизм и добавить стоимость до доказательства ценности.

### Решение

- Gate E завершается на физически работоспособной template-only сборке и закрытой проверке людьми.
- До Gate E не добавляются LLM SDK, provider accounts/secrets, prompts, embeddings, generation queues и model-specific persistence.
- Первый допустимый runtime-эксперимент — I18 после core prototype report.
- Optional narrative package зависит только от contracts и read-only projections; обратная зависимость запрещена.
- LLM on/off не меняет event log, snapshot checksum, claims, observer signals, causal clusters и public identifiers.
- Провал LLM-эксперимента приводит к удалению/отключению optional package, а не к переделке core simulation.

### Когда пересмотреть

Только после Gate E, если template-only прототип доказал причинность и удержание, а слепое сравнение показывает измеримое улучшение подачи при приемлемой цене и groundedness.

## ADR-007 — model routing для Claude Code

Этот ADR относится только к инструментам разработки и не является разрешением на runtime-использование генеративного ИИ в продукте.

### Решение

- **Opus** — orchestrator/lead, архитектурное планирование, contract decisions, milestone analysis и architecture review;
- **Sonnet** — реализация по frozen specification, acceptance/unit tests, migrations/adapters, frontend и обычный code review;
- Haiku не используется в основном implementation workflow; его можно добавить позднее только для безопасных механических read-only задач.

Lead session запускается с `model: opus`. Implementation не выполняется lead-ом: она делегируется project subagents с явным `model: sonnet`. Architecture/contract subagents получают `model: opus`.

Не устанавливать `CLAUDE_CODE_SUBAGENT_MODEL`: эта переменная имеет более высокий приоритет и переопределит `model` всех subagent definitions.

Использовать aliases `opus` и `sonnet`, чтобы политика не зависела от конкретного номера модели. Точный resolved model ID записывается в iteration report. На время длинной итерации или milestone можно закрепить aliases через `ANTHROPIC_DEFAULT_OPUS_MODEL` и `ANTHROPIC_DEFAULT_SONNET_MODEL`; изменение resolved model внутри итерации требует повторного reviewer gate.

`opusplan` остаётся допустимым удобным режимом для одиночной сессии, но не является основной архитектурой проекта: он переключает main session на Sonnet при execution, тогда как наш lead должен сохранять роль Opus и отдавать реализацию изолированным Sonnet-subagents.

## ADR-008 — quality gates исполняются слоями, release является отдельным продуктом

### Контекст

`CLAUDE.md`, code review и высокий coverage снижают риск, но не являются security boundary и не доказывают восстановимость production. Проект хранит невосполнимый canonical event log, имеет скрытые world facts и privileged admin plane; ошибка dependency, migration, доступа или restore может разрушить продукт при полностью зелёных unit tests.

### Решение

- инструкция агенту задаёт намерение; детерминированные запреты дублируются repository permissions/sandbox/hooks, lint/import rules, database grants/constraints и CI. Ни один critical control не зависит только от послушания модели;
- observer API, admin/research plane, canonical worker, projection builder и migration runner используют разные identities и least-privilege database/network access. Observer path физически не читает canonical tables;
- каждый внешний release проходит threat-model delta, ASVS applicability checks, secret/dependency/license/static scans, SBOM и build provenance. Hosted builder подписывает provenance перед внешним deployment;
- schema delivery использует expand/migrate/contract и current/previous compatibility; откат application не переписывает committed events. Необратимые операции требуют restore point, dry-run и forward repair plan;
- backup считается годным только после restore drill с checksum/replay verification. До I17 фиксируются RPO/RTO, SLI/SLO, alerts/runbooks и incident ownership;
- runtime/PRNG/canonical serialization/rules-content bundles входят в deterministic profile. Обновление profile проходит cross-version replay/resimulation bank до принятия;
- security или operational exception всегда имеет owner, точную область, compensating control и expiry; бессрочный blanket allowlist запрещён;
- **база сравнения для любого контроля владения путями задаётся извне и недоступна проверяемой стороне.** Сверка фактического diff выполняется от `base_commit`, объявленного в карте задач итерации до старта задачи, а не от `HEAD`. `HEAD` как база запрещён явно: он двигается вместе с коммитами самой задачи, поэтому контроль, сравнивающий с `HEAD`, перестаёт видеть нарушение сразу после `git commit` — то есть отключается в штатном сценарии, где субагент коммитит свою работу. Отсутствие `base_commit` — fail-closed;
- **роль сессии выражается явно и включает read-only reviewer.** Независимая проверка — обязательный элемент Definition of Done, поэтому harness обязан уметь выдать сессии право на чтение и исполнение анализа без единого права записи. Нулевые права записи выражаются явно (`owner_role: "reviewer"`, пустой `write_paths`), а не кодируются путём, который не может совпасть. Контроль, вынуждающий выдать reviewer-у видимость прав ради разблокировки, вводит в заблуждение и запрещён.

### Последствия

- I00 строит enforceable harness и secure delivery skeleton, но не объявляет production readiness;
- I17 становится первым release-readiness gate с реальным restore, authz, load и incident exercise;
- локальная разработка остаётся простой: тяжёлые release gates не запускаются на каждом Red/Green, но обязательны в PR/nightly/release согласно риску;
- появятся отдельные artifacts: threat model, ASVS applicability matrix, migration compatibility report, SBOM/provenance, restore/load/incident evidence.

### Когда пересмотреть

- меняются trust boundaries, authentication model, hosting/build platform или canonical storage;
- появляется второй writer, multi-world tenancy, user-generated content или внешний runtime provider;
- фактические SLO/load/restore данные требуют другого deployment topology.

## ADR-009 — автопродолжение через пятичасовое usage window снято с требований

Дата: 2026-08-21. Решение владельца.

### Контекст

DEV-01 требовал, чтобы при остатке пятичасового usage window `<= 1%` работа
checkpoint-илась, дожидалась reset и продолжалась автоматически без потери и дублирования
шага. Требование было реализовано в `tools/usage-continuity` и доказано на инъектированных
фикстурах: пять отдельных процессов, обмен только файлом checkpoint, `next_exact_action`
исполняется ровно один раз, оборванная попытка отличима от успешной.

Реальных адаптеров при этом нет и в этой среде быть не может: usage telemetry пятичасового
окна, persisted wake и session resume не предоставляются платформой в форме, доступной
репозиторию. `pnpm continuity:capability-check` честно отвечал `LIMIT_AUTOCONTINUE_UNAVAILABLE`
и завершался кодом 1 — то есть требование не выполнялось и не могло быть выполнено.

### Решение

DEV-01 снимается с требований проекта. Механика checkpoint/resume, её CLI и dry-run удаляются
вместе с `tools/usage-continuity`.

Причина — соотношение цены и ценности, а не техническая невозможность: доведение DEV-01 до
работающего состояния требует адаптеров к платформенным возможностям, которых нет, и это
инфраструктура, не имеющая отношения к продукту. Подготовка среды уже заняла непропорционально
большую долю времени проекта.

Исчерпание usage window остаётся технической паузой, а не `complete` и не `blocked`, и не
является поводом сократить scope. Но обработка паузы — обязанность внешнего runner-а и человека,
а не репозитория. Репозиторий не обещает автопродолжения ни в каком виде.

Сохраняется `parseInstant`/`STRICT_ISO_8601_INSTANT_PATTERN` (строгий ISO-8601 с обязательным
смещением, отвергающий локале-зависимый разбор и несуществующие даты): этот контракт написан
для world time и переходит в `packages/contracts` для I01.

### Последствия

- `11_REQUIREMENTS_TRACEABILITY` помечает DEV-01 как withdrawn с ссылкой на этот ADR;
- раздел про пятичасовое окно удаляется из `CLAUDE.md` и `README.md`;
- acceptance-критерий I00, связанный с DEV-01, снимается; итерация оценивается без него;
- если автономная работа через usage window понадобится позже, требование вводится заново
  вместе с адаптерами, а не восстанавливается как декларация.

### Когда пересмотреть

- платформа начинает предоставлять usage telemetry и persisted wake в форме, доступной
  репозиторию без привилегированного доступа;
- появляется долгоживущий автономный процесс, чья остановка стоит дороже, чем стоимость
  адаптеров.

## Целевая структура репозитория

```text
apps/
  web/                 # Next.js observer UI
  api/                 # Fastify query/admin API и SSE
  worker/              # canonical scheduler и projection workers
  cli/                 # seed, run, replay, inspect, export
packages/
  contracts/           # TypeBox schemas, DTO, event envelopes
  domain/              # сущности, команды, события, инварианты
  simulation/          # policies, scheduler, scenes, PRNG
  persistence/         # Kysely, repositories, migrations
  projections/         # map/feed/profile/chronicle read models
  representation/      # deterministic templates и groundedness checks
  content/             # versioned original/placeholder world data
  testkit/             # builders, arbitraries, fake clock, log helpers
tests/
  acceptance/
  replay/
  soak/
  e2e/
docs/
```

Допустимые зависимости:

```text
contracts <- domain <- simulation
     ^          ^           ^
     |          |           |
 api/web   persistence   worker/cli
     ^          ^           |
     └──── projections <────┘

representation -> contracts + read-only projections
```

Стрелка указывает на пакет, от которого разрешено зависеть. `contracts` не импортирует внутренние пакеты приложения.

`domain` не зависит от базы, web framework, narrative или UI. `content` является входными данными, а не местом для исполняемой логики.

После Gate E I18 может добавить `narrative -> contracts + read-only projections`. Это одностороннее optional-расширение; core dependency graph не меняется.

## ADR-010 — границы канонического хранения: изоляция, формат payload, principals

Статус: accepted
Дата: 2026-08-22
Контекст: I02A, три предложения независимого архитектурного аудита

Все три решения касаются одного: где проходит граница между тем, чем владеет канонический мир,
и тем, чем владеет среда, в которой он живёт. Каждое было принято де-факто в коде I02A и не
было записано — то есть держалось на внимании, а не на решении.

### 10.1. Уровень изоляции транзакции — часть qualified runtime profile

SIM-01 требует одинакового результата при одинаковом «qualified runtime profile». В профиль
входят TZ, локаль, версии bundle-ов, версия PRNG, версия канонической сериализации — но не
`default_transaction_isolation`, от которого зависит НАБЛЮДАЕМАЯ семантика отказа.

Измерено в I02A: под `REPEATABLE READ` и `SERIALIZABLE` конкурентная команда получает не
названный доменный отказ `stale_world_version`, а брошенный `40001` без строки в
`command_results`. Переключить уровень может `ALTER DATABASE`, `ALTER ROLE` или
`postgresql.conf` — то есть решение принимается вне репозитория.

**Решение.** Уровень изоляции задаётся ЯВНО на каждой канонической транзакции
(`read committed`), а не наследуется от сервера. Значение входит в
`deterministic_runtime_profile` снимка и проверяется `verifyRuntimeProfileCompatibility` вместе
с остальным профилем. Поле профиля добавляется в I02B, когда снимки становятся durable; в
checksum оно не входит по тому же доводу, что и версия Node/ICU.

**Где именно проверяется** (уточнение M3, аудит I02B). До правки эта фраза описывала контроль,
которого в работающей системе не было: функция существовала и была покрыта unit-тестами, но не
вызывалась ни на одном пути. Точка проверки — ЧТЕНИЕ снимка (`loadLatestSnapshot`/`loadSnapshotAt`
в `packages/persistence/src/snapshot-store.ts`), потому что именно там мир, посчитанный под одним
профилем, продолжается процессом с другим. Профиль читающего процесса передаёт вызывающий
(`LoadSnapshotContext.runtimeProfile`) — тем же приёмом, что `bundles`, и по той же причине, по
которой `packages/persistence` не читает свойства хоста сам (ADR-002). Несовместимость — громкий
отказ восстановления, а не предупреждение: §7 называет её «профиль ещё не квалифицирован».

**Отвергнуто:** «поддерживать все уровни и ретраить 40001». Retry-политика на сериализационный
конфликт — это уже другой контракт отказа, и вводить её как побочный эффект нельзя.

### 10.2. Канонический payload хранится в `jsonb`, но его форма закреплена checksum-ом

`world_time` хранится текстом с записанным обоснованием: round-trip через драйвер зависит от
настроек сессии, и SIM-01 это запрещает. К `payload` тот же довод применим, а решение в I02A
было принято обратное — и без обсуждения.

Проверено: `jsonb` сортирует ключи по (длина, байты), а канонический порядок проекта — по
кодовым точкам. Порядки расходятся уже на четырёх ключах.

**Решение.** `payload` остаётся `jsonb` — он запрашиваем, и это понадобится проекциям I03. Но
точность обратного чтения перестаёт быть предположением: `event_checksum`, снятый с события ДО
записи, хранится рядом, и `loadWorldEvents` сверяет с ним каждое прочитанное событие. Расхождение
— громкий сбой, а не тихо другой факт.

**Отвергнуто:** `payload text` с каноническим текстом. Он лишил бы проекции возможности
фильтровать по содержимому, а гарантию даёт не формат хранения, а checksum рядом с ним.

### 10.3. Principals создаёт оператор; миграции владеют только грантами

Роли PostgreSQL — объекты КЛАСТЕРА, журнал миграций — объект БАЗЫ. Из этого несоответствия
следуют два дефекта, найденные аудитом: restore одной базы в чистый кластер не восстанавливает
права и не подаёт сигнала, а роль-однофамилец, заведённая кем-то другим, получает гранты.

**Решение.**

1. Миграции не создают роли и не содержат паролей. Пароль в тексте миграции попадает в git, в
   `dist` и в неизменяемый checksum журнала.
2. Гранты применяются при КАЖДОМ `world migrate`, вне журнала, идемпотентно и одной
   транзакцией — иначе между снятием и выдачей прав есть окно, в котором работающий worker
   получает `permission denied` (измерено: 9 отказов из 128 запросов).
3. Существующая роль проверяется по АТРИБУТАМ, а не по имени: `superuser`, `createrole`,
   `createdb` или `bypassrls` у роли с нашим именем означают чужого principal, и гранты ему не
   выдаются.
4. Порядок «сначала миграции, потом гранты» — часть контракта: матрица грантов описывает
   текущую схему, и на базе предыдущей поставки выдача прав на новую таблицу обязана падать.

**Следствие для I02B+:** каждая новая таблица приносит свою строку в `GRANT_MATRIX` в том же
change, иначе golden-сверка грантов упадёт, а worker получит `permission denied`.

## ADR-011 — команда расписания не несёт optimistic concurrency, а мир двигают под замком

Статус: accepted
Дата: 2026-08-22
Контекст: два blocker-а независимого аудита I02B, оба воспроизведены исполнением

### 11.1. У `expected_world_version` две несовместимые роли

Одна и та же форма `Command` обслуживает внешнее НАМЕРЕНИЕ и внутреннее СЛЕДСТВИЕ уже
принятого факта. Для первого optimistic concurrency защищает от команды, собранной по
устаревшему прочтению мира. Для второго защищать нечего: действие породил сам мир, а
`executeCommand` берёт замок мира и читает состояние внутри транзакции.

Смешение стоило потерянных journey. Поле входит в отпечаток команды, поэтому конкурентный сдвиг
версии между чтением и захватом замка делал отказ `stale_world_version` НЕВОССТАНОВИМЫМ:
следующая попытка того же действия собирала другую версию, получала `fingerprint-mismatch` и
отвергалась вечно. Агент навсегда оставался `traveling`, в append-only журнале оставалось
`journey.started` без завершения, а `world tick` возвращал успех.

**Решение.** `expected_world_version` необязателен. Его отсутствие означает «проверять версию не
надо», а не «версия ноль». Внешние команды его ставят; команды, выведенные из расписания, — нет.

### 11.2. Мир двигают под advisory lock, а не только под row lock

I02A отклонилась от §5 `03_TECHNICAL_DESIGN` (transaction-level advisory lock мира), заменив его
row lock-ом на строке `worlds`, и записала отклонение как безобидное. Оно таковым не было.

Мировое время монотонно и ГЛОБАЛЬНО: каждое обработанное действие двигает его к своему `due_at`.
Два worker-а, выбирающие батчи независимо, неизбежно берут действия с РАЗНЫМИ `due_at`, и тот,
кому досталось более раннее, пытается сдвинуть время назад. Воспроизведено: шесть агентов с
разными сроками, три worker-а — `06:30 -> 06:25`.

Параллелизм между worker-ами на ОДНОМ мире несовместим с одними монотонными часами. Это свойство
модели, а не дефект реализации, и §5 его учитывал.

**Решение.** `runWorldTick` держит advisory lock мира на весь шаг. `pg_try_advisory_lock`, а не
`pg_advisory_lock`: второй worker не ждёт, а честно возвращает пустой шаг — ожидание превратило
бы очередь worker-ов в скрытую сериализацию с непредсказуемой задержкой. `SKIP LOCKED` остаётся
нужным: он развязывает worker-ов на разных мирах.

### 11.3. Доменный отказ на запланированном действии обязан быть конечным

Отказ не был ни «выполнено», ни «ожидает»: действие возвращалось в очередь каждым тиком и
отвергалось снова — вечно.

**Решение.** Отвергнутое действие получает `failed_at` и `failure_code` (миграция 0008) и
исключается из захвата. Починить автоматически нельзя — мир не знает, чего хотел оператор; можно
только перестать делать вид, что всё в порядке.

## Источники решений

- [Node.js release policy](https://nodejs.org/en/about/previous-releases)
- [Node.js TypeScript support](https://nodejs.org/api/typescript.html)
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Fastify type providers](https://fastify.dev/docs/latest/Reference/Type-Providers/)
- [Vitest projects](https://vitest.dev/guide/projects)
- [fast-check](https://fast-check.dev/)
- [Testcontainers PostgreSQL](https://node.testcontainers.org/modules/postgresql/)
- [Next.js testing guide](https://nextjs.org/docs/app/guides/testing)
- [PostgreSQL locking clause](https://www.postgresql.org/docs/current/sql-select.html)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code subagent model selection](https://code.claude.com/docs/en/sub-agents)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)
- [NIST SSDF SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)
- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)
- [SLSA 1.2](https://slsa.dev/spec/v1.2/)
- [PostgreSQL point-in-time recovery](https://www.postgresql.org/docs/current/continuous-archiving.html)
