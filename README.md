# Живая Зона

Постоянно работающая серверная симуляция опасной аномальной территории. Пользователь —
наблюдатель: он видит, как обитатели перемещаются, выживают, торгуют, конфликтуют и
превращаются в легенды. Основная гипотеза — связная история возникает из правил мира,
локального знания, памяти и последствий, а не из генеративного текста.

Полное описание продукта: [`docs/00_README.md`](docs/00_README.md).

## Статус

Pre-production. Итерация **I00** — репозиторий и agent harness
(см. [`docs/10_ITERATION_MASTER_PLAN.md`](docs/10_ITERATION_MASTER_PLAN.md)).
Мир ещё не симулируется. I00 доказывает, что gate воспроизводим и что границы исполняются
инструментами, а не соглашением.

Репозиторий **не обещает** автоматического продолжения работы после исчерпания пятичасового
usage window: требование DEV-01 снято 2026-08-21 (ADR-009) вместе с механикой checkpoint/resume.
Пауза обрабатывается человеком и внешним runner-ом.

## Быстрый старт

```bash
corepack enable                      # pnpm берётся из поля packageManager
pnpm install --frozen-lockfile
pnpm verify                          # быстрый gate: формат, lint, границы, типы, тесты, security, build
pnpm verify:full                     # тот же gate плюс integration и replay
```

Требуется Node из [`.nvmrc`](.nvmrc) и запущенный Docker: integration-тесты поднимают
собственный контейнер PostgreSQL/PostGIS через Testcontainers. Отдельный
`docker compose up -d postgres` нужен для ручной работы с БД, а не для тестов.

## Структура

```text
apps/       api (Fastify, read-only observer API), worker (канонический scheduler), cli
packages/   contracts, domain, simulation, persistence, projections, representation, content, testkit
tools/      dev harness: agent-harness (границы работы агентов), security-scan
tests/      acceptance, replay, integration, contract, soak, e2e
docs/       нормативная документация и evidence итераций
ops/        Dockerfile и эксплуатационные файлы
```

Направление зависимостей и запреты описаны в [`CLAUDE.md`](CLAUDE.md) и ADR-002/ADR-003
([`docs/06_ARCHITECTURE_DECISIONS.md`](docs/06_ARCHITECTURE_DECISIONS.md)); они исполняются
`pnpm boundaries:check` и `pnpm lint`.

## Разработка

Процесс — TDD с независимой проверкой: [`docs/08_TDD_AND_AGENT_WORKFLOW.md`](docs/08_TDD_AND_AGENT_WORKFLOW.md).
Порядок итераций и gates — [`docs/10_ITERATION_MASTER_PLAN.md`](docs/10_ITERATION_MASTER_PLAN.md).
Каждое изменение поведения начинается с requirement ID из
[`docs/11_REQUIREMENTS_TRACEABILITY.md`](docs/11_REQUIREMENTS_TRACEABILITY.md).

## Ограничения

- До Gate E в продукте нет runtime LLM: SDK, ключей, prompts, embeddings и очередей генерации (ADR-006).
- До письменного разрешения правообладателя используется только оригинальный/нейтральный контент;
  проект не публикуется как проект по вселенной S.T.A.L.K.E.R. ([`docs/04_IP_AND_RESEARCH.md`](docs/04_IP_AND_RESEARCH.md)).
