/**
 * D13 — путь виден в браузере и переживает перезагрузку (I03).
 *
 * Единственный сценарий, проверяющий ЦЕПОЧКУ ЦЕЛИКОМ: команда CLI → канонический журнал → outbox
 * → проекция → observer API → экран. Всё, что ниже, уже проверено своими тестами; здесь
 * проверяется именно то, что звенья соединены.
 *
 * Сценарий НЕ трогает мир через браузер и не может: write-маршрутов в публичном API не
 * существует (D4). Путь начинается командой оператора, как в жизни.
 */
import { expect, test } from '@playwright/test';
import { startWorldStack, type WorldStack } from './support/world-stack.ts';

let stack: WorldStack;

test.beforeAll(async () => {
  stack = await startWorldStack('journey');
});

test.afterAll(async () => {
  await stack.stop();
});

test('D13: путь начат командой, виден на карте и в ленте, переживает перезагрузку', async ({
  page,
}) => {
  await page.goto(stack.webUrl);

  // Мир только создан: карта есть, лента пуста.
  await expect(page.getByText('Тихий двор')).toBeVisible();
  await expect(page.getByText('Пока ничего не произошло.')).toBeVisible();
  await expect(page.getByText('Рук')).toBeVisible();

  // Дожидаемся живого потока: без него следующая проверка доказывала бы работу перезагрузки,
  // а не обновления без неё.
  await expect(page.getByText('Поток: живой')).toBeVisible();

  const started = stack.cli([
    'world',
    'run',
    '--agent',
    'agent:rook',
    '--route',
    'route:yard-to-bridge',
  ]);
  expect(started.exitCode, started.stdout).toBe(0);

  // БЕЗ ПЕРЕЗАГРУЗКИ: событие приходит потоком.
  await expect(page.getByText('journey.started').first()).toBeVisible();
  await expect(page.getByText('agent:rook вышел в путь — loc:quiet-yard')).toBeVisible();

  // Мир доводит путь до конца сам — ни одной команды между этими строками.
  await expect(page.getByText('journey.completed').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('agent:rook дошёл — loc:bridge')).toBeVisible();

  // Агент оказался в конечной локации: проверяем В КАРТОЧКЕ моста, а не «где-то на странице».
  const bridgeCard = page.locator('.node', { hasText: 'Мост' }).first();
  await expect(bridgeCard.getByText('Рук')).toBeVisible();

  const worldTimeBefore = await page.locator('.status').innerText();

  // D11: перезагрузка восстанавливает то же состояние — snapshot-ом, а не историей потока.
  await page.reload();
  await expect(page.getByText('agent:rook дошёл — loc:bridge')).toBeVisible();
  await expect(page.locator('.node', { hasText: 'Мост' }).first().getByText('Рук')).toBeVisible();
  expect(await page.locator('.status').innerText()).toBe(worldTimeBefore);

  // Увиденное совпадает с каноническим журналом: сверяем с CLI, а не с самим экраном.
  const events = stack.cli(['world', 'events']);
  expect(events.exitCode, events.stdout).toBe(0);
  expect(events.stdout).toContain('journey.started');
  expect(events.stdout).toContain('journey.completed');
  expect(events.stdout).toContain('agent:rook');
});

test('D3: зритель не влияет на мир — открытая страница не порождает событий', async ({ page }) => {
  const before = stack.cli(['world', 'events']).stdout;

  await page.goto(stack.webUrl);
  await expect(page.getByText('Поток: живой')).toBeVisible();
  // Держим страницу открытой заметное время: если бы наблюдение двигало мир, событий бы прибыло.
  await page.waitForTimeout(5000);
  await page.reload();
  await expect(page.getByText('Карта мира')).toBeVisible();

  const after = stack.cli(['world', 'events']).stdout;
  expect(after).toBe(before);
});

test('D12: путь к недостижимой локации отвергается названной причиной', () => {
  const rejected = stack.cli([
    'world',
    'run',
    '--agent',
    'agent:kite',
    '--route',
    'route:to-relay-station',
  ]);
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stdout.toLowerCase()).toMatch(/маршрут|route/);
});
