# I00 — REPORT

Итерация: I00 «Repository и agent harness»
Ветка: `iteration/I00-harness`
Коммиты: `bcfb8cf` → `c5ce32d` → `26ed466` → `789a8d5` → `b247f42`
Дата: 2026-08-20 — 2026-08-21
Статус: **REWORK — верификация раунда 3 дала FAIL**

## 1. Что впервые стало возможным наблюдать

Мир ещё не симулируется. Наблюдаемым результатом I00 является то, что **запрет можно
проверить, а не только объявить**:

1. Чистый clone одной документированной командой (`pnpm verify`) проходит формат, lint,
   границы пакетов, типы, unit/property/contract тесты, пять security-проверок и build.
2. Попытка нарушить архитектурную границу немедленно краснеет: `pg` в `packages/simulation`,
   `@fastify/*` в `packages/domain`, импорт LLM SDK где угодно, `packages/** → scripts/**`,
   `apps/api → packages/persistence`, `representation → domain` — каждое ловится и eslint,
   и dependency-cruiser, а не соглашением.
3. Task-сессия агента не может расширить себе права: удаление или подмена
   `.claude/writeset.json` не работает, потому что write set читается из git-объекта, а не
   из рабочего дерева.
4. Migration runner применяет baseline к настоящему PostgreSQL/PostGIS, повторный запуск
   идемпотентен, порча checksum запрещает применять что-либо, advisory lock освобождается —
   и это доказано из независимой сессии, а не утверждено комментарием.
5. Прерывание работы по пятичасовому окну проходит `2% → checkpoint_only → 1% → wait →
   reset → resume` через **пять отдельных процессов**, обменивающихся только файлом
   checkpoint, и `next_exact_action` исполняется ровно один раз.

## 2. Какой тест был красным до реализации

Каждая задача вела собственный Red → Green и приводила точный вывод. Наиболее ценные Red
получены не на старте, а на review: они показывали, что **контроль не работает**.

| Что | Red | Green |
|---|---|---|
| `security:dependencies` при недоступном registry | `pass`, exit 0 (fail-open) | exit 2 |
| Правила dependency-cruiser для `@zona/*` | `no dependency violations` на запрещённом ребре | 5 правил срабатывают на 5 пробах |
| SIM-01 lint | файл с `crypto.randomUUID`, `fetch`, `Intl`, `localeCompare`, `Date.parse` — 0 ошибок | 15 ошибок; `new Date(iso)` остаётся легальным |
| Освобождение advisory lock | удаление `finally` не красит ни одного теста | удаление красит 3 теста |
| Write-set harness | `rm -f .claude/writeset.json` → hook exit 0 | exit 2 |
| Подмена write set | `cat > .claude/writeset.json` → allow, затем exit 0 | deny, а подделка невидима: чтение из git-объекта |
| Checksum миграции | DDL внутри `up()` мимо `statements` — 331 тест зелёный | поле `up` удалено из контракта: compile error |
| `parseInstant` | `"March 1, 2026"`, `2026-02-30` принимаются | отклоняются |

## 3. Автоматические gates

| Gate | Команда | Результат |
|---|---|---|
| Формат | `pnpm format:check` | 0 |
| Lint | `pnpm lint` | 0 |
| Границы | `pnpm boundaries:check` | 0 |
| Типы | `pnpm typecheck` | 0 |
| Unit + hooks | `pnpm test:unit` | 0 — 443 теста в 40 файлах (из них 195 в проекте `hooks`) |
| Property | `pnpm test:property` | 0 |
| Contract | `pnpm test:contract` | 0 — 6 |
| Integration | `pnpm test:integration` | 0 — 4 на настоящем PostGIS |
| Replay | `pnpm test:replay` | 0 — набор пуст до I02B, флаг стоит в месте вызова |
| Security ×5 | `pnpm security:*` | 0 |
| Build | `pnpm build` | 0 |
| DEV-01 demo | `pnpm continuity:dry-run` | 0 |
| DEV-01 capability | `pnpm continuity:capability-check` | **1 — так и должно быть** |
| DEV-02 владение | `pnpm ownership:check .claude/tasks/I00.json 789a8d5` | 0 |
| Fail-closed проба | `npm_config_registry=http://127.0.0.1:9/ …scan-dependencies.ts` | 2 |

Объём: 220 файлов, +19 779 строк.

## 4. Что увидел человек при demo

Ручной demo владельцем **ещё не проводился** — это вход в решение по итерации.
Скрипт demo в `ACCEPTANCE.md`; всё необходимое воспроизводится перечисленными выше командами.

## 5. Отклонения и риски

1. **DEV-01 не обеспечен в этой среде.** Реальных адаптеров usage telemetry, persisted wake
   и session resume нет; `capability-check` отвечает `LIMIT_AUTOCONTINUE_UNAVAILABLE`.
   Механика доказана только на инъектированных фикстурах. По `AGENTS.md` это blocker для
   заявления об автономной работе, поэтому `README.md` и `CLAUDE.md` прямо это фиксируют.
2. **Раунд 3 верификации дал `FAIL`.** Состоялись три раунда: `FAIL (4 blocker, 10 major)`,
   `FAIL (3 blocker, 9 major)`, затем верификация `789a8d5..3fe7ce3` двумя независимыми
   сессиями — test reviewer `PASS`, architecture reviewer `FAIL (2 blocker, 8 major)`.
   Оба blocker-а воспроизведены lead-ом независимо: контроль A4 инертен в штатном workflow,
   потому что база сравнения `HEAD` едет вместе с коммитами задачи (B-1); SIM-01 запрещает
   недетерминизм только в форме глобала, но не в форме импорта (B-2). Findings — в `REVIEW.md`.
3. **Реестр findings раунда 2 утрачен** (M-6 раунда 3): отчёт ревьюера раунда 2 не был
   внесён в `REVIEW.md`, а его исходный текст невосстановим. Закрытие раунда 2 опирается на
   формулировку автора фикса и независимо непроверяемо. Введено процессное правило: отчёт
   ревьюера вносится в `REVIEW.md` дословно и в момент получения.
4. **Отклонение по worktree** (`PLAN.md` §8): implementer-ы работали в общем дереве. Дважды
   subagent выполнил запрещённый `git stash` — оба раза контроль не сработал по причине,
   которую и описывал finding B2. Ущерба нет (проверено), фикс внедрён.
5. **Ошибка оркестрации lead-а:** два reviewer-а запущены параллельно, один из них мутирует
   код. Правило зафиксировано в `PLAN.md`.
6. **Ошибка порядка lead-а:** карта задач создана после старта implementer-ов; теперь
   `ownership:check` читает её из git-объекта base-коммита и поздняя декларация прав не даёт.
7. **Bash-слой запретов обходим** (интерпретаторы, переменные пути) — задокументировано;
   авторитетным остаётся сравнение фактического diff.
8. **`security:static` — не SAST**, `security:no-llm` — текстовый матчинг. SBOM, provenance,
   threat model и настоящий SAST принадлежат I17.

## 6. Решение

**Рекомендация lead: REWORK. Верификация выполнена и дала `FAIL`.**

Гипотеза I00 подтвердилась: агенты могут работать в репозитории с быстрым единым gate, а
критичные запреты исполняются инструментами. Но два GO-критерия I00 пока не выполнены
полностью:

- «критичные ограничения подтверждены deny/hook/lint/CI-тестами» — **не выполнено**:
  раунд 3 показал два blocker-а. Контроль владения путями (A4) не срабатывает, как только
  субагент коммитит свою работу, то есть в штатном сценарии; запрет недетерминизма обходится
  идиоматичной формой импорта. Ни один из двух дефектов не является регрессией — оба
  присутствовали с момента написания контролей и не были найдены двумя предыдущими раундами;
- «auto-resume dry-run сохраняет task/branch/HEAD/diff/test state» — dry-run выполнен, но
  capability в среде отсутствует, и репозиторий обязан этого не обещать.

Решение GO/REWORK/SPLIT/STOP принимает владелец после demo (`10_ITERATION_MASTER_PLAN` §1).

## 7. Вход следующей итерации

Перед I01: закрыть 2 blocker и 8 major раунда 3 и пройти верификацию заново; решения владельца по пяти
предложениям ADR из `REVIEW.md` (граница `api → persistence`, license policy по границе
дистрибуции, семантика `scope` исключений, идентичность агентной сессии, полная поверхность
SIM-01); решение по DEV-01 — реализовывать адаптеры или зафиксировать
`LIMIT_AUTOCONTINUE_UNAVAILABLE` как принятое ограничение.

Готово к использованию в I01: `packages/contracts`/`domain` пустые и ждут TypeBox envelopes и
`decide/evolve`; порты `Clock`/`RandomSource`/`IdFactory`/`Ruleset` ещё не написаны, но
строгий контракт `Instant` (ISO-8601 с обязательным смещением) уже есть в
`tools/usage-continuity` и предназначен к переносу в world time.

## 8. Model alias и resolved model ID

| Роль | Alias | Resolved model ID |
|---|---|---|
| Orchestrator/lead | opus | `claude-opus-5[1m]` |
| Architecture reviewer, verification reviewer | opus | `claude-opus-5` |
| Implementers (T02–T05, R1–R5, F1–F4), test reviewer | sonnet | `claude-sonnet-5` |

`CLAUDE_CODE_SUBAGENT_MODEL` не задавалась (ADR-007).

## 9. Evidence

- `PLAN.md` — гипотеза, scope, task graph, зафиксированные отклонения;
- `ACCEPTANCE.md` — A1–A11 и скрипт ручного demo;
- `REVIEW.md` — findings раундов 1 и 3 полностью, зафиксированная утрата реестра раунда 2
  (M-6) и подтверждение B2 на живом примере;
- `artifacts/security/*.json` — машиночитаемые результаты пяти проверок;
- `artifacts/README.md` — почему остальные artifacts из §3 master plan неприменимы к I00.
