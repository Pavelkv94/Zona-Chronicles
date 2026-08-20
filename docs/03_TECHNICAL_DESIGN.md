# Technical design

Статус: accepted technical baseline до executable repository  
Дата: 2026-08-20  
Внешние runtime-факты проверены: 2026-08-20

## 1. Рекомендуемый стек

### Frontend

- Next.js + React + TypeScript;
- MapLibre GL JS для интерактивной карты;
- TanStack Query для HTTP-состояния;
- Zustand только если локальные UI-фильтры перестанут удобно помещаться в React state/URL;
- Server-Sent Events (SSE) для live-потока; WebSocket не нужен, пока зрители ничего не отправляют;
- Tailwind CSS + CSS variables для темы, без тяжёлой дизайн-системы на старте.

### Backend и симуляция

- Node.js 24 LTS + TypeScript strict для API, worker и домена;
- Fastify + TypeBox/JSON Schema для API, runtime validation и OpenAPI;
- Kysely + `pg`, явные миграции и SQL escape hatches;
- отдельный процесс `simulation-worker`, использующий то же доменное ядро;
- PostgreSQL как единственная обязательная база;
- PostGIS для координат, маршрутов и зон воздействия;
- Redis только при реальной необходимости: fan-out live-событий, rate limit, короткий cache;
- pgvector — не в основном прототипе; рассматривать только после Gate E и измеренного ограничения обычного индексированного поиска.

Один язык выбран сознательно: основной прототип выполняет дискретную доменную симуляцию, а не научные вычисления. Общие schemas, один toolchain и быстрый TDD важнее потенциальных Python-библиотек, которые пока не нужны. Python/ML допустимы только после Gate E как изолированный sidecar для измеренной задачи и отдельного ADR. Полное решение: [[06_ARCHITECTURE_DECISIONS]].

### Toolchain и тесты

- pnpm workspaces + Turborepo;
- Vitest + fast-check;
- Testcontainers с настоящим PostgreSQL/PostGIS;
- Playwright для E2E;
- ESLint flat config + Prettier;
- TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.

### Эксплуатация

- Docker Compose локально;
- один контейнер API, один worker, один PostgreSQL;
- S3-совместимое хранилище для экспортов, аудио и больших snapshot-файлов — позднее;
- OpenTelemetry + структурированные логи;
- Sentry или аналог для ошибок;
- managed PostgreSQL и простой контейнерный хостинг для закрытой проверки; публичный deployment допустим только после IP/security release decision.

Temporal/Kafka/Kubernetes не нужны на старте. Temporal становится полезен, если появятся десятки типов долгих, прерываемых и повторяемых workflow; Kafka — когда один PostgreSQL/outbox перестанет справляться; Kubernetes — при нескольких независимо масштабируемых сервисах.

## 2. Архитектура: модульный монолит

```text
┌──────────────────────┐       HTTP / SSE
│ Next.js observer UI  │◄────────────────────────────┐
└──────────────────────┘                             │
                                                   │
┌──────────────────────────────────────────────────┴────┐
│ Fastify API                                            │
│ query API · projections · archive · live stream        │
└─────────────────────────┬──────────────────────────────┘
                          │
                 ┌────────▼────────┐
                 │ PostgreSQL      │
                 │ events          │
                 │ snapshots       │
                 │ read models     │
                 │ outbox          │
                 └────────▲────────┘
                          │ transaction
┌─────────────────────────┴──────────────────────────────┐
│ Simulation worker                                      │
│ clock · world rules · agents · scenes · validators     │
│ template renderer · chronicle projector                │
└────────────────────────────────────────────────────────┘
```

Репозиторий:

```text
apps/
  web/
  api/
  worker/
packages/
  contracts/       # TypeBox schemas, DTO, event envelopes
  domain/          # сущности, команды, события, инварианты
  simulation/      # scheduler, deterministic Utility AI, планировщик, сцены
  persistence/     # Kysely, migrations, repositories
  projections/     # карта, эфир, хроника, профили
  representation/  # template renderer и проверка groundedness
  content/         # versioned locations/organizations/creatures/hazards + asset manifest
  testkit/         # builders, arbitraries, fake clock/PRNG
tests/
  acceptance/
  replay/
  soak/
  e2e/
ops/
docs/              # эта Obsidian-база
```

`domain` и `simulation` не импортируют Fastify, Kysely, системные часы, `process.env`, сеть или LLM SDK. Каноническое ядро строится как `decide(state, command) -> events` и `evolve(state, event) -> state`.

До Gate E пакета `narrative`, LLM SDK, provider secrets и prompt registry в репозитории нет. Опциональная I18 может добавить отдельный `packages/narrative`, зависящий только от contracts и read-only projections; ни один core package не начинает зависеть от него.

`packages/content` содержит отдельно editable asset sources, оптимизированные public outputs и versioned manifests. Build валидирует author/source/license/checksum, санитизирует SVG, создаёт responsive AVIF/WebP и MapLibre sprite atlas. Runtime не загружает production art с внешних hotlink URL. Точный pipeline: [[12_VISUAL_AND_CONTENT_DESIGN]] §6.

## 3. Event log и снимки

Не надо применять event sourcing ко всему сайту, но для мира он оправдан: история сама является продуктом, необходимы replay, расследование причин и восстановление прошлых состояний.

`world_events` — append-only источник истины. Append-only защищается не только соглашением: runtime-role worker имеет `INSERT/SELECT`, но не `UPDATE/DELETE`, maintenance break-glass role отделена и аудитируется, а migration owner не используется приложением:

```json
{
  "event_id": "01K...",
  "world_id": "main",
  "sequence": 184233,
  "world_time": "2034-05-17T21:43:00Z",
  "type": "relationship.trust_changed",
  "actor_ids": ["agent_marten"],
  "subject_ids": ["agent_sable"],
  "location_id": "north_yard",
  "caused_by": ["event_01...", "event_02..."],
  "payload": {"delta": -0.18, "reason": "promise_broken"},
  "random_audit": {"stream": "scene:01K...", "draw": 17},
  "rules_version": "0.1.0",
  "schema_version": 1
}
```

Текущие таблицы `agents`, `relationships`, `inventories`, `locations` — материализованное состояние для быстрых запросов. Они обновляются в той же транзакции, что и event log. Каждые N событий создаётся snapshot. Отдельные projections питают карту, хронику и эфир.

Обязательные механизмы:

- монотонный `sequence` на мир;
- optimistic concurrency по версии сущности/мира;
- idempotency key для команд и внешних генераций;
- transactional outbox для live-доставки;
- versioned event schemas и миграции projection;
- checksum snapshot и регулярный replay-тест;
- versioned PRNG streams, injected world clock и deterministic ID factory;
- canonical outcome хранится в событии; replay не выполняет random draw повторно.

## 4. Компоненты домена

- `WorldClock` — каноническое время и скорость.
- `Scheduler` — очередь запланированных действий.
- `WorldRules` — физические и экономические ограничения.
- `NavigationGraph` — узлы, рёбра, стоимость и опасность.
- `AgentPolicy` — допустимые цели и utility scores.
- `PlanExecutor` — короткие планы и перепланирование.
- `EncounterResolver` — обнаружение и создание сцен.
- `SceneEngine` — конечное ядро торговли, разговора, отдыха и боя.
- `TerritoryEngine` — claims, pressure, occupation, supply и consolidation.
- `OrganizationPolicy` — membership, doctrine, diplomacy, contracts и patrol goals.
- `CombatResolver` — cover/range/ammunition/wounds/morale, surrender и aftermath.
- `FieldStormEngine` — anomaly fields, extraction и детерминированный post-storm spawn.
- `KnowledgeGraph` — субъективные факты и provenance.
- `RelationshipEngine` — многомерные отношения.
- `EcologyController` — популяции, ресурсы, угрозы, погода.
- `RepresentationRenderer` — детерминированные шаблоны для эфира и карточек.
- `ChronicleProjector` — причинные кластеры, дневные и сюжетные машинные сводки.

Опционально после Gate E: `NarrativeGateway` — провайдер-независимый внешний renderer, не являющийся компонентом домена или simulation worker.

## 5. Пример цикла worker

```text
1. Получить transaction-level advisory lock канонического мира.
2. Захватить ближайшие due actions в стабильном порядке.
3. Загрузить минимальный snapshot затронутых сущностей.
4. Сформировать допустимые команды и вызвать чистый domain handler.
5. Разрешить outcome через versioned PRNG stream.
6. В одной транзакции добавить события и обновить state/schedule/outbox.
7. Продвинуть каноническое время к обработанному due timestamp.
8. После commit асинхронно построить projections и template representations.
```

Не держать один бесконечный in-memory объект мира без журналирования. После падения процесс должен продолжить с последнего committed sequence. При одном timestamp порядок задаётся `(priority, entity_id, action_id)` и не зависит от скорости процесса.

## 6. Модель данных верхнего уровня

| Таблица | Назначение |
|---|---|
| `worlds` | конфигурация, время, seed, версия правил |
| `entities` | общий id и тип сущности |
| `agents` | тело, черты, цель, позиция, версия |
| `groups` / `memberships` | отряды, организации, роли |
| `organization_relations` / `reputations` | diplomacy evidence/state и локальная репутация |
| `locations` / `routes` | геометрия, граф, свойства |
| `territory_claims` / `control_transitions` | влияние, occupation, supply connectivity и consolidation |
| `bases` / `base_modules` / `checkpoints` | owner, staff, stock, condition, capacity и route access |
| `venues` / `service_roles` | trader/medic/guide points, policies и capacity |
| `contracts` / `contract_participants` | jobs, reward/escrow, objectives, deadlines и outcomes |
| `patrols` / `expeditions` | состав, маршрут, provisioning, phase и abort/return rules |
| `field_camps` / `caches` | временное присутствие, decay, physical storage и access/knowledge roots |
| `creature_populations` / `habitats` | ecotype pressure, миграция и encounter source |
| `hazard_fields` / `field_slots` | anomaly family/state, route geometry, cues, cooldown и find capacity |
| `storm_cycles` | warning/impact/aftermath/recovery и PRNG stream roots |
| `items` / `inventories` | владение и ресурсы |
| `equipment_state` | slots, condition, ammunition/magazine, protection/detector state |
| `exposures` | source-linked contamination/hazard dose, decay и treatment state |
| `item_provenance` | source/sink chain уникальных valuable finds и loot |
| `relationships` | доверие, страх, долг и т.д. |
| `knowledge_claims` | субъективные знания и уверенность |
| `memories` | эпизоды и рефлексии |
| `plans` / `scheduled_actions` | намерения и due time |
| `scenes` / `scene_members` | локальные взаимодействия |
| `custody` | surrender, disarm, captor/captive, release/exchange/escape state |
| `world_events` | неизменяемая история |
| `event_causes` | причинные рёбра |
| `conversations` / `utterances` | опубликованный текст |
| `chronicle_entries` | сводки и истории |
| `world_snapshots` | ускорение восстановления |
| `outbox` | надёжная доставка projections/live |

## 7. API

Read-only публичное API:

```text
GET /v1/world
GET /v1/world/snapshot?at_sequence=  # observer projection snapshot, не canonical snapshot
GET /v1/map?bbox=&at_sequence=
GET /v1/locations/{id}
GET /v1/agents/{id}
GET /v1/agents/{id}/timeline
GET /v1/events?after=&location_id=&importance=
GET /v1/scenes/{id}
GET /v1/chronicle?day=&tag=
GET /v1/search?q=
GET /v1/stream                 # SSE, resume через Last-Event-ID
```

Внутреннее admin API отделяется авторизацией и сетью:

```text
POST /internal/world/pause
POST /internal/world/resume
POST /internal/world/snapshot
POST /internal/world/fork
POST /internal/projections/rebuild
GET  /internal/agents/{id}/decision-trace
```

Публичный `snapshot` содержит только разрешённую observer projection и её projection sequence. Он никогда не сериализует canonical snapshot, hidden fields, точные knowledge state или decision trace. Все list/search endpoints имеют validated cursor, `limit` с server-side maximum и детерминированный порядок. SSE сообщает projection sequence; при утрате retention window клиент получает явный `reset_required` и перечитывает observer snapshot, а не canonical log.

## 8. Опциональный LLM-контур после основного прототипа

Этот раздел не является scope ранней реализации. К нему переходят только после template-only закрытой проверки и решения **GO** на Gate E. До этого запрещены provider SDK, API keys, prompts, LLM queues, embeddings и специальные таблицы usage.

Провайдер модели скрыт за интерфейсом. Каждый вызов содержит:

- `purpose` и версию prompt;
- строго ограниченный контекст;
- JSON Schema результата;
- timeout, retry policy и budget;
- входной hash для cache/idempotency;
- ссылки на события;
- автоматическую проверку фактов;
- сохранённые usage и latency.

Очереди по приоритетам:

1. важный живой разговор;
2. сообщение радио;
3. дневная летопись;
4. рефлексия памяти;
5. декоративный текст.

При недоступности LLM мир продолжает жить. Публикация использует шаблон или ждёт; ни один физический процесс не блокируется.

Core API, worker, snapshots, observer signals и template representations должны иметь одинаковое поведение при физическом отсутствии optional package. Feature flag выключен по умолчанию. Включение LLM меняет только новую версию representation; оно не меняет event log, claims, signals, causal clusters или порядок публикации.

Контроль цены:

- не генерировать текст на каждый tick;
- объединять реплики в сцену;
- шаблоны для быта;
- краткие структурированные memory summaries;
- cache по hash;
- дневной лимит токенов;
- метрика «стоимость на одну значимую историю».

## 9. Live-доставка

Поскольку зритель только читает, SSE проще WebSocket:

- автоматическое переподключение браузера;
- `Last-Event-ID` позволяет догнать пропущенные события;
- стандартная HTTP-инфраструктура;
- сервер отправляет дельты карты, новые эфиры и события.

Клиент периодически сверяет sequence со snapshot endpoint. Если разрыв слишком большой, он получает свежий snapshot вместо проигрывания тысяч дельт.

## 10. Тестирование

Применяется двойной цикл TDD: сначала падающий acceptance test на observable behavior, затем короткие unit Red → Green → Refactor циклы. Полный процесс и multi-agent workflow описаны в [[08_TDD_AND_AGENT_WORKFLOW]].

### Unit и property tests

- Vitest для чистых reducers, policies и handlers;
- fast-check для последовательностей команд и model-based проверок;
- инварианты владения, жизни/смерти, перемещения, знаний;
- utility score и планирование;
- распространение слухов;
- schema validation.

Домен получает Clock, RandomSource и IdFactory явно. Прямые `Date.now()` и `Math.random()` запрещены import/lint правилами.

### Integration и contract tests

- Testcontainers поднимает настоящий PostgreSQL/PostGIS;
- проверяются миграции, транзакционность event/state/outbox, locks и idempotency;
- Fastify routes тестируются через `inject`;
- TypeBox schemas являются единым runtime/API contract;
- frontend импортирует публичные DTO, но не доменные сущности.

### Golden simulation

Маленькие сценарии используют полный фиксированный log. Большие — causal milestones, инварианты и статистические диапазоны. Это сохраняет детерминизм, но не превращает каждую настройку баланса в бездумное обновление огромного snapshot.

### Soak tests

- 24 часа ускоренной симуляции;
- 7 игровых дней без вмешательства;
- 100 повторов с разными seed;
- отсутствие тупиков расписания, бесконечных циклов и вымирания из-за бага.

Nightly прогоняет больше property cases и seed, чем обязательный быстрый PR gate.

### Narrative evals (начиная с I18)

- нет фактов вне входного набора;
- персонажи не знают недоступного;
- нет повторяющихся реплик;
- тон соответствует возрастному рейтингу;
- имена и термины валидны;
- автоматическая сводка ссылается на исходные события.

### Наблюдаемость

- lag канонического времени;
- due queue depth;
- events/sec;
- размер snapshot/replay time;
- доля и ошибки template representations; после I18 отдельно LLM calls, failures, tokens и цена;
- популяции, смертность, ресурсы, застрявшие агенты;
- разнообразие событий и социальная связность.

### Frontend и E2E

- Testing Library + MSW для обычной UI-логики;
- Playwright для карты, feed, причинных переходов и async Server Components;
- основной E2E-критерий: новый зритель находит событие и восстанавливает его причину, а не только видит успешно загруженную страницу.

## 11. Безопасность и модерация

Observer-facing сайт остаётся недоверенной внешней границей даже в закрытой проверке и даже если пользователь не пишет в мир. Core template-only слой требует безопасных авторских строк и возрастной политики; после I18 те же требования распространяются на generated text:

- возрастной маркировки и понятных ограничений насилия;
- запрета реальных экстремистских лозунгов и травли;
- после I18 — фильтрации generated text до публикации;
- после I18 — удаления персональных данных из prompt/log;
- rate limiting публичного API;
- отдельного admin-аудита;
- возможности скрыть текстовую representation, не удаляя фактическое событие;
- резервных копий и point-in-time recovery.

### Trust boundaries и доступ

До первого внешнего deployment создаётся versioned threat model для границ browser → edge/API → projections, admin/research plane → canonical storage, worker → PostgreSQL и CI → release artifact. Для каждой границы фиксируются assets, actors, abuse cases, controls, residual risk и owner; изменение auth, новой сети, upload/parser или внешнего provider-а обновляет модель в том же change.

Обязательный baseline:

- deny-by-default для `/internal/*`; отдельный origin/network policy, phishing-resistant MFA через выбранный identity provider и короткоживущая role-based session. Наличие скрытого URL не считается защитой;
- разные PostgreSQL roles: migration owner, canonical worker, projection builder и read-only query API. API-role не имеет доступа к canonical tables; application roles не имеют DDL и `BYPASSRLS`;
- TLS вне localhost, secure/httpOnly/sameSite cookies при cookie auth, CSRF-защита для state-changing internal routes, явный CORS allowlist и security headers/CSP;
- schemas ограничивают размер строк/массивов/payload, глубину JSON, query complexity, cursor и response size; rate/concurrency/time limits защищают expensive archive/map/search endpoints и SSE connections;
- secrets не хранятся в git, fixtures, logs, traces, screenshots или artifacts. Они поступают через secret store, имеют owner/rotation/revocation procedure; secret scanning блокирует merge/release;
- structured logs используют allowlist полей и redaction. Admin audit фиксирует actor, action, target, outcome и request/correlation ID, но не secret/token или полный sensitive payload;
- данные закрытых тестировщиков минимизируются; retention/deletion policy и consent фиксируются до I17. Canonical fictional history не смешивается с account/analytics PII.

Security acceptance использует versioned OWASP ASVS 5.0 requirements, выбранные по реальному threat model; «весь ASVS» без applicability matrix не является gate. Найденная уязвимость получает severity, owner, срок исправления и regression test, когда он технически применим.

## 12. Delivery, миграции и эксплуатационная готовность

### Supply chain и release

- CI использует frozen lockfile и clean install; lifecycle scripts и новые transitive dependencies рассматриваются как исполняемый код;
- новая production dependency требует owner, purpose, license, maintenance/security check и рассмотренной альтернативы; dependency diff проверяется отдельно от feature diff;
- PR gate включает secret scan, dependency/license policy, SAST для поддерживаемых языков, IaC/container scan после появления соответствующих artifacts и проверку package/import boundaries;
- release создаёт SBOM, checksums и build provenance, связывающую artifact с commit, lockfile и CI builder. Для внешнего deployment provenance подписывается и проверяется средствами выбранной hosted build platform;
- critical/high vulnerability не замалчивается blanket allowlist: исключение имеет точный package/advisory, компенсирующий control, owner и expiry. Patch policy и release rollback procedure проверяются до I17.

### Миграции и совместимость

- production schema changes следуют expand → migrate/backfill → switch reads/writes → contract; destructive contract не попадает в тот же release, что и первый новый reader/writer;
- каждая миграция тестируется на пустой БД, копии предыдущей schema и representative data volume; отдельно проверяются lock duration, timeout, retry/idempotency и совместимость current/previous application version;
- rollback приложения не должен требовать отката уже committed canonical events. Необратимая data migration требует backup/restore point, dry-run, explicit owner и forward repair plan;
- event upcasters и projection rebuilds проходят compatibility fixtures всех поддерживаемых schema versions; old rules/content/schema bundles сохраняются по checksum вместе с retention policy;
- deploy worker-а выполняет graceful drain: перестаёт claim-ить actions, завершает или освобождает lease, подтверждает commit boundary. API/SSE имеют readiness отдельно от liveness.

### SLO, recovery и incident response

До I17 фиксируются измеримые SLI/SLO и alert thresholds минимум для API availability/latency, projection lag, canonical worker lag, queue depth, failed commands/outbox, replay/restore и backup freshness. Числа сначала provisional и утверждаются по load baseline; отсутствие числа лучше ложной «гарантии», но Gate E без принятых budgets не проходит.

Обязательны:

- RPO/RTO для canonical event log, projections и account/config data; projections считаются rebuildable, canonical log — нет;
- automated backups/PITR и регулярный restore drill в изолированную среду с проверкой checksums, replay и времени восстановления; успешный backup job без restore не является evidence;
- alert → runbook → owner/escalation для stuck worker, projection lag, depleted storage, failed backup, error-rate spike и suspected credential compromise;
- immutable deployment identifier и rules/content/schema versions в health/telemetry, чтобы incident можно было воспроизвести;
- load/capacity test с bounded payloads и slow-client SSE, budget CPU/DB/storage на world-day и headroom до внешней проверки;
- incident record с timeline, impact, recovery evidence и preventive actions; destructive repair canonical data выполняется только break-glass procedure с сохранением исходного состояния.

Нормативные ориентиры: NIST SSDF SP 800-218 для secure development lifecycle, OWASP ASVS 5.0 для проверяемых application controls, SLSA 1.2 для build provenance и официальная документация PostgreSQL для PITR/restore. Они не заменяют project-specific acceptance tests.
