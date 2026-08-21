/**
 * Фаза миграции по expand → migrate/backfill → contract (§12 03_TECHNICAL_DESIGN.md).
 * `expand` — добавляет новое, ничего не ломает для старого reader/writer;
 * `backfill` — переносит/пересчитывает данные под новую схему;
 * `contract` — destructive-шаг (удаляет старую колонку/таблицу/constraint).
 * Runner запрещает применять `contract` в одном прогоне вместе с `expand`
 * той же поставки — см. `MigrationPhaseConflictError`.
 *
 * `phase` — часть checksum журнала (`computeChecksum`, `migration-ledger.ts`), не
 * только `statements`: без этого фазу уже применённой миграции можно было бы
 * изменить (например, задним числом перемаркировать `expand` в `contract`), не
 * трогая `statements`, и `MigrationPhaseConflictError` держался бы на метке,
 * достоверность которой ничем не проверяется (minor 3, раунд 3 верификации).
 */
export type MigrationPhase = 'expand' | 'backfill' | 'contract';

/**
 * Контракт одной миграции. `id` — сортируемый префикс (`0001`, `0002`, ...),
 * задающий порядок применения. Реестр (`migrations/index.ts`) — явный
 * упорядоченный массив, а не сканирование каталога.
 *
 * `statements` — ЕДИНСТВЕННЫЙ канал исполнения: общий runner
 * (`migration-runner.ts`) применяет их по порядку через `sql.raw(...)`.
 * У миграции намеренно нет произвольной `up(db)` — раньше она была свободной
 * функцией, и review показал (N3, I00-F2), что `up` можно было изменить, не
 * трогая `statements`: checksum журнала (`computeChecksum`) считается от
 * `statements`, поэтому такое изменение проходило бы integrity check молча,
 * а применённая миграция меняла бы эффект — на невосполнимом журнале это
 * OPS-01/OPS-04. Раздельное поле `up` для checksum не годится и по другой
 * причине: `Function.prototype.toString()` нестабилен между версиями
 * TypeScript/транспайлера/минификатора и дал бы ложный
 * `MIGRATION_CHECKSUM_MISMATCH` на непотронутой миграции — этот вариант уже
 * был отклонён в предыдущем раунде review.
 *
 * Итог: checksum обязан покрывать ровно то, что исполняется, поэтому
 * единственный вариант — не давать миграции исполняемого кода вообще.
 * Если будущей миграции (I02A+) понадобится императивная логика (например,
 * batched backfill с переменным числом шагов), это осознанное расширение
 * контракта — оно обязано принести собственное покрытие checksum, а не
 * добавлять `up` обратно молча.
 */
export interface Migration {
  readonly id: string;
  readonly name: string;
  readonly phase: MigrationPhase;
  readonly statements: readonly string[];
}
