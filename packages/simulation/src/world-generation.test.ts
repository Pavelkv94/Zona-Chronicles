/**
 * Опасность из контента проверяется при порождении мира (I06, ревью I04-I06 m4).
 *
 * Путь без базы — `world seed`, `world inspect`, любой in-memory прогон — не проходит ни через
 * одну схему и ни через один check-constraint: контент попадает в каноническое состояние как
 * есть. Диапазон опасности держали ровно те два места, мимо которых этот путь идёт: миграция
 * 0021 и литералы в схеме события. `RISK_UNIT` при этом был объявлен, экспортирован и не
 * использован нигде — единица без применения не ограничивает ничего.
 *
 * Ошибка была бы из самых тихих: мир с `risk: 6000` выглядит работающим, просто из него уходят
 * отовсюду и всегда.
 */
import { describe, expect, it } from 'vitest';
import { FixedRuleset, rulesetFor, testRulesetVersions } from '@zona/domain';
import { rulesBundleContent, seedWorld, type GeneratorContent } from './world-generation.ts';

const HOST = { nodeVersion: '24.0.0', icuVersion: '75.1' };

/**
 * Синтетический мир, а не `PROTOTYPE_WORLD`.
 *
 * Пакет не имеет права зависеть от контента (ADR-002), и правило границ поймало первую редакцию
 * этого теста ровно на таком импорте. Форма данных зависимостью не является — она объявлена
 * здесь же, в `GeneratorContent`.
 */
const world = (patch: Partial<GeneratorContent> = {}): GeneratorContent => ({
  worldId: 'world:fixture',
  initialWorldTime: '2028-04-26T06:00:00Z',
  locations: [
    { id: 'loc:a', risk: 0 },
    { id: 'loc:b', risk: 300 },
  ],
  routes: [
    {
      id: 'route:a-b',
      fromLocationId: 'loc:a',
      toLocationId: 'loc:b',
      travelMinutes: 60,
      risk: 200,
    },
  ],
  agents: [{ id: 'agent:one' }],
  items: [],
  ...patch,
});

const build = (content: GeneratorContent) =>
  seedWorld(content, '0.0.1', 42, HOST, rulesetFor(testRulesetVersions()));

describe('опасность контента проверяется единицей, а не доверием', () => {
  it('здоровый мир проходит', () => {
    // Обратная сторона пробы: страж обязан не ловить корректный мир. Без этого утверждения
    // «бросает на плохом» доказывалось бы и стражем, который бросает всегда.
    expect(() => build(world())).not.toThrow();
  });

  it('опасность места выше единицы отвергается С ИМЕНЕМ МЕСТА', () => {
    // Имя в отказе — не вежливость: у карты десятки мест, и «опасность вне диапазона» без
    // указания, где именно, оставляет искать опечатку глазами.
    expect(() =>
      build(
        world({
          locations: [
            { id: 'loc:a', risk: 6000 },
            { id: 'loc:b', risk: 300 },
          ],
        }),
      ),
    ).toThrow(/loc:a/);
  });

  it('отрицательная опасность дороги отвергается с именем дороги', () => {
    expect(() =>
      build(
        world({
          routes: [
            {
              id: 'route:a-b',
              fromLocationId: 'loc:a',
              toLocationId: 'loc:b',
              travelMinutes: 60,
              risk: -1,
            },
          ],
        }),
      ),
    ).toThrow(/route:a-b/);
  });

  it('дробная опасность отвергается: канон не хранит дробей', () => {
    expect(() =>
      build(
        world({
          locations: [
            { id: 'loc:a', risk: 300.5 },
            { id: 'loc:b', risk: 300 },
          ],
        }),
      ),
    ).toThrow(/loc:a/);
  });
});

describe('bundle правил хеширует ВСЕ коэффициенты, а не часть', () => {
  it('состав хешируемого совпадает с составом ruleset', () => {
    /**
     * Утверждение, которое чинит себя само.
     *
     * До ревью I04-I06 в хеш входили только `versions` и `needs`, хотя правил с тех пор
     * прибавилось трижды: `restMinutes` и `goalWeights` (I05), диапазон осторожности (I06).
     * Изменение веса выбора цели молча давало другой мир под тем же именем правил — ровно то,
     * что дефект M3 аудита I02B запрещал, и что комментарий рядом объявлял исправленным.
     *
     * Сравниваются КЛЮЧИ, а не значения: новый коэффициент, добавленный на интерфейс `Ruleset`
     * и забытый в bundle, обязан ронять этот тест, а не ждать, пока кто-нибудь заметит.
     */
    const ruleset = rulesetFor(testRulesetVersions());
    expect(Object.keys(rulesBundleContent(ruleset)).sort()).toStrictEqual(
      Object.keys(ruleset).sort(),
    );
  });

  it('изменение коэффициента меняет хешируемое содержимое', () => {
    // Обратная сторона: совпадение ключей ничего не стоило бы, если бы значения не переносились.
    const ruleset = rulesetFor(testRulesetVersions());
    const louder = new FixedRuleset(
      ruleset.versions,
      ruleset.needs,
      ruleset.restMinutes,
      {
        ...ruleset.goalWeights,
        switchMarginPermille: ruleset.goalWeights.switchMarginPermille + 1,
      },
      ruleset.cautionRange,
    );
    expect(JSON.stringify(rulesBundleContent(louder))).not.toBe(
      JSON.stringify(rulesBundleContent(ruleset)),
    );
  });
});
