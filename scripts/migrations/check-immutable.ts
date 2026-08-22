#!/usr/bin/env node
/**
 * Контроль неизменности УЖЕ ВЫПУЩЕННЫХ миграций (p-2/p-3 аудита I02A).
 *
 * ## Зачем это, если есть golden-реестр в тесте
 *
 * `migrations/registry.test.ts` закрепляет id/name/checksum литералами в дереве, и это лучше,
 * чем ничего: правка применённой миграции роняет `pnpm test:unit`. Но добавление строки и
 * изменение строки — одна и та же правка одного массива в том же коммите, поэтому красный тест
 * «чинится» редактированием литерала. Контроль, который живёт в том же дереве, что и
 * защищаемый артефакт, защищает только от невнимательности.
 *
 * Здесь базовая линия берётся ИЗВНЕ рабочего дерева: каталог миграций распаковывается из
 * git-объекта базового коммита (`git archive`), реестр читается оттуда, и checksum считается
 * ТЕКУЩИМ алгоритмом для обеих сторон — сравнивается текст миграций, а не версия хеширования.
 *
 * Правило: id, присутствовавший в базе, обязан иметь ТЕ ЖЕ `name` и `checksum`. Новые id —
 * нормальная поставка. Исчезнувший id — нарушение: применённую миграцию нельзя удалить.
 *
 * `node_modules` распакованному каталогу не нужен: `migrations/index.ts` импортирует только
 * соседние файлы, а `computeChecksum` берётся из текущего дерева отдельным самодостаточным
 * модулем (`migration-checksum.ts`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeChecksum } from '../../packages/persistence/src/migration-checksum.ts';
import { migrations as currentMigrations } from '../../packages/persistence/src/migrations/index.ts';
import type { Migration } from '../../packages/persistence/src/migrations/types.ts';

const MIGRATIONS_PATH = 'packages/persistence/src/migrations';

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const [, , baseRef] = process.argv;
if (baseRef === undefined) {
  fail('Использование: node scripts/migrations/check-immutable.ts <базовый-ref>');
}

const projectRoot = process.cwd();

/** Реестр миграций на базовом коммите. `null` — каталога там ещё не было (первая поставка). */
const registryAt = async (ref: string): Promise<readonly Migration[] | null> => {
  const dir = mkdtempSync(join(tmpdir(), 'zona-migrations-'));
  try {
    try {
      const archive = execFileSync('git', ['archive', ref, MIGRATIONS_PATH], {
        cwd: projectRoot,
        maxBuffer: 64 * 1024 * 1024,
      });
      execFileSync('tar', ['-x', '-C', dir], { input: archive });
    } catch {
      // Каталога миграций на базовом коммите нет — сравнивать не с чем, и это не ошибка.
      return null;
    }
    const entry = pathToFileURL(resolve(dir, MIGRATIONS_PATH, 'index.ts')).href;
    const loaded = (await import(entry)) as { readonly migrations: readonly Migration[] };
    return loaded.migrations;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const baseMigrations = await registryAt(baseRef!);
if (baseMigrations === null) {
  process.stdout.write(
    `migrations:immutable: на ${baseRef!} каталога миграций нет — сравнивать не с чем.\n`,
  );
  process.exit(0);
}

const current = new Map(currentMigrations.map((migration) => [migration.id, migration]));
const violations: string[] = [];

for (const base of baseMigrations) {
  const now = current.get(base.id);
  if (now === undefined) {
    violations.push(
      `${base.id} (${base.name}): миграция УДАЛЕНА. Применённую миграцию нельзя удалить — ` +
        'базы, где она уже прошла, не смогут обновиться.',
    );
    continue;
  }
  if (now.name !== base.name) {
    violations.push(
      `${base.id}: имя изменено "${base.name}" -> "${now.name}". id применённой миграции ` +
        'неизменяем: на базах предыдущей поставки это MIGRATION_NAME_MISMATCH до применения ' +
        'чего бы то ни было, то есть все следующие миграции тоже не доедут.',
    );
    continue;
  }
  const baseChecksum = computeChecksum(base);
  const nowChecksum = computeChecksum(now);
  if (baseChecksum !== nowChecksum) {
    violations.push(
      `${base.id} (${base.name}): содержимое изменено (${baseChecksum.slice(0, 12)} -> ` +
        `${nowChecksum.slice(0, 12)}). Добавьте новую миграцию вперёд вместо правки применённой.`,
    );
  }
}

if (violations.length > 0) {
  process.stderr.write(`Изменены уже выпущенные миграции (база ${baseRef!}):\n`);
  for (const violation of violations) process.stderr.write(`  - ${violation}\n`);
  process.exit(1);
}

const added = currentMigrations.filter(
  (migration) => !baseMigrations.some((base) => base.id === migration.id),
);
process.stdout.write(
  `migrations:immutable: ${String(baseMigrations.length)} выпущенных миграций не изменены` +
    (added.length === 0 ? '.\n' : `; добавлено: ${added.map((m) => m.id).join(', ')}.\n`),
);
