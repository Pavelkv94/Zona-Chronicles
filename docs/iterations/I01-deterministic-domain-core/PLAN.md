# I01 — Детерминированное доменное ядро: PLAN

Итерация: I01
Ветка: `iteration/I01-domain-core`
Base commit: `ca917e0`
Дата старта: 2026-08-21
Статус: in_progress

## 1. Гипотеза

Цепочка command → events → state полностью проверяема **без базы данных и без framework**:
чистые функции `decide` и `evolve` над явными портами дают один и тот же canonical результат
при одинаковых snapshot, seed и версиях правил.

Это первая итерация, в которой появляется мир. I00 строил среду; здесь проверяется, что
детерминизм достижим в коде, а не только заявлен в ADR.

## 2. Observable demo

Два независимых запуска `pnpm world seed --seed <N>` печатают **побайтово одинаковый**
canonical JSON и одинаковый checksum. Изменение seed даёт другой мир — но валидный по тем же
схемам. `pnpm world inspect` показывает агентов, локации и маршруты этого мира.

Мир пока не живёт: событий во времени нет, это I02A. Здесь доказывается, что его начальное
состояние воспроизводимо.

## 3. Требования (`11_REQUIREMENTS_TRACEABILITY`)

| ID | Что доказываем |
| --- | --- |
| SIM-01 | Одинаковые snapshot/seed/bundles/runtime profile дают одинаковый canonical результат; locale, timezone, порядок ключей и план БД на него не влияют |
| NAR-02 | Домен не содержит и не вызывает LLM (проверяется существующим gate) |
| DEV-02 | Изоляция задач по worktree применяется впервые в боевой итерации |

## 4. Scope

1. **Исполняемые TypeBox envelopes v1** (`packages/contracts`): command envelope, world event
   envelope, rejection codes, правила naming и `schema_version` по `09_EVENT_AND_COMMAND_CONTRACTS`
   §2–4. Runtime-валидация, а не только типы.
2. **Порты** (`packages/domain`): `Clock`, `RandomSource`, `IdFactory`, `Ruleset` — интерфейсы
   и детерминированные тестовые реализации. Домен получает время, случайность, ID и коэффициенты
   только через них.
3. **Canonical serialization v1** и checksum (`packages/contracts`): фиксированный порядок ключей,
   UTF-8, представление чисел и дат, обработка отсутствующих полей. Смена алгоритма — versioned
   migration.
4. **Numeric units и rounding**: документированные единицы, диапазоны и правила округления;
   `NaN`, `Infinity` и неявное округление отвергаются на границе.
5. **Интерфейсы `decide`/`evolve`** (`packages/domain`) с исчерпывающей обработкой типов событий
   (exhaustiveness проверяется компилятором, а не тестом).
6. **Минимальные fixtures мира** (`packages/content`): 1 мир, 2–4 локации, 1–2 маршрута,
   3–5 агентов — данные, не логика.
7. **CLI `world seed` и `world inspect`** (`apps/cli`) — in-memory, без БД.

## 5. Out of scope

- любое обращение к PostgreSQL, миграции, репозитории — это I02A;
- `journey.start` как исполняемая команда со scheduled action — I02A/I02B;
- Utility AI, планы, потребности, экономика — позже по мастер-плану;
- HTTP-роуты, SSE, projections, representation;
- полный набор event types: замораживается только envelope и первый slice по
  `09_EVENT_AND_COMMAND_CONTRACTS` §11.

## 6. Frozen contracts итерации

Замораживаются `packages/contracts/**` после задачи I01-T1 и до старта остальных.
Contract freeze commit: заполняется после I01-T1.

Источник истины для формы: `09_EVENT_AND_COMMAND_CONTRACTS` §2–4, §11. Расхождение исполняемой
схемы с документом разрешается в пользу документа либо документ изменяется явно.

## 7. Task graph и file ownership

| Task | Роль | Write paths | Зависит от |
| --- | --- | --- | --- |
| I01-T1 | contract-steward (Opus) | `packages/contracts/**` | — |
| I01-T2 | acceptance-author | `tests/acceptance/**` | I01-T1 |
| I01-T3 | domain-implementer | `packages/domain/**` | I01-T1 |
| I01-T4 | domain-implementer | `packages/content/**`, `apps/cli/**` | I01-T1, I01-T3 |

Каждая задача работает в **изолированном worktree** (`pnpm task:worktree`). Отклонение по
общему дереву закрыто в I00; см. `I00/PLAN.md` §8 и findings F5-1..F5-3.

## 8. Отклонения от нормативного процесса

Пока нет. Отклонения фиксируются здесь до того, как будут допущены, а не после.

## 9. Stop conditions

- одинаковый seed даёт разный canonical JSON хотя бы в одном из 100 повторов;
- домен импортирует адаптер, часы, случайность или сеть (ловится существующим gate);
- исполняемая схема расходится с `09_EVENT_AND_COMMAND_CONTRACTS` без явного изменения документа;
- для достижения детерминизма требуется знание о БД или порядке SQL.
