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

/**
 * Темп 6 минут мира за секунду, а не 60.
 *
 * Скорость выбиралась ради быстрого прогона, и это молча уничтожило то, что критерий D13
 * требует НАБЛЮДАТЬ. При 60 горизонт одного тика (секунда реального времени = 60 минут мира)
 * перекрывает сорокаминутный маршрут целиком: `journey.started` и `journey.completed`
 * рождаются в ОДНОМ тике, и состояние «в пути» не существует ни в один наблюдаемый момент.
 * Сценарий этого не замечал, потому что сверял ленту, а не карту.
 *
 * Найдено съёмкой evidence-пакета (`scripts/evidence/capture-i03.ts`), а не рассуждением:
 * ожидание карточки «В пути» дважды упало по таймауту на мире, который работал правильно.
 *
 * Цена — около семи секунд реального времени на путь. Цена обратного — критерий, который
 * нельзя проверить в принципе.
 */
test.beforeAll(async () => {
  stack = await startWorldStack('journey', { worldMinutesPerRealSecond: 6 });
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

  // D13 требует, чтобы состояние менялось НА КАРТЕ, а не только в ленте. Лента — это журнал
  // произошедшего; карта — это мир сейчас. Проверка одной ленты пропускала бы проекцию, которая
  // исправно копит события и не двигает агентов.
  const travelingCard = page.locator('.node', { hasText: 'В пути' });
  await expect(travelingCard.getByText('Рук → route:yard-to-bridge')).toBeVisible();
  // И он ушёл с прежнего места: остаться в обоих сразу агент не может.
  await expect(
    page.locator('.node', { hasText: 'Тихий двор' }).first().getByText('Рук'),
  ).toBeHidden();

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

test('D3: зритель не влияет на мир — ни один, ни десять, ни ноль', async ({ page }) => {
  const before = stack.cli(['world', 'events']).stdout;

  await page.goto(stack.webUrl);
  await expect(page.getByText('Поток: живой')).toBeVisible();

  /**
   * Критерий называет ТРИ количества: ноль, один и десять. Раньше проверялся только один, и это
   * не придирка к букве: механизм, которым наблюдение могло бы повлиять на мир, — не «страница
   * шлёт команду» (write-маршрутов нет, это D4), а исчерпание ресурса. Десять одновременных SSE
   * держат десять открытых ответов; если бы каждый занимал соединение к базе или ронял API,
   * пострадал бы наблюдатель, а при неудачном устройстве — и сборщик.
   *
   * Клиенты открываются НЕ страницами браузера, а прямыми HTTP-запросами: десять вкладок
   * проверяли бы Playwright, а не сервер.
   */
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const streams = controllers.map(async (controller) => {
    const response = await fetch(`${stack.apiUrl}/v1/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    return response;
  });
  const opened = await Promise.all(streams);
  expect(opened).toHaveLength(10);

  await page.waitForTimeout(5000);

  // И отключаются: критерий требует, чтобы уход клиентов тоже ничего не менял.
  for (const controller of controllers) controller.abort();
  await page.waitForTimeout(1000);

  // Ноль клиентов: страница закрыта, потоков нет.
  await page.goto('about:blank');
  await page.waitForTimeout(2000);

  // API жив после десяти подключений и десяти обрывов — иначе «не влияет на мир» было бы верно
  // и бесполезно: смотреть стало бы нечем.
  const health = await fetch(`${stack.apiUrl}/health`);
  expect(health.ok).toBe(true);
  const snapshot = await fetch(`${stack.apiUrl}/v1/world/snapshot`);
  expect(snapshot.status).toBe(200);

  await page.goto(stack.webUrl);
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
