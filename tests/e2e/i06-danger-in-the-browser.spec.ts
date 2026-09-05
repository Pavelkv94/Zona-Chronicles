/**
 * I06-D — уход от опасности и разведка дороги видны в браузере, а сама опасность — нет
 * (`docs/iterations/I06-danger-and-risk/PLAN.md` §10 D, §9).
 *
 * Отличие от I04 в том, ЧТО именно движет агентом. Там мир действовал сам, но по своей нужде:
 * голод — свойство тела, и знать о нём агенту нечего. Здесь причина внешняя: место опасно, а
 * дороги из него агент оценивает по тому, что о них ЗНАЕТ. Зритель обязан увидеть и решение, и
 * дорогу, и факт разведки — и не обязан узнать вместе с агентом, насколько там скверно.
 *
 * Ни одной команды человека в сценарии нет. Мир при seed 42 ставит Зяблика на мост сам.
 */
import { expect, test } from '@playwright/test';
import { PROTOTYPE_WORLD } from '../../packages/content/src/index.ts';
import { RESTLESS_LOCATION, assertCalmLocationsMatchMap } from '../support/calm-routes.ts';
import { startWorldStack, type WorldStack } from './support/world-stack.ts';

let stack: WorldStack;

/**
 * Темп 600 минут мира за реальную секунду — тот же, что у I04, и по той же причине: первое
 * решение принимается на пороге усталости, то есть через семь мировых часов. При темпе D13 это
 * семьдесят реальных минут, а сценарий, который нельзя прогнать, не проверяет ничего.
 */
test.beforeAll(async () => {
  assertCalmLocationsMatchMap();
  stack = await startWorldStack('danger', { worldMinutesPerRealSecond: 600 });
});

test.afterAll(async () => {
  await stack.stop();
});

/** Название беспокойного места берётся из карты: выписанное здесь проверяло бы мою память. */
const restlessName = (): string => {
  const location = PROTOTYPE_WORLD.locations.find((node) => node.id === RESTLESS_LOCATION);
  if (location === undefined) throw new Error(`e2e: ${RESTLESS_LOCATION} исчез из карты`);
  return location.name;
};

test('агент уходит от опасности, зритель видит дорогу — и не видит опасности', async ({ page }) => {
  await page.goto(stack.webUrl);

  await expect(page.locator('.node-name', { hasText: restlessName() })).toBeVisible();
  await expect(page.getByText('Поток: живой')).toBeVisible();

  // Решение уйти принимает агент. Строка называет ЦЕЛЬ, а не оценки, из которых она вышла.
  await expect(page.getByText(/решил уйти отсюда/).first()).toBeVisible({ timeout: 60_000 });

  // И называет дорогу: до I06 её выбирал человек своей же командой и мог не читать; теперь
  // выбирает агент, и без дороги строка скрывает единственное, что в ней есть нового.
  await expect(page.getByText(/вышел в путь: .+ → .+/).first()).toBeVisible({ timeout: 60_000 });

  // Пройденная дорога становится известной — и это ФАКТ летописи, а не побочный эффект.
  await expect(page.getByText(/разведал дорогу: .+ → .+/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.feed')).toContainText('разведал дорогу');

  // Мост опустел: агент ушёл, а не «собирается уйти». Проверяется состоянием карты, а не лентой.
  await expect(page.locator('.node', { hasText: restlessName() }).getByText('пусто')).toBeVisible({
    timeout: 60_000,
  });

  /**
   * STOP-условие итерации в его экранной части: canonical risk не протекает к зрителю.
   *
   * Проверяется словами, которые могли бы прийти ТОЛЬКО из канона: ни поля, ни его перевода на
   * экране нет. Числа опасности здесь не перечисляются — их отсутствие уже доказано контрактом
   * и сверкой сериализованной проекции; экран проверяет, что оно не обошлось текстом.
   */
  await expect(page.locator('body')).not.toContainText('risk');
  await expect(page.locator('body')).not.toContainText('caution');
  await expect(page.locator('body')).not.toContainText('опасн');

  // Чужая память — тоже не то, что видно со стороны: субъективной карты на экране нет.
  await expect(page.locator('body')).not.toContainText('знает');

  // Разбора оценок нет и не будет (§7 `03_TECHNICAL_DESIGN`, ADR-005).
  await expect(page.locator('body')).not.toContainText('switching_cost');
  await expect(page.locator('body')).not.toContainText('urgency');
});
