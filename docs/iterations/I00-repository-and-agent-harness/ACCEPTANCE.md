# I00 — ACCEPTANCE

Все пункты исполняемы одной командой `pnpm verify` (плюс отдельные команды demo). Каждый пункт указывает requirement ID.

## A1. Единый gate воспроизводим (DEV-02, OPS-03)

**Given** чистый clone репозитория и Node 24 из `.nvmrc`  
**When** выполняется `pnpm install --frozen-lockfile && pnpm verify`  
**Then** последовательно проходят `format:check`, `lint`, `boundaries:check`, `typecheck`, `test:unit`, `test:property`, `test:contract`, `security:secrets`, `security:dependencies`, `security:licenses`, `security:static`, `build`, и команда завершается кодом 0.

## A2. Import boundaries исполняются инструментом (DEV-02, SIM-01)

**Given** пакет `packages/domain`  
**When** в нём появляется импорт `kysely`, `fastify`, `pg` или вызов `Date.now()`/`Math.random()`/`process.env`  
**Then** `pnpm boundaries:check` или `pnpm lint` завершается ошибкой с указанием файла и правила.

Проверка: fixture-тесты `tools/agent-harness` прогоняют запрещённые и разрешённые примеры.

## A3. Protected-path hook блокирует запись (DEV-02)

**Given** `.claude/writeset.json` объявляет write paths задачи  
**When** PreToolUse hook получает запись в `pnpm-lock.yaml`, `.claude/settings.json`, `tests/acceptance/**` или вне declared write set  
**Then** hook возвращает deny с причиной; при записи внутри declared write set — allow.

Проверка: `pnpm test:unit --project hooks` с allowed/denied fixtures.

## A4. Write-set hook сверяет фактический diff (DEV-02)

**Given** завершение subagent/task  
**When** `git diff --name-only` содержит путь вне declared write set  
**Then** hook сообщает нарушение и блокирует завершение задачи.

## A5. Integration smoke на настоящем PostgreSQL (OPS-01 подготовка)

**Given** запущенный Docker daemon  
**When** выполняется `pnpm test:integration`  
**Then** Testcontainers поднимает один PostgreSQL/PostGIS контейнер, migration runner применяет baseline-миграцию на пустой БД, повторный запуск идемпотентен, контейнер останавливается.

## A6. Health route и пустые процессы (OPS-03)

**Given** собранный `apps/api`  
**When** выполняется `GET /health` через `fastify.inject`  
**Then** ответ 200 с `status`, `deployment_id`, `schema_version`, `rules_version`, без секретов; `apps/worker` стартует и корректно завершает graceful shutdown; `apps/cli` печатает список команд и завершает код 0.

## ~~A7, A8, A9~~ — сняты вместе с требованием DEV-01

Три критерия проверяли checkpoint, wait/auto-resume и честную фиксацию отсутствующей
capability. Требование DEV-01 снято 2026-08-21 решением владельца (ADR-009), механика удалена
вместе с `tools/usage-continuity`, команды `pnpm continuity:dry-run` и
`pnpm continuity:capability-check` больше не существуют.

Критерии сняты, а не помечены выполненными: они проверяли поведение, которого в репозитории
больше нет. Итерация оценивается без них.

Основание снятия замороженного acceptance — решение владельца, зафиксированное отдельным ADR,
а не удобство при сдаче. Найдено верификацией раунда I00-F5 как N-M3: ADR-009 снял требование
в коде, но оставил его в нормативных документах, из-за чего итерацию нельзя было принять
против её собственного acceptance.

## A10. Security policy machine-readable (OPS-03)

**Given** `security/policy.json` и `security/exceptions.json`  
**When** выполняется `pnpm security:dependencies` / `security:licenses`  
**Then** результат машиночитаем (JSON), а любое исключение без `owner`, `scope`, `compensating_control`, `expiry` или с истёкшим `expiry` завершает проверку ошибкой; blanket allowlist невозможен.

## A11. Runtime LLM отсутствует (NAR-02, ADR-006)

**Given** `pnpm-lock.yaml` и исходники  
**When** выполняется `pnpm security:no-llm`  
**Then** проверка подтверждает отсутствие provider SDK, ключей, prompt-каталогов и generation queues; появление любого из них блокирует gate до Gate E.

## Ручной demo

1. Новая Claude session читает `CLAUDE.md`, находит команды, создаёт намеренно падающий тест и чинит маленькую test fixture, не нарушая boundaries.
2. Accelerated dry-run прерывает работу на fake 1%, показывает persisted checkpoint и автоматически продолжает тот же шаг после fake reset.
3. Попытка записи в `pnpm-lock.yaml` из subagent-сессии отклоняется hook-ом.

## GO / REWORK / STOP

- **GO:** gate воспроизводим локально и в CI; один PostgreSQL container поднимается и останавливается; agent definitions доступны; критичные ограничения подтверждены deny/hook/lint/CI-тестами; auto-resume dry-run сохраняет task/branch/HEAD/diff/test state.
- **REWORK:** flaky bootstrap, неявные глобальные зависимости, domain импортирует adapter.
- **STOP:** runner обещает автопродолжение без telemetry/persisted wake/session resume либо теряет/дублирует работу на reset.
