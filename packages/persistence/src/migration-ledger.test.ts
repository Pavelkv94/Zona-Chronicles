import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeChecksum } from './migration-ledger.ts';

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
  it('CRLF и LF дают одинаковый checksum на одном и том же SQL', () => {
    const lf = computeChecksum({ statements: ['select 1;\nselect 2;'] });
    const crlf = computeChecksum({ statements: ['select 1;\r\nselect 2;'] });
    expect(crlf).toBe(lf);
  });

  it('хвостовые пробелы/табы на строках не влияют на checksum', () => {
    const clean = computeChecksum({ statements: ['create table t (\n  id int\n);'] });
    const trailing = computeChecksum({
      statements: ['create table t (   \n  id int\t\t\n);   '],
    });
    expect(trailing).toBe(clean);
  });

  it('ведущие/хвостовые пустые строки одного statement не влияют на checksum (trim)', () => {
    const clean = computeChecksum({ statements: ['select 1;'] });
    const padded = computeChecksum({ statements: ['\n\n  select 1;\n\n'] });
    expect(padded).toBe(clean);
  });

  it('изменение самого SQL меняет checksum', () => {
    const original = computeChecksum({ statements: ['select 1;'] });
    const changed = computeChecksum({ statements: ['select 2;'] });
    expect(changed).not.toBe(original);
  });

  it('перестановка statements меняет checksum (порядок значим)', () => {
    const forward = computeChecksum({ statements: ['select 1;', 'select 2;'] });
    const reversed = computeChecksum({ statements: ['select 2;', 'select 1;'] });
    expect(reversed).not.toBe(forward);
  });

  it('checksum — sha256 в hex от нормализованного текста, а не произвольный хэш', () => {
    const statements = ['select 1;', 'select 2;'];
    const expected = createHash('sha256').update('select 1;\nselect 2;', 'utf8').digest('hex');
    expect(computeChecksum({ statements })).toBe(expected);
  });
});
