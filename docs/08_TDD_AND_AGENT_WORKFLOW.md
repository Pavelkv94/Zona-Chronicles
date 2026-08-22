# TDD и AI-assisted разработка

Статус: accepted process for implementation  
Дата: 2026-08-20  
Инструкции Claude Code сверены с официальной документацией: 2026-08-20

## 1. Цель процесса

AI-агенты ускоряют набор кода, но также ускоряют размножение неверных предположений. Поэтому единицей разработки является не «написанный модуль», а проверяемое изменение поведения:

```text
спецификация -> падающий тест -> минимальная реализация
-> рефакторинг -> независимая проверка -> merge
```

TDD не заменяет дизайн. Сначала фиксируются наблюдаемое поведение, события, инварианты и границы, затем пишется тест.

## 2. Двойной цикл TDD

### Внешний цикл

Один acceptance test описывает вертикальное поведение без UI-деталей:

> Раненый агент просит союзника о помощи; союзник тратит лекарство; возникает долг; при replay состояние и causal links совпадают.

Тест сначала падает на публичном application port/CLI. Он может проходить через домен и настоящий PostgreSQL, но не через LLM.

### Внутренний цикл

Для каждого правила:

1. **Red** — один маленький тест падает по ожидаемой причине.
2. **Green** — минимальная реализация без будущих абстракций.
3. **Refactor** — убрать дублирование, сохранив зелёные тесты.
4. Запустить ближайшие property/invariant tests.
5. Вернуться к внешнему тесту.

Нельзя писать пачку тестов на ещё не существующий дизайн, а затем пачку реализации. Короткий feedback loop легче контролировать и человеку, и агенту.

## 3. Test seams, обязательные в архитектуре

Домен получает зависимости через порты:

- `Clock` — только world time;
- `RandomSource` — versioned seeded streams;
- `IdFactory` — стабильные IDs в тестах;
- `Ruleset` — все коэффициенты;
- `EventStore`;
- `SnapshotStore`;
- `SchedulerRepository`;
- `TelemetryPort`.

Template rendering живёт вне домена как consumer read-only projections. До Gate E `NarrativePort`, LLM SDK и model-specific test doubles не создаются.

В доменных пакетах запрещены прямые:

- `Date.now()` / `new Date()` без входного значения;
- `Math.random()`;
- `process.env`;
- network calls;
- SQL/ORM imports;
- LLM SDK;
- глобальные mutable singleton-ы.

Эти запреты проверяются lint/import-boundary правилами, а не только инструкцией агенту.

## 4. Пирамида тестов

| Слой | Что проверяет | Инструмент | Скорость/частота |
|---|---|---|---|
| Typecheck | контракты и exhaustive handling | `tsc --noEmit` | каждый change |
| Unit | чистые правила, reducers, scoring | Vitest | каждый Red/Green |
| Property/model | инварианты и последовательности команд | fast-check + Vitest | локально/CI |
| Integration | транзакции, locks, migrations, outbox | Testcontainers PostgreSQL | перед merge |
| Contract | route schemas, OpenAPI, SSE envelopes | Vitest/Fastify inject | перед merge |
| Replay | snapshot + log = ожидаемое состояние | Vitest/CLI | перед merge |
| Component | карта без WebGL details, feed, filters | Testing Library + MSW | перед merge |
| E2E | пользователь понимает мир и причинность | Playwright | CI |
| Soak | 7 дней, много seed, статистические bounds | CLI/Vitest workers | nightly/manual |
| Narrative eval | groundedness и fallback optional LLM renderer | versioned eval runner | начиная с I18, при prompt/model change |

### Что не мокать

- чистый домен не нуждается в моках;
- SQL integration tests используют настоящий PostgreSQL/PostGIS;
- Fastify routes тестируются через `inject`, а не реальный TCP, кроме E2E;
- начиная с I18 LLM всегда подменяется deterministic fake в обычном CI; до I18 такой зависимости в сборке нет;
- MapLibre adapter можно подменить в component test, но реальные пользовательские слои проверяются Playwright screenshot/interaction tests.

## 5. Property-based стратегия

Обязательные свойства первой вертикали:

- применение события не нарушает schema;
- предмет не дублируется при любой допустимой последовательности transfer/consume/drop;
- мёртвый агент никогда не возвращается в actionable state;
- время и sequence монотонны;
- replay(prefix + suffix) совпадает с replay полного log;
- snapshot + remaining events совпадает с полным replay;
- pause/resume и разный batch size дают одинаковый результат;
- knowledge claim всегда имеет конечный provenance root;
- повторная команда с тем же idempotency key не создаёт второе событие;
- score и route cost конечны, не `NaN` и остаются в заданных bounds;
- любая сцена достигает terminal state за ограниченное число transitions.

fast-check seed и минимальный shrunk counterexample сохраняются в failure output. Найденный production bug сначала превращается в обычный regression test.

## 6. Golden, replay и баланс

Golden tests делятся на три уровня:

1. **Micro golden** — 5–20 событий маленького сценария, строгий полный diff.
2. **Causal golden** — обязательные типы событий и causal edges, без фиксации неважных полей.
3. **Statistical scenario** — диапазоны по 100+ seed, без ожидания точной истории.

Полный недельный event log не фиксируется как snapshot на каждую версию: это сделает балансировку мучительной и научит агентов бездумно обновлять snapshots.

Изменение rules version требует migration note и осознанного обновления затронутых golden fixtures.

## 7. Coverage и качество тестов

Стартовые merge gates:

- `domain` и `simulation`: 95% lines/functions, 90% branches;
- остальные backend packages: 85% lines, 80% branches;
- frontend: coverage не ниже 75% для обычной логики; async Server Components закрываются E2E;
- 100% event schemas проходят round-trip validation;
- 100% command handlers имеют happy path, rejection path и idempotency test.

Coverage — сигнал, а не цель. Тест без meaningful assertion удаляется. После стабилизации критичных reducers выборочный mutation score должен быть не ниже 80%.

### Правило мутационной пробы (обязательное, а не рекомендательное)

Введено в I01, ужесточено в I02A по замечанию независимого аудита.

**Новый инвариантный тест принимается только вместе с записанным выводом его падения против
намеренно сломанной реализации.** Не «я проверил», а точный текст: какая мутация применена,
какое утверждение упало и с каким сообщением. Восстановление исходного кода — часть пробы.

Два уточнения, оба куплены дорого:

1. **Смотреть, НА ЧЁМ упала проба, а не только упала ли.** «Тест покраснел на мутации» —
   необходимое условие, но не достаточное. В I02A детектор атомарности грантов падал на
   утверждении «слишком мало наблюдений», то есть отличал быструю реализацию от медленной, а
   не сломанную от целой. Второй детектор падал каскадом из предыдущего теста файла. Оба
   выглядели работающими.
2. **Прогонять пробу изолированно.** Падение соседнего теста в том же файле маскирует то, что
   проверяемый тест не различает ничего. Запускать по имени (`vitest -t`), а не файлом целиком.

Правило применяется к КАЖДОМУ такому тесту, включая написанные для закрытия предыдущей находки:
в I02A класс «доказательство не доказывает» воспроизвёлся внутри теста, написанного ради его
закрытия, в том же круге — потому что к нему правило применено не было.

Предпочитать ДЕТЕРМИНИРОВАННЫЕ детекторы (инъекция сбоя, проверка состояния после отката)
вероятностным (выборка по времени, гонки, фиксированный `sleep`). Вероятностный детектор
проходит на сломанной реализации ровно тогда, когда она достаточно быстрая или достаточно
медленная.

## 8. CI gates

### На каждом pull request

```text
format:check
lint
boundaries:check
typecheck
test:unit
test:property --runs=100
test:integration
test:contract
test:replay
security:secrets
security:dependencies
security:static
build
test:e2e --project=chromium (после появления UI)
```

`security:dependencies` проверяет frozen lockfile, известные уязвимости и license policy. Exception указывает точный advisory/package, owner, compensating control и expiry; blanket ignore запрещён. Изменение dependency/lockfile получает отдельный review. `security:static` и secret scan блокируют merge по принятой severity policy, но не заменяют threat model и integration tests.

### Nightly

```text
test:property --runs=10000
simulate --seeds=100 --days=7
test:soak
test:e2e --all-browsers
narrative:eval (начиная с I18 и только если менялся optional narrative contour)
mutation:test --changed-critical-packages
```

Release gate дополнительно создаёт и проверяет SBOM, artifact checksums/build provenance, container/IaC scan при наличии этих artifacts, migration current/previous compatibility report и restore/load evidence. Конкретный scanner может меняться без ADR; обязательны воспроизводимая команда, versioned policy и machine-readable result.

Flaky test не перезапускается молча до зелёного. Его seed, timing и environment сохраняются; flaky test блокирует merge либо временно quarantined с issue и сроком.

## 9. Организация AI-assisted разработки

Этот раздел описывает инструменты написания кода, а не runtime-ИИ продукта. Их использование не отменяет запрет на LLM-контур до Gate E.

### Репозиторные инструкции

В корне будущего code repository нужны:

```text
CLAUDE.md
.claude/
  settings.json
  agents/
    contract-steward.md
    acceptance-author.md
    domain-implementer.md
    persistence-implementer.md
    projection-api-implementer.md
    frontend-implementer.md
    test-reviewer.md
    architecture-reviewer.md
    simulation-analyst.md
  skills/
    implement-vertical-slice/
    review-domain-invariants/
docs/
  architecture/
  domain/
  adr/
```

`CLAUDE.md` держать короче 200 строк. В нём только постоянные правила:

- команды package manager и тестов;
- архитектурные границы и запрещённые импорты;
- обязательный Red → Green → Refactor;
- запрет менять тест ради прохождения без объяснения поведения;
- запрет `Date.now`, `Math.random` и LLM в домене;
- ссылки на актуальные спецификации и ADR;
- Definition of Done.

Длинные предметные знания хранятся в versioned docs/skills и загружаются по задаче.

`CLAUDE.md` — контекст модели, а не enforcement boundary. Поэтому будущий repository обязан иметь `.claude/settings.json`, sandbox с `failIfUnavailable` в autonomous/CI harness, deny rules для secrets и protected paths, а также deterministic hooks/CI для проверяемых запретов. Минимальное разделение:

- instructions объясняют архитектуру, команды и stop conditions;
- permissions/sandbox ограничивают filesystem, network и dangerous tools;
- `PreToolUse`/scope hooks блокируют edit protected path, незаявленный network/dependency install и запись вне task write set;
- lint/import rules блокируют запрещённые зависимости, часы/random/network в domain;
- CI повторяет проверки вне агентной сессии и является merge authority.

Hook не должен парсить свободный текст команды хрупкой регуляркой, если тот же контроль можно выразить deny rule, allowlisted command wrapper или сравнением фактического `git diff`. Изменение settings/hooks проходит review как production tooling и имеет tests с allowed/denied fixtures.

### Исчерпание пятичасового usage window

Требование DEV-01 — автоматический checkpoint, ожидание reset и продолжение того же task —
**снято 2026-08-21** решением владельца (ADR-009). Адаптеров usage telemetry, persisted wake и
session resume нет и в этой среде быть не может, а их разработка является инфраструктурой без
отношения к продукту.

Что остаётся в силе:

- исчерпание окна — техническая пауза, а не `complete`, `blocked` и не повод сократить scope,
  ослабить gate или обновить golden;
- обрабатывают паузу человек и внешний runner, а не репозиторий;
- **автопродолжение не обещается ни в каком виде.** Утверждение об автономной работе через
  окно является ложным независимо от того, кто его делает.

Не восстанавливайте протокол как декларацию. Если автономная работа через окно понадобится,
требование вводится заново вместе с реальными адаптерами и собственным acceptance.

### Model routing

Project settings задают Opus для lead:

```json
{
  "model": "opus",
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Lead также можно явно запускать как `claude --model opus`. Не добавлять `CLAUDE_CODE_SUBAGENT_MODEL`: она переопределит модели, указанные в frontmatter всех subagents.

Матрица:

| Роль | Модель | Почему |
|---|---|---|
| Orchestrator/lead | Opus | декомпозиция, зависимости, финальные решения |
| Contract steward | Opus | schema/event решения влияют на все слои |
| Architecture reviewer | Opus | независимая проверка границ и рисков |
| Simulation analyst | Opus | multi-seed интерпретация и решения по балансу |
| Acceptance author | Sonnet | механическая реализация frozen behavior в тесте |
| Domain implementer | Sonnet | TDD-реализация по контракту |
| Persistence implementer | Sonnet | SQL/migrations/repositories по заданному scope |
| Projection/API implementer | Sonnet | adapters и route contracts |
| Frontend implementer | Sonnet | UI по frozen DTO/acceptance |
| Test reviewer | Sonnet | независимая механическая проверка кода и тестов |

Пример implementation subagent:

```markdown
---
name: domain-implementer
description: Implements bounded domain tasks from frozen contracts using TDD
model: sonnet
isolation: worktree
permissionMode: acceptEdits
---

Implement only the assigned write paths. Do not change frozen acceptance tests,
contracts, root configuration, dependencies, or migration ordering.
```

Пример architecture reviewer:

```markdown
---
name: architecture-reviewer
description: Reviews architecture, contracts, determinism, replay and boundaries
model: opus
tools: Read, Glob, Grep, Bash
permissionMode: plan
---

Review only. Report blocker, major and minor findings. Do not edit production code.
```

Aliases `opus`/`sonnet` обновляются Anthropic со временем. `REPORT.md` сохраняет alias и точный resolved model ID каждого агента. Если он изменился посреди итерации, orchestrator повторяет полный review gate.

### Роли

**Orchestrator/lead**:

- уточняет vertical slice и acceptance criteria;
- фиксирует contracts/events до параллельной реализации;
- строит dependency graph задач;
- назначает file ownership;
- интегрирует, запускает полный gate и принимает решения по конфликтам.

Orchestrator — единственная интеграционная точка. Он не пишет feature-код параллельно с исполнителями, не меняет acceptance expectations после начала реализации и один владеет root configs, lockfile, dependency installation и порядком migrations.

**Contract steward**:

- владеет `packages/contracts`, contract docs и schema tests;
- не пишет domain rules, SQL или UI;
- выдаёт `contract_freeze_commit`, после которого consumers могут работать параллельно.

**Acceptance author**:

- владеет `tests/acceptance` и spec fixtures;
- создаёт отдельный падающий commit и фиксирует ожидаемую failure signature;
- не пишет production source.

**Domain implementer**:

- работает только с rules, commands, events, reducers и unit/property tests;
- не добавляет SQL, HTTP и LLM concerns.

**Persistence implementer**:

- реализует migrations, repositories, transactions и outbox по уже принятому contract;
- тестирует настоящий PostgreSQL.

**Projection/API implementer**:

- реализует read models, Fastify routes, SSE и route/contract tests;
- не меняет canonical rules и migrations без отдельной задачи.

**Frontend implementer**:

- использует только `contracts`/API;
- реализует наблюдаемое поведение и accessibility;
- не вычисляет canonical truth в браузере.

**Test reviewer**:

- не переписывает feature целиком;
- ищет пропущенные rejection paths, false-positive tests, boundary cases и нарушение детерминизма;
- работает read-only, временно мутирует/отключает ключевую ветку для проверки силы теста и возвращает конкретные замечания;
- не исправляет production feature тихо: fixes получают отдельную задачу владельца.

**Architecture reviewer**:

- проверяет dependency direction, события, миграции и расхождение со спецификацией;
- запускается перед merge крупных slices, а не на каждую мелочь.

**Simulation analyst**:

- запускает multi-seed, soak, sensitivity и ablation checks;
- выбирает seed до просмотра результатов;
- не меняет rules в том же анализе, в котором оценивает их успешность.

## 10. Когда применять agent teams, subagents и worktrees

Каждая кодовая итерация обязательно использует orchestrator, implementation subagent и независимый reviewer subagent. Acceptance author обязателен для нового observable behavior. Полная agent team не обязательна: она используется только для долгой координации независимых потоков.

- subagent — исследование, review или один ограниченный модуль с кратким отчётом;
- agent team — действительно независимые frontend/backend/review потоки, которым нужно общаться;
- отдельный worktree — каждый поток, меняющий код;
- один агент — последовательный Red/Green внутри одного маленького правила.

Agent teams Claude Code пока экспериментальны и не изолируют изменения автоматически. Поэтому teammates не должны редактировать один файл, migration chain, root config или lockfile одновременно. Для редактирования пересекающихся областей использовать отдельные worktrees и последовательное объединение.

Для маленькой задачи достаточно orchestrator + один implementer subagent + reviewer; не нужно поднимать полную agent team. Требование независимой проверки при этом сохраняется.

## 11. Правильный порядок multi-agent vertical slice

Пример: «оказание помощи создаёт долг».

```text
1. Lead: фиксирует acceptance scenario, event schemas и ownership.
2. Acceptance agent: пишет падающий test отдельным commit в iteration branch.
3. Lead проверяет правильное Red, фиксирует failure signature и contract freeze; в `main` красный commit отдельно не попадает.
4. Domain agent: Red/Green для правил помощи и обязательства, не меняя frozen acceptance paths.
5. Persistence agent: транзакция event + state + outbox.
6. API/frontend agents: параллельно строят projection и отображение.
7. Test reviewer: property/rejection/replay audit.
8. Lead: полный CI gate, causal diff, demo и merge всей зелёной итерации.
```

Не поручать одному агенту «сделать всю механику, API, UI и тесты» без промежуточных контрактов. Большой prompt создаёт широкий, но плохо проверенный diff.

## 12. Формат задачи для агента

```yaml
task_id: I03-T03
goal: Одно наблюдаемое изменение поведения
owner_role: domain-implementer
base_commit: abc123
contract_freeze_commit: def456
depends_on: [I03-T01, I03-T02]
read_paths:
  - packages/contracts/**
write_paths:
  - packages/domain/**
  - packages/simulation/**
protected_paths:
  - tests/acceptance/**
  - packages/contracts/**
acceptance:
  - Given / When / Then
invariants:
  - Что никогда не должно стать возможным
required_red:
  command: pnpm test:acceptance -- journey
  expected_failure: JOURNEY_NOT_IMPLEMENTED
required_green:
  - pnpm test:unit -- journey
  - pnpm test:property -- journey
stop_conditions:
  - contract insufficient
  - write outside ownership required
  - nondeterminism cannot be reproduced
forbidden:
  - change frozen tests
  - install dependencies
  - edit root config
out_of_scope:
  - Явно исключённые функции
```

Задача без observable outcome или с двумя несвязанными целями сначала дробится.

Handoff содержит task ID, base/head SHA, commits, изменённые файлы, Red failure signature, Green commands/output, contracts/migrations, допущения, риски и подтверждение отсутствия изменений вне write set.

Task states:

```text
draft -> ready -> in_progress -> review -> integrated
                     \-> blocked
```

`ready` возможен только после интеграции зависимостей, contract freeze, отсутствия пересечения write sets и понятных stop conditions.

## 12.1 Branch/worktree protocol

```text
main
└── iteration/I03
    ├── task/I03-T01-contract
    ├── task/I03-T02-acceptance
    ├── task/I03-T03-domain
    ├── task/I03-T04-persistence
    └── task/I03-T05-api
```

1. Orchestrator создаёт iteration branch от зелёного `main`.
2. Contract и acceptance задачи выполняются первыми.
3. Orchestrator подтверждает ожидаемое Red и фиксирует `contract_freeze_commit`.
4. Implementation worktrees создаются от freeze commit.
5. Subagent не выполняет merge/rebase/push; он возвращает логические commits и handoff.
6. Orchestrator интегрирует в dependency order.
7. Семантический конфликт возвращается владельцу с новым base commit; lead не склеивает behavior вслепую.
8. После reviews, полного gate и ручного demo iteration branch сливается в `main`.

Protected paths проверяются hooks/CI через declared write set. Feature agents не устанавливают dependencies, не меняют CI/root configs и не используют network без отдельного разрешения orchestrator-а.

## 12.2 Защита TDD

Запрещены без отдельного change request:

- изменение frozen acceptance expectations;
- `.skip`, `.only` и unconditional retry;
- снижение property run count или coverage threshold;
- обновление golden/snapshot без causal explanation;
- mock тестируемого behavior вместо внешнего порта;
- удаление/ослабление существующего assertion.

Reviewer проверяет силу теста временной мутацией ключевой ветки. Findings имеют уровни:

- `blocker` — invariant, determinism, replay, data integrity или boundary;
- `major` — отсутствует acceptance/rejection/idempotency проверка;
- `minor` — локальное качество без риска behavior.

Merge разрешён при нуле blocker/major. Minor переносится только как зафиксированная задача.

## 13. Definition of Done

Vertical slice готов только если:

- acceptance criteria представлены исполняемыми тестами;
- тест наблюдался падающим до реализации;
- happy path и отказ описаны доменными событиями;
- новые коэффициенты вынесены в versioned ruleset;
- event/API schemas versioned и runtime-валидируются;
- replay и idempotency не нарушены;
- миграция имеет forward test на пустой и существующей БД;
- migration report подтверждает lock/time budget, idempotent retry и current/previous application compatibility; destructive contract отделён от expand release;
- нет новых прямых часов, случайности, network или env в домене;
- canonical numeric units/rounding, serialization и rules/content/schema bundle checksums определены для новых полей;
- threat-model delta рассмотрена при изменении trust boundary/auth/upload/parser/external integration;
- новые production dependencies прошли purpose/license/security review; secret/dependency/static gates зелёные;
- документация/ADR обновлены при изменении решения;
- полный обязательный gate зелёный;
- независимый reviewer не нашёл blocker;
- diff ограничен заявленным scope.

## 14. Порядок implementation

Полная последовательность маленьких проверяемых срезов, обязательные orchestrator/subagent роли, demo и GO/REWORK/SPLIT/STOP gates определены в [[10_ITERATION_MASTER_PLAN]]. Этот workflow задаёт способ работы, а master-plan — порядок задач. Новая итерация не начинается автоматически после merge предыдущей.

## Источники по Claude Code

- [Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Parallel agents and worktrees](https://code.claude.com/docs/en/agents)
- [Custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code extension model](https://code.claude.com/docs/en/features-overview)
- [Claude Code project memory / `CLAUDE.md`](https://code.claude.com/docs/en/memory)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)
