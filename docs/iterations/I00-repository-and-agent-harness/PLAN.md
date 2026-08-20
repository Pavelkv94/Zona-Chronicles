# I00 — Repository и agent harness: PLAN

Итерация: I00  
Ветка: `iteration/I00-harness`  
Base commit: `b85b878`  
Дата старта: 2026-08-20  
Статус: in_progress

## 1. Гипотеза

Claude Code agents могут безопасно работать в репозитории с быстрым единым gate: критичные запреты исполняются permissions/hooks/lint/CI, а не послушанием модели, и прерывание пятичасового usage window не теряет и не дублирует работу.

## 2. Observable demo

1. Чистый clone выполняет один документированный gate command и получает зелёный результат.
2. Hook fixtures блокируют запись в protected path и вне declared write set, но пропускают заявленные операции.
3. Fake usage telemetry проводит runner через `2% → checkpoint_only → 1% → wait → reset → resume` без повторного ручного prompt и без дублирования шага.

## 3. Требования (`11_REQUIREMENTS_TRACEABILITY`)

| ID     | Что доказываем в I00                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| DEV-01 | persisted checkpoint + injected telemetry + wake/resume dry-run `2% → 1% → reset`                              |
| DEV-02 | permissions/sandbox/hooks/lint/CI исполняют запреты вне model instructions                                     |
| OPS-03 | скелет least-privilege ролей, secret/dependency/license/static scan и machine-readable policy/exception формат |
| SIM-01 | подготовка: `no-restricted-*` запрет `Date.now`/`Math.random`/`process.env` в `domain`/`simulation`            |

I00 не объявляет production readiness (ADR-008): release-gate evidence принадлежит I17.

## 4. Scope

- pnpm workspaces + Turborepo, pinned Node 24 и `packageManager`;
- strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`), ESM, без `enum`/namespaces/decorators;
- ESLint flat config + Prettier + dependency-cruiser import boundaries по ADR-002;
- `CLAUDE.md` (< 200 строк), `.claude/agents/*`, task/iteration templates;
- `.claude/settings.json`: deny/ask permissions, fail-closed sandbox профиль, protected-path и write-set hooks с тестами;
- Vitest projects (unit/property/integration/contract/replay), fast-check, Testcontainers;
- Fastify health route, migration runner, пустой worker и CLI;
- Docker Compose (`api`, `worker`, `postgres`) и provider-neutral CI commands;
- frozen install, secret/dependency/license/static scan skeleton, machine-readable policy и exception формат с owner/expiry;
- usage-window monitor **port**, persisted checkpoint, external wake/resume harness без hard-coded provider UI parsing.

## 5. Out of scope

- Next.js observer UI (I03), доменные события и schemas (I01), реальные миграции мира (I02A);
- production hosting, SLO/restore drill, SBOM signing (I17);
- любые LLM SDK, ключи, prompts (запрещены до Gate E).

## 6. Frozen contracts итерации

I00 не вводит command/event/API contracts. Замораживаются tooling-контракты:

- имена gate-скриптов (`format:check`, `lint`, `boundaries:check`, `typecheck`, `test:*`, `security:*`, `build`, `verify`);
- формат `.claude/writeset.json` (declared write set задачи);
- формат `.claude/checkpoints/<task-id>.md`;
- формат `security/policy.json` и `security/exceptions.json` (owner + expiry обязательны);
- порт `UsageTelemetryPort` и state machine continuity runner.

Contract freeze commit фиксируется lead-ом до старта implementation subagents.

## 7. Task graph и file ownership

| Task    | Роль                    | Write paths                                                                       | Зависит от |
| ------- | ----------------------- | --------------------------------------------------------------------------------- | ---------- |
| I00-T01 | orchestrator/lead       | root configs, `.claude/**`, `packages/*/package.json`, `docs/iterations/I00-*/**` | —          |
| I00-T02 | tooling-implementer     | `tools/usage-continuity/**`                                                       | T01        |
| I00-T03 | tooling-implementer     | `apps/api/**`, `apps/worker/**`, `apps/cli/**`                                    | T01        |
| I00-T04 | persistence-implementer | `packages/persistence/**`                                                         | T01        |
| I00-T05 | tooling-implementer     | `security/**`, `scripts/security/**`                                              | T01        |
| I00-T06 | test-reviewer           | нет write paths (findings only)                                                   | T02–T05    |
| I00-T07 | architecture-reviewer   | нет write paths (findings only)                                                   | T02–T05    |

Protected paths для всех implementer-задач: `pnpm-lock.yaml`, root configs, `.claude/**`, `docs/**`, чужие write paths.

## 8. Отклонения от нормативного процесса

- **Worktree isolation.** Implementer subagents работают в основном worktree с непересекающимися write paths вместо отдельных git worktrees: свежий worktree не имеет `node_modules`, а установка зависимостей запрещена feature-агентам. Компенсирующие controls: непересекающиеся write sets, запрет git-операций для subagents, write-set hook и lead-only интеграция. Зафиксировать в `REPORT.md`; пересмотреть, когда появится общий store/`node_modules` bootstrap без установки агентом.

## 9. Stop conditions

- flaky bootstrap или неявная глобальная зависимость;
- domain может импортировать adapter;
- runner обещает автоматическое продолжение без telemetry/persisted wake/session resume → записать `LIMIT_AUTOCONTINUE_UNAVAILABLE` и вернуть blocker I00.
