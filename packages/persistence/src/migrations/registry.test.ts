/**
 * N-1 — реестр миграций закреплён golden-значениями.
 *
 * Повторный архитектурный аудит I02A нашёл blocker: миграция `0003` была переписана с
 * переиспользованием id. База, мигрированная предыдущей поставкой, после этого не обновляется
 * ВООБЩЕ — `MIGRATION_NAME_MISMATCH` срабатывает до применения чего бы то ни было, поэтому
 * `0004`+ не доезжают, а новый код на такую базу уже не работает. Ни один из 48 интеграционных
 * тестов этого не поймал: каждый создаёт базу заново, и «существующая схема» в B1 означает «та
 * же поставка дважды», а не «предыдущая поставка».
 *
 * Литералы ниже — тот самый недостающий контроль. Редактирование УЖЕ ВЫПУЩЕННОЙ миграции
 * роняет этот тест на этапе `pnpm test:unit`, а не на чужой базе в проде. Обновлять их можно
 * только для новой строки в конце или вместе с записанным в `PLAN.md` решением о слоне.
 */
import { describe, expect, it } from 'vitest';
import { computeChecksum } from '../migration-ledger.ts';
import { migrations } from './index.ts';

interface RegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
}

const GOLDEN_REGISTRY: readonly RegistryEntry[] = [
  {
    id: '0001',
    name: 'bootstrap',
    checksum: '4b341e901ea06301d24f2dfce48e614e77f4cf5b42fdb8fce0c0a1c898135a27',
  },
  {
    id: '0002',
    name: 'canonical-core',
    checksum: 'e875fd538405fd1eac656149cb551b68c686af910a2fb356151e24988d1a0fa7',
  },
  {
    id: '0003',
    name: 'revoke-public-defaults',
    checksum: 'e064070aa3ce8a498ba77c6a21f4fb7bea35cbc703e0bffd84823d2324cddf48',
  },
  {
    id: '0004',
    name: 'command-fingerprint',
    checksum: 'f1655bfecd26299fdcbe52d16bde38cb3b4bc27f3f55ee042584d3a69ead0a0f',
  },
  {
    id: '0005',
    name: 'event-checksum',
    checksum: '694b19490229340ed6a4f81bdf224a260a0cd65c8b2618170e6075c625712f30',
  },
  {
    id: '0006',
    name: 'command-attempt-rejections',
    checksum: 'cf947e2c33854955b07bd1854e2dd0464263fe009da32ff063b9cd1b17722f83',
  },
];

describe('реестр миграций', () => {
  it('id, имена и checksum совпадают с закреплёнными значениями', () => {
    expect(
      migrations.map((migration) => ({
        id: migration.id,
        name: migration.name,
        checksum: computeChecksum(migration),
      })),
    ).toEqual(GOLDEN_REGISTRY);
  });

  it('id строго возрастают и уникальны', () => {
    const ids = migrations.map((migration) => migration.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ни одна миграция не содержит нескольких SQL-операторов в одном элементе', () => {
    // Runner исполняет `statements` через `sql.raw` по extended protocol, который отвергает
    // несколько команд в одном запросе. Ошибка проявилась бы только на настоящей базе.
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        // Точка с запятой встречается и внутри комментариев, и внутри тела `do $$ … $$`, и
        // внутри строковых литералов — там она оператора не разделяет. Убираем всё три формы,
        // иначе проверка ловила бы саму себя (проба: 0002 падал из-за «;» в комментарии).
        const withoutDollarBlocks = statement.replaceAll(/\$\$[\s\S]*?\$\$/g, '$$$$');
        const withoutStrings = withoutDollarBlocks.replaceAll(/'[^']*'/g, "''");
        const withoutComments = withoutStrings.replaceAll(/--[^\n]*/g, '');
        expect(
          withoutComments.replace(/;\s*$/, '').includes(';'),
          `${migration.id}-${migration.name}: несколько операторов в одном элементе`,
        ).toBe(false);
      }
    }
  });
});
