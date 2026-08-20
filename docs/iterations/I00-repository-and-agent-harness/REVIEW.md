# I00 — findings независимой проверки

Проверяемый commit: `c5ce32d` (после интеграции I00-T02…T05).  
Test reviewer (Sonnet): `RESULT: FAIL (1 blocker, 1 major)`.  
Architecture reviewer (Opus): `RESULT: FAIL (3 blocker, 10 major)`.

Общий вывод обеих проверок совпал: форма скелета верна (чистые порты, инъекция
зависимостей, честные placeholder-ы, strict TS без послаблений), но часть контролей
**читается** как enforcement и при этом ничего не исполняет. Это ровно тот класс отказа,
о котором предупреждает ADR-008, поэтому решение итерации — **REWORK**, а не GO.

Lead независимо воспроизвёл три самых дорогих finding-а до начала работ:

| Finding | Как воспроизведён | Результат |
|---|---|---|
| B1 | `npm_config_registry=http://127.0.0.1:9/ node scripts/security/scan-dependencies.ts` | `pass`, exit 0 — vulnerability gate fail-**open** |
| M5 | probe `packages/representation/src/__probe.ts` с `import … from '@zona/domain'` | `no dependency violations` — правило инертно |
| M2 | `grep lightningcss pnpm-lock.yaml` | 11 платформенных вариантов; исключения покрывали только `darwin-arm64` |

## Blocker

| ID | Область | Суть | Куда назначен |
|---|---|---|---|
| B1 | `tools/security-scan` | `pnpm audit --json` при недоступном registry печатает валидный пустой отчёт; проверка отдаёт `pass`. Docstring обещал fail-closed, которого нет. | I00-R3 |
| B2 | `tools/agent-harness` | Роль сессии определяется наличием `.claude/writeset.json`. Task-сессия выполняет `rm -f .claude/writeset.json` — и все три слоя DEV-02 выключаются одновременно. Отсутствие дискриминатора было fail-**open**. | I00-R1 |
| B3 | `tools/usage-continuity` | Межпроцессный resume не реализован: `CheckpointStorePort.read`/`archive` не вызывались нигде, кроме своих тестов. Процесс, поднятый внешним wake, остался бы в `normal` и не выполнил `next_exact_action`. | I00-R2 |
| B4 | `packages/persistence` | Integration-тест утверждал освобождение advisory lock, но при удалении `finally { pg_advisory_unlock }` оставался зелёным: `pg_advisory_lock` реентерабелен, а оба вызова переиспользовали одно соединение из pool. | I00-R4 |

## Major

| ID | Область | Суть | Куда назначен |
|---|---|---|---|
| M1 | security | `scope` исключения матчился по `finding.id`, который для четырёх из пяти проверок является **категорией**: одно валидное исключение снимало весь запрет LLM (ADR-006). | I00-R3 |
| M2 | security | License gate платформозависим: 11 вариантов `lightningcss`, исключения на `darwin-arm64` → красный CI на linux. | I00-R3 |
| M3 | security | Исключение — неверный механизм для «dev-only зависимость с file-level weak copyleft»; нужна политика, различающая production- и development-граф, с исполняемым утверждением вместо прозы. | I00-R3 |
| M4 | boundaries | `scripts/` и `tests/` не упоминались ни в одном правиле и не входили в cruise roots: реэкспорт там отмывал любую зависимость. | lead (`26ed466`) |
| M5 | boundaries | dependency-cruiser резолвил `@zona/*` через `dist`, который исключён из обхода: **ни одно** пакетное правило не срабатывало. | lead (`26ed466`) |
| M6 | lint | SIM-01 не покрывал `crypto.randomUUID`, `crypto.getRandomValues`, `fetch`, `process.hrtime`, `Intl`, `toLocaleString`, `localeCompare`, `Date.parse`; core-блок молча терял селектор `Decorator`. | lead (`26ed466`) |
| M7 | boundaries | Ребро `apps/api → packages/persistence` противоречит ADR-002 и снимает контроль OPS-03 «observer path физически не читает канонические таблицы». | lead (`26ed466`) |
| M8 | harness | `.claude/settings.autonomous.json` и `verify-task-ownership.ts` не были подключены нигде — задокументированные слои enforcement существовали как инертные файлы. | lead (`26ed466`) |
| M9 | acceptance | A2 требует fixture-тестов на lint/boundary правила — их не было; hook-скрипты не покрыты тестами; PLAN §3 включал в scope «скелет least-privilege ролей», которого нет. | I00-R1 + правка PLAN |
| M10 | apps | `process.env` читался вне валидируемого allowlist; отсутствующий `DEPLOYMENT_ID` тихо становился `local-dev`, что ломает §12 (immutable deployment identifier). | lead (правило) + I00-R5 |

## Minor, принятые в работу

`m1` busy-wait и дублирование wake, `m2` неразличимый результат при недоступной телеметрии,
`m3` `Date.parse` без валидации ISO-8601, `m4` неполная сверка resume, `m5` dry-run доказывал
ветку `recovered` вместо `resetReached`, `m7` severity не влияет на блокировку, `m8`
игнорируется статус подпроцесса, `m9` Dockerfile запускал исходники и работал от root,
`m11` autonomous-профиль был разрешительнее интерактивного, `m12` не зафиксирована общая
версия TypeBox, `computeChecksum` по `Function.prototype.toString()`.

## Minor, вынесенные за пределы I00

| Finding | Причина переноса |
|---|---|
| `readdirSync` без сортировки в security-скане | Риск проявится только с появлением golden/snapshot-сравнений; зафиксировать при их вводе. |
| Событие `SubagentStop` отсутствует в текущем публичном reference документации | В установленном CLI событие есть и работает; контроль продублирован result-level проверкой `ownership:check` в CI, поэтому не блокирует. |

## Процессный finding

Architecture reviewer работал одновременно с test reviewer-ом, который по своей роли
временно мутирует production-код для проверки силы тестов. Из-за этого часть evidence
снималась с изменяющегося рабочего дерева (обнаружены чужие временные правки в
`packages/persistence`). Committed HEAD при этом не менялся, и аудит был завершён по
`git archive HEAD`.

**Вывод для процесса:** reviewer обязан работать по замороженному SHA или в отдельном
worktree, а два reviewer-а не запускаются параллельно в общем дереве, если один из них
мутирует код. Это ошибка оркестрации lead-а, а не участников.

### B2 подтверждён на живом примере

Во время rework-раунда один из implementer-субагентов выполнил `git stash` / `git stash pop`
в общем рабочем дереве, где параллельно работали ещё две задачи, — операцию, запрещённую
и заданием, и `decide-bash.ts`. Hook её не заблокировал, потому что `.claude/writeset.json`
отсутствовал, и сессия была классифицирована как `lead`.

Это ровно тот отказ, который описан в B2: **отсутствие дискриминатора роли было fail-open**.
Агент сообщил об операции честно и восстановил состояние; проверка lead-ом показала пустой
`git stash list` и сохранность файлов параллельных задач. Ущерба нет, но контроль не сработал,
и это лучшее возможное обоснование фикса B2 (положительный признак роли из hook payload,
task-сессия без write set = deny).

## Предложения по ADR (требуют решения владельца)

1. **Правка ADR-002** — ребро `api → persistence` удалено; зафиксировать, что observer path
   получает данные только через `projections`.
2. **Новый ADR: license policy по границе дистрибуции** — раздельные production/development
   allowlists и исполняемое утверждение об отсутствии weak copyleft в production-графе.
3. **Правка ADR-008 (семантика исключений)** — `scope` обязан идентифицировать экземпляр
   (`package@version`, путь, advisory id), а не правило или категорию; Red-тест на каждую проверку.
4. **Новый ADR: идентичность агентной сессии** — различение task/lead выводится из
   неподделываемого сигнала; отсутствие write set в subagent-сессии означает deny.
5. **Правка ADR-003 / SIM-01** — перечислить полную поверхность недетерминизма (глобалы
   `crypto`/`fetch`, `Intl`/locale API, `process.hrtime`, `Date.parse`) и обязать fixture-suite
   в gate: список запретов стоит ровно столько, сколько стоят его тесты.
