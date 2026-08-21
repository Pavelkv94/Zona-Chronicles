import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './database.ts';
import { buildAppliedMigrationsQuery, computeChecksum } from './migration-ledger.ts';

/**
 * N8 (I00-F2, major) — контракт нормализации checksum задокументирован в
 * `computeChecksum` (CRLF→LF, хвостовые пробелы, trim, порядок join), но до
 * этого файла ни один тест не фиксировал его на конкретных входах: во всех
 * существующих тестах checksum сравнивался сам с собой (`computeChecksum(m)`
 * против `computeChecksum(m)`), поэтому `normalizeStatement` могла бы быть
 * `return statement` (полная no-op) и все 327 тестов оставались бы зелёными.
 *
 * Тесты ниже фиксируют равенства/различия на конкретных входах — они падают,
 * если нормализация выключена (см. самопроверку в отчёте сдачи).
 */
describe('computeChecksum — контракт нормализации (N8)', () => {
  // `phase` теперь тоже часть checksum (minor 3, раунд 3 верификации) — во всех тестах
  // этого блока, где сравнение не про `phase`, фаза держится одинаковой на обеих сторонах,
  // чтобы тест по-прежнему изолированно проверял нормализацию `statements`.
  it('CRLF и LF дают одинаковый checksum на одном и том же SQL', () => {
    const lf = computeChecksum({ phase: 'expand', statements: ['select 1;\nselect 2;'] });
    const crlf = computeChecksum({ phase: 'expand', statements: ['select 1;\r\nselect 2;'] });
    expect(crlf).toBe(lf);
  });

  it('хвостовые пробелы/табы на строках не влияют на checksum', () => {
    const clean = computeChecksum({
      phase: 'expand',
      statements: ['create table t (\n  id int\n);'],
    });
    const trailing = computeChecksum({
      phase: 'expand',
      statements: ['create table t (   \n  id int\t\t\n);   '],
    });
    expect(trailing).toBe(clean);
  });

  it('ведущие/хвостовые пустые строки одного statement не влияют на checksum (trim)', () => {
    const clean = computeChecksum({ phase: 'expand', statements: ['select 1;'] });
    const padded = computeChecksum({ phase: 'expand', statements: ['\n\n  select 1;\n\n'] });
    expect(padded).toBe(clean);
  });

  it('изменение самого SQL меняет checksum', () => {
    const original = computeChecksum({ phase: 'expand', statements: ['select 1;'] });
    const changed = computeChecksum({ phase: 'expand', statements: ['select 2;'] });
    expect(changed).not.toBe(original);
  });

  it('перестановка statements меняет checksum (порядок значим)', () => {
    const forward = computeChecksum({
      phase: 'expand',
      statements: ['select 1;', 'select 2;'],
    });
    const reversed = computeChecksum({
      phase: 'expand',
      statements: ['select 2;', 'select 1;'],
    });
    expect(reversed).not.toBe(forward);
  });

  it('checksum — sha256 в hex от нормализованного текста (с учётом phase), а не произвольный хэш', () => {
    const statements = ['select 1;', 'select 2;'];
    const expected = createHash('sha256')
      .update('expand select 1;\nselect 2;', 'utf8')
      .digest('hex');
    expect(computeChecksum({ phase: 'expand', statements })).toBe(expected);
  });

  /**
   * Minor 3 (раунд 3 верификации): `computeChecksum` раньше покрывал только
   * `statements`, поэтому фазу уже применённой миграции можно было изменить
   * (`expand` -> `contract`), не трогая statements, — integrity check журнала
   * (`applyMigrations`, `MIGRATION_CHECKSUM_MISMATCH`) проходил бы молча, хотя
   * `validatePhaseBatch` держит контроль «destructive contract не в одной
   * поставке с первым новым reader/writer» ровно на этой метке.
   *
   * RED (до фикса): `expect(changed).not.toBe(original)` падал — при неизменных
   * `statements` смена `phase` не меняла checksum:
   *   AssertionError: expected '<hash>' not to be '<hash>' // Object.is equality
   */
  it('изменение phase меняет checksum при неизменных statements', () => {
    const statements = ['select 1;'];
    const original = computeChecksum({ phase: 'expand', statements });
    const changed = computeChecksum({ phase: 'contract', statements });
    expect(changed).not.toBe(original);
  });
});

/**
 * Minor 2 (раунд 3 верификации): `orderBy('id', 'asc')` без явной коллации сортирует
 * текст по коллации БД (`lc_collate`), то есть порядок применения миграций зависел бы
 * от настройки сервера/локали, а не только от кода — нарушение SIM-01 (детерминизм
 * не должен зависеть от окружения).
 *
 * Воспроизвести разницу коллаций в реальной тестовой БД дорого: нужен отдельный
 * Postgres-кластер/база с нестандартным `lc_collate` (ни один профиль CI/Testcontainers
 * в этом репозитории такой не поднимает — `docker-compose.yml` и `migration-runner.integration.test.ts`
 * используют один и тот же образ с фиксированной локалью). Поэтому доказательство —
 * на уровне сгенерированного SQL: `.compile()` не требует реального подключения
 * (пул `pg` лениво подключается только при исполнении запроса), а сгенерированный текст
 * детерминированно показывает, что порядок задан явным `collate` в коде, а не тем, что
 * решит сервер по умолчанию.
 *
 * RED (до фикса): `sql.includes('collate "c"')` — false, скомпилированный текст был
 * `select * from "schema_migrations" order by "id" asc` (никакой коллации).
 */
describe('buildAppliedMigrationsQuery — порядок независим от коллации БД (minor 2)', () => {
  it('ORDER BY использует явную побайтовую коллацию ("C"), а не коллацию БД по умолчанию', () => {
    // `host: 'localhost:1'` недостижим намеренно — `.compile()` не открывает соединение,
    // pg.Pool подключается лениво только при первом запросе.
    const db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({ host: 'localhost', port: 1, user: 'x', password: 'x', database: 'x' }),
      }),
    });
    try {
      const compiled = buildAppliedMigrationsQuery(db).compile();
      expect(compiled.sql.toLowerCase()).toContain('collate "c"');
    } finally {
      void db.destroy();
    }
  });
});
