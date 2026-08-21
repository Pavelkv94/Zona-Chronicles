# Claude Code instructions — «Живая Зона»

Этот репозиторий содержит нормативную документацию (`docs/`) **и** исполняемый код прототипа.
Этот файл — контекст модели, а не security boundary и не acceptance evidence. Доказательством
являются requirement IDs, Red/Green output, CI/replay/invariant evidence, независимый review и
решение gate из [10_ITERATION_MASTER_PLAN](docs/10_ITERATION_MASTER_PLAN.md). Критичные
ограничения дублируются permissions/hooks (`.claude/`), lint/import rules, DB grants и CI (ADR-008).

## Команды

| Задача              | Команда                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| Установка (frozen)  | `pnpm install --frozen-lockfile`                                                                          |
| Полный быстрый gate | `pnpm verify`                                                                                             |
| Полный gate с БД    | `pnpm verify:full` (нужен запущенный Docker)                                                              |
| Формат / lint       | `pnpm format:check`, `pnpm lint`                                                                          |
| Границы пакетов     | `pnpm boundaries:check`                                                                                   |
| Типы                | `pnpm typecheck`                                                                                          |
| Тесты               | `pnpm test:unit`, `pnpm test:property`, `pnpm test:contract`, `pnpm test:integration`, `pnpm test:replay` |
| Security            | `pnpm security:all`                                                                                       |
| Локальная БД        | `docker compose up -d postgres`                                                                           |

Node фиксирован в `.nvmrc` (24.x), package manager — в поле `packageManager`.

## Архитектурные границы (ADR-002, ADR-003)

```text
contracts <- domain <- simulation
     ^          ^           ^
 api/web   persistence   worker/cli
     ^          ^           |
     └──── projections <────┘
representation -> contracts + read-only projections
```

- `packages/domain` и `packages/simulation` не импортируют Fastify, Kysely, `pg`, сеть,
  файловую систему, `process.env`, `Date.now()`, `Math.random()`, `new Date()`;
  время, случайность, ID и коэффициенты приходят через порты `Clock`, `RandomSource`,
  `IdFactory`, `Ruleset`;
- `packages/contracts` не импортирует внутренние пакеты приложения;
- `packages/content` — данные, не логика; `tools/**` — dev harness, продукт от него не зависит;
- публичный API read-only; observer path не читает канонические таблицы.

Границы исполняются `pnpm boundaries:check` и `pnpm lint`, а не доверием.

## Постоянные правила продукта

- пользователь только наблюдает canonical world; публичные API не управляют миром;
- canonical state меняется только валидированными командами/событиями;
- replay детерминирован для одинаковых snapshot/seed, immutable rules/content/schema bundles
  и qualified runtime profile;
- fact, knowledge claim, observer signal и representation — разные слои (ADR-005);
  текст никогда не является источником факта;
- знание не появляется без provenance;
- до Gate E запрещены runtime LLM SDK, provider keys, prompts, embeddings, generation queues
  и model-specific persistence (ADR-006);
- до письменного IP-разрешения — только оригинальный/нейтральный контент;
- документы проекта пишутся по-русски; technical identifiers могут быть английскими.

## Обязательный рабочий цикл

1. Назвать наблюдаемое поведение и requirement ID из
   [11_REQUIREMENTS_TRACEABILITY](docs/11_REQUIREMENTS_TRACEABILITY.md).
   Нет ID — сначала обновить нормативный источник и трассировку.
2. Заморозить contracts и file ownership.
3. **Red** — маленький тест падает по ожидаемой причине (записать точный вывод).
4. **Green** — минимальная реализация без будущих абстракций.
5. **Refactor** — убрать дублирование при зелёных тестах.
6. Независимый review; затем полный gate и решение итерации.

Запрещено без отдельного change request: менять замороженные acceptance-ожидания, использовать
`.skip`/`.only`/retry, снижать property runs или coverage, обновлять golden без причинного
объяснения, мокать тестируемое поведение, удалять или ослаблять существующие assertions.

Тест меняется только вместе с объяснением изменившегося поведения в `PLAN.md` итерации —
никогда ради зелёного статуса.

## Роли и владение

Orchestrator/lead владеет: iteration plan, contracts до freeze, root configs, `pnpm-lock.yaml`,
установкой зависимостей, порядком миграций, назначением write paths, интеграцией веток и
финальным gate. Реализация делегируется subagents из `.claude/agents/` (Sonnet), архитектурные
и контрактные роли — Opus (ADR-007). Implementer не принимает собственную работу.

Задача субагента объявляет write set в `.claude/writeset.json` (см. `.claude/templates/`).
Записи вне него и в protected paths блокируются hook-ами; при завершении задачи фактический
`git diff` сверяется с write set.

## Definition of Done

Полный список — §13 [08_TDD_AND_AGENT_WORKFLOW](docs/08_TDD_AND_AGENT_WORKFLOW.md). Минимум:
acceptance-критерии исполняемы, тест наблюдался красным, happy path и отказ выражены событиями,
коэффициенты в versioned ruleset, схемы версионированы и валидируются в runtime, replay и
идемпотентность не нарушены, миграция протестирована на пустой и существующей БД, новых часов/
случайности/сети/env в домене нет, документация/ADR обновлены, полный gate зелёный, независимый
reviewer не нашёл blocker, diff ограничен заявленным scope.

## Исчерпание usage window

Исчерпание пятичасового окна — техническая пауза, а не `complete`, `blocked` или повод
сократить scope. Но обрабатывают её человек и внешний runner: **репозиторий не обещает
автопродолжения** и не содержит механики checkpoint/resume.

Требование DEV-01 снято 2026-08-21 решением владельца (ADR-009): адаптеров usage telemetry,
persisted wake и session resume нет и в этой среде быть не может, а их разработка — это
инфраструктура без отношения к продукту. Не восстанавливайте протокол как декларацию: если
автономная работа через окно понадобится, требование вводится заново вместе с адаптерами.

## Профиль для unattended-прогонов

`.claude/settings.autonomous.json` ужесточает права (sandbox с `failIfUnavailable`, запрет
установки зависимостей и операций интеграции истории, сетевой allowlist). Он **не применяется
автоматически** — только при явном запуске:

```sh
claude --settings .claude/settings.autonomous.json
```

Основные контроли от него не зависят: границы, владение путями и security-проверки исполняются
hook-ами, lint-ом и CI в каждом прогоне (ADR-008).

## Что читать перед изменением scope

`docs/00_README.md` (приоритет документов), `docs/07_MVP_MECHANICS_SPEC.md`,
`docs/09_EVENT_AND_COMMAND_CONTRACTS.md`, `docs/06_ARCHITECTURE_DECISIONS.md`,
`docs/10_ITERATION_MASTER_PLAN.md`, `docs/11_REQUIREMENTS_TRACEABILITY.md`,
`docs/13_WORLD_SYSTEMS_SPEC.md`. При конфликте действует приоритет из `00_README.md`.
