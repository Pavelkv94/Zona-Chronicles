# Claude Code instructions

Этот workspace — нормативная design/implementation documentation проекта «Живая Зона», а не исполняемый code repository. Перед изменением scope полностью прочитать `AGENTS.md`, `00_README.md` и перечисленные там нормативные документы. Не отмечать implementation backlog выполненным без кода и test evidence из будущего репозитория.

Этот файл не является гарантией качества и не считается acceptance evidence: он задаёт контекст модели, а не исполняемый control. Качество принимается только по requirement IDs, Red/Green output, CI/replay/invariant evidence, независимому review и решению gate из `10_ITERATION_MASTER_PLAN.md`. Критичные ограничения будущего code repository обязаны дублироваться permissions/sandbox/hooks, lint/import rules, DB grants/constraints и CI по ADR-008; ответ агента «правило соблюдено» доказательством не является.

Постоянные правила:

- пользователь только наблюдает canonical world;
- replay/resimulation детерминированы для одинаковых snapshot/seed, immutable rules/content/schema bundles и qualified runtime profile;
- fact, claim, observer signal и representation не смешиваются;
- до Gate E запрещены runtime LLM SDK, provider keys/accounts, prompts, embeddings, generation queues и model-specific persistence;
- документы проекта писать по-русски; technical identifiers могут быть английскими;
- до письменного IP-разрешения использовать только оригинальный/нейтральный контент;
- менять product/spec до contracts/plan/backlog и сохранять Obsidian wiki links.

Перед правкой назвать observable behavior и requirement ID из `11_REQUIREMENTS_TRACEABILITY.md`. Если новый behavior не имеет ID, сначала обновить нормативный source и traceability, затем downstream contracts/ADR/plan/backlog. Не ослаблять threshold/test/gate ради зелёного статуса; любое исключение имеет точную область, owner, причину и expiry.

Для изменений architecture/security/determinism дополнительно проверить ADR-008 и разделы 7/11–12 `03_TECHNICAL_DESIGN.md`: observer snapshot не равен canonical snapshot; runtime/serialization/rules-content bundles входят в deterministic profile; admin/worker/migration/query roles разделены; release требует migration/restore/security evidence.

## Обязательное продолжение после пятичасового usage limit

Пятичасовое usage window Anthropic не является завершением задачи, `blocked` или поводом сокращать acceptance scope.

1. Использовать только provider/platform telemetry пятичасового окна; не путать её с context window или token estimate.
2. При остатке `<= 2%` не начинать новый subtask, merge, migration или долгий test. Обновить `.claude/checkpoints/<task-id>.md`.
3. При остатке `<= 1%` завершить только безопасный checkpoint и остановить новые model calls до reset. Не объявлять задачу завершённой.
4. Checkpoint обязан содержать objective, iteration/task ID, plan status, branch/worktree, base/HEAD SHA, dirty/changed files, свои commits, последний Red/Green output, незавершённые commands/processes, решения/риски и одну точную следующую команду/проверку.
5. Orchestrator/runner обязан поставить внешний wake/resume на reported reset time + safety margin. Ожидание выполняется harness-ом без расхода model calls; нельзя держать активный ответ в busy-wait.
6. После reset автоматически возобновить тот же task/session из checkpoint, сначала сверить branch/HEAD/diff/process state и повторить последний незавершённый test, затем продолжить план.
7. Нельзя во время checkpoint делать merge/push, скрытый `stash`, destructive reset, ослаблять тесты или создавать видимость завершения.
8. Если среда не предоставляет telemetry, scheduled wake или session resume, записать `LIMIT_AUTOCONTINUE_UNAVAILABLE` в checkpoint и вернуть управление внешнему orchestrator-у. Для автономного workflow это blocker I00: нельзя обещать автоматическое продолжение, пока harness не реализован и не прошёл dry-run.

Точный protocol и acceptance описаны в разделе «Непрерывность при пятичасовом usage window» файла `08_TDD_AND_AGENT_WORKFLOW.md` и в I00 `10_ITERATION_MASTER_PLAN.md`.
