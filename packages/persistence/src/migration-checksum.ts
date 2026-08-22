/**
 * Checksum миграции — чистая функция, вынесенная отдельно от журнала (I02B).
 *
 * Отдельный модуль нужен, чтобы её можно было применить к миграциям ПРОШЛОЙ поставки, не
 * поднимая ничего лишнего: `migration-ledger.ts` импортирует Kysely, а контроль неизменности
 * (`scripts/migrations/check-immutable.ts`) работает с распакованным из git каталогом миграций,
 * где никакого `node_modules` нет и быть не должно.
 *
 * Здесь только `node:crypto` и типы — модуль самодостаточен намеренно.
 */
import { createHash } from 'node:crypto';
import type { Migration } from './migrations/types.ts';

/**
 * Нормализация перед хешированием: переводы строк и хвостовые пробелы не меняют СМЫСЛ SQL,
 * поэтому переформатирование файла не должно объявляться изменением уже применённой миграции.
 * Всё остальное — меняет.
 */
function normalizeStatement(statement: string): string {
  return statement
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/**
 * `phase` входит в checksum наравне со `statements`: без этого фазу применённой миграции можно
 * было бы перемаркировать задним числом, не трогая SQL, и `MigrationPhaseConflictError`
 * держался бы на метке, достоверность которой ничем не проверяется (minor 3, раунд 3 I00).
 */
export function computeChecksum(migration: Pick<Migration, 'statements' | 'phase'>): string {
  const normalizedStatements = migration.statements.map(normalizeStatement).join('\n');
  const normalized = `${migration.phase} ${normalizedStatements}`;
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
