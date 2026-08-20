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
- security или operational exception всегда имеет owner, точную область, compensating control и expiry; бессрочный blanket allowlist запрещён.

### Последствия

- I00 строит enforceable harness и secure delivery skeleton, но не объявляет production readiness;
- I17 становится первым release-readiness gate с реальным restore, authz, load и incident exercise;
- локальная разработка остаётся простой: тяжёлые release gates не запускаются на каждом Red/Green, но обязательны в PR/nightly/release согласно риску;
- появятся отдельные artifacts: threat model, ASVS applicability matrix, migration compatibility report, SBOM/provenance, restore/load/incident evidence.

### Когда пересмотреть

- меняются trust boundaries, authentication model, hosting/build platform или canonical storage;
- появляется второй writer, multi-world tenancy, user-generated content или внешний runtime provider;
- фактические SLO/load/restore данные требуют другого deployment topology.

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
