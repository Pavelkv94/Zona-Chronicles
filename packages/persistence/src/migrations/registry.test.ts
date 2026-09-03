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
 * Литералы ниже — быстрый локальный сигнал: редактирование УЖЕ ВЫПУЩЕННОЙ миграции роняет этот
 * тест на этапе `pnpm test:unit`, а не на чужой базе в проде.
 *
 * Но это НАПОМИНАНИЕ, а не гарантия, и границу надо назвать честно (p-2 аудита I02A):
 * добавление строки и изменение строки — одна и та же правка одного массива в том же коммите,
 * поэтому красный тест «чинится» редактированием литерала. Контроль, живущий в том же дереве,
 * что и защищаемый артефакт, защищает только от невнимательности.
 *
 * Авторитетный контроль — `pnpm migrations:immutable <base>` в CI: он берёт базовую линию из
 * git-объекта базового коммита, то есть ИЗВНЕ рабочего дерева, и правкой дерева не обходится.
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
  {
    id: '0007',
    name: 'scheduler-and-snapshots',
    checksum: 'd24c42c6a2c65d274d3c520c80a66f5715522d763bc938b429831c9f4c56519d',
  },
  {
    id: '0008',
    name: 'scheduled-action-failure',
    checksum: '57fd3de27540308b02a9e46b4d7b1f4896a28c468e9705b8e8994da8e734613a',
  },
  // Новая миграция I02B (M4): позиции PRNG становятся колонкой `worlds`. Golden дополнен, а не
  // переписан — существующие строки не тронуты, что и требуется от неизменности выпущенного.
  {
    id: '0009',
    name: 'world-prng-positions',
    checksum: 'f21fb7b8a77e1f591722546890158805c96ef46c31cec183b920e14afcf37e2b',
  },
  // B1 второго раунда верификации: 0009 обнулила позиции PRNG у миров прежней поставки,
  // потому что её обоснование не учло розыгрыши генезиса. Выпущенная миграция не правится —
  // исправление отдельной строкой.
  {
    id: '0010',
    name: 'backfill-prng-positions',
    checksum: '47f41675ecaa496103f170ef27d9f961dc2480e377a8d96d9c035b8ec6f057e5',
  },
  // I03: таблицы observer projection. Отдельные от канонических намеренно — см. докстринг 0011.
  {
    id: '0011',
    name: 'observer-projection',
    checksum: '7d57e56d7605cc0a5080a6121de5ea51303bc39b0fd309da5726db7b03da0e58',
  },
  // I03, M-C: мир записывает профиль выполнения, под которым квалифицирован.
  {
    id: '0012',
    name: 'world-qualified-profile',
    checksum: '2d5f8080b1b983f34247954218ca662786b0b941eaeef2c5070d8a6f3b816010',
  },
  {
    id: '0013',
    name: 'snapshot-bundles',
    checksum: 'e43bd83acbb5120911ce97d956c29cba5d2aaaeb05d46440332f4ed499985fb1',
  },
  {
    id: '0014',
    name: 'needs',
    checksum: 'edc6c09d4a8a13e563bdfde2e6139293bcf4f5dc9e11a6edffacb287524eb2c8',
  },
  {
    id: '0015',
    name: 'observed-world-time',
    checksum: 'ee9023bc9eb6568917fcf7a0986112413d539d43cb2dfb06c4cc376f990bcd6e',
  },
  {
    id: '0016',
    name: 'items',
    checksum: 'a0ebffac38cb989d102550bc4ce6b21438f6f4b125292556b0276bc9f2fd4b27',
  },
  {
    id: '0017',
    name: 'projection-food',
    checksum: '7562b33b3a47ab6bf3e05b172d582b2745daeb99e896aeaae87e7cda0d5202ff',
  },
  {
    id: '0018',
    name: 'resting',
    checksum: '532d9a001048a352e6dd6854d0d7be05022e5c2c87cc52b6f435e8d5506e352b',
  },
  {
    id: '0019',
    name: 'goals',
    checksum: '9ae5b50b250e40f6b90b2678ef828dd770782bce963d0c3b05c87584b6a30ea3',
  },
  {
    id: '0020',
    name: 'plans',
    checksum: '15fa54710c6975543307fa14985713c57829cf5fd7808bfb76c669a94088cbc3',
  },
  {
    id: '0021',
    name: 'risk',
    checksum: '3b228626853c8b620d592289f670d77fce66c4a85addf729b869a2ba1be037fe',
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
