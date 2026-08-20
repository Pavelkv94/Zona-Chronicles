import { describe, expect, it } from 'vitest';
import type { Migration } from './types.ts';

/**
 * N3 (I00-F2, blocker) — воспроизведение мутации review и доказательство фикса.
 *
 * Review показал: `up()` была свободной функцией, и можно было исполнить SQL,
 * не отражённый в `statements` (например добавить в `up` миграции 0001-bootstrap
 * `create table smuggled_by_up (...)`, не трогая `statements`) — `computeChecksum`
 * считает checksum только от `statements`, поэтому такая правка проходила бы
 * integrity check журнала молча, а применённая миграция меняла бы эффект.
 *
 * Фикс убрал `up(db)` из контракта `Migration` — единственный канал исполнения
 * теперь `statements`, и общий runner (`migration-runner.ts`) исполняет их сам.
 * Ниже — попытка буквально воспроизвести мутацию review: добавить рядом со
 * `statements` дополнительный исполняемый код. `@ts-expect-error` требует,
 * чтобы это было ошибкой компиляции — если бы фикс не убрал `up` из типа (или
 * кто-то в будущем вернул его без нового покрытия checksum), эта строка
 * скомпилировалась бы и `tsc --noEmit` доложил бы "Unused '@ts-expect-error'
 * directive", проваливая typecheck-gate (см. `pnpm exec tsc --noEmit -p
 * packages/persistence/tsconfig.json` в чеклисте сдачи).
 */
describe('Migration контракт — statements единственный канал исполнения (N3)', () => {
  it('нельзя выразить типами дополнительный executable-код рядом со statements', () => {
    const smuggled: Migration = {
      id: '9999',
      name: 'smuggled',
      phase: 'expand',
      statements: ['select 1'],
      // @ts-expect-error — воспроизведение мутации review: `up` больше не поле
      // `Migration` (excess property), а не valid Migration. Мутация review
      // исполняла именно такой SQL в обход checksum:
      // 'create table smuggled_by_up (id serial primary key)'.
      up: async () => {},
    };

    // Строка выше не компилируется без `@ts-expect-error` — это и есть доказательство
    // N3-фикса. Проверка ниже — не про рантайм-поведение `up` (TS-ошибки не убирают
    // свойство из литерала в рантайме), а про то, что тест вообще имеет смысл:
    // `statements` остаётся единственным полем, которое читает runner.
    expect(smuggled.statements).toEqual(['select 1']);
  });
});
