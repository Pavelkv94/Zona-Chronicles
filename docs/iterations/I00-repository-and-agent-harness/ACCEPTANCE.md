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

## A7. Usage-window continuity: checkpoint (DEV-01)

**Given** injected telemetry с остатком 2%  
**When** continuity runner получает telemetry  
**Then** состояние переходит в `checkpoint_only`, новый task/merge/долгий test не начинается, а `.claude/checkpoints/<task-id>.md` содержит все обязательные поля (`task_id`, `iteration_id`, `objective`, `plan_status`, `branch`, `worktree`, `base_sha`, `head_sha`, `changed_files`, `dirty_files`, `own_commits`, `last_red`, `last_green`, `unfinished_processes`, `decisions`, `risks`, `next_exact_action`, `usage_window_remaining_percent`, `reported_reset_at`, `checkpointed_at`).

## A8. Usage-window continuity: wait и auto-resume (DEV-01)

**Given** injected telemetry последовательности `5% → 2% → 1% → reset`  
**When** выполняется `pnpm continuity:dry-run`  
**Then** переходы `normal → checkpoint_only → waiting_for_usage_reset → validating_resume → in_progress` происходят в этом порядке; после `<= 1%` не выполняется ни одного нового model call/subagent/install/merge; persisted wake ставится на `reported_reset_at + safety_margin`; после reset выполняется ровно один повтор `next_exact_action` без дублирования команды или commit.

## A9. Отсутствие capability фиксируется, а не обещается (DEV-01)

**Given** окружение без telemetry, persisted wake или session resume  
**When** continuity runner инициализируется  
**Then** он записывает `LIMIT_AUTOCONTINUE_UNAVAILABLE` в checkpoint, возвращает non-zero статус capability-check и не заявляет автоматическое продолжение.

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
