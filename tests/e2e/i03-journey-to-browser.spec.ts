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

/**
 * D3 — наблюдатель не влияет на мир.
 *
 * ## Почему прежняя редакция ничего не доказывала
 *
 * Она сравнивала журнал до и после окна наблюдения и требовала равенства. Ревьюер показал
 * исполнением, что в этот момент мир СТОИТ: `sequence 0`, в расписании пусто, и `after === before`
 * выполняется тождественно — при любом поведении наблюдателя, включая вредное. Он же проверил
 * обратное: если запустить путь перед окном, тест падает, потому что журнал ЗАКОННО растёт. То
 * есть утверждение теста было «журнал не изменился», а критерий требует «журнал совпадает с
 * журналом прогона БЕЗ подключений», где оба мира идут.
 *
 * ## Как сделано вместо
 *
 * Контроль внутри одного мира: два одинаковых пути по одному маршруту, у двух агентов, стартующих
 * из одной локации. Первый — БЕЗ единого подключения, второй — при десяти открытых SSE. Сравнивается
 * не «журнал не изменился», а ФОРМА того, что мир произвёл: типы событий, локации, маршрут и
 * длительность пути в мировом времени. Наблюдатель, влияющий на мир, изменил бы любую из них.
 *
 * Критерий называет три количества, и все три здесь есть: ноль (первый путь), десять (второй) и
 * обрыв всех десяти перед проверкой.
 */
test('D3: десять зрителей не меняют того, что произвёл мир', async ({ page }) => {
  const legOf = (events: string, agentId: string) =>
    events
      .split('\n')
      .filter((line) => line.includes(agentId))
      .map((line) => {
        const [, , type, worldTime] = /^\s*(\d+)\s+(\S+)\s+(\S+)/.exec(line) ?? [];
        return { type, worldTime };
      });

  const minutesBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000;

  const completedFor = (agentId: string) =>
    stack
      .cli(['world', 'events'])
      .stdout.split('\n')
      .filter((line) => line.includes('journey.completed') && line.includes(agentId)).length;

  /**
   * Оба плеча идут по ОДНОМУ маршруту из ОДНОЙ локации — иначе сравнивать было бы нечего.
   *
   * Агенты выбраны с учётом того, что сценарии делят один мир и идут по порядку: к этому моменту
   * D13 уже перевёл `agent:rook` на мост, а `agent:finch` стоит там с рождения (seed 42). Первая
   * редакция брала `route:yard-to-bridge` и падала названной причиной — «маршрут не начинается в
   * текущей локации актора». Отказ был правильный, неправ был тест.
   */
  // ── Плечо A: ни одного подключения. Страница даже не открыта.
  const legA = stack.cli([
    'world',
    'run',
    '--agent',
    'agent:rook',
    '--route',
    'route:bridge-to-yard',
  ]);
  expect(legA.exitCode, legA.stdout).toBe(0);
  await expect
    .poll(() => completedFor('agent:rook'), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  const afterA = legOf(stack.cli(['world', 'events']).stdout, 'agent:rook').slice(-2);

  // ── Плечо B: тот же маршрут, тот же старт, но при ДЕСЯТИ открытых потоках.
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const opened = await Promise.all(
    controllers.map(async (controller) => {
      const response = await fetch(`${stack.apiUrl}/v1/stream`, { signal: controller.signal });
      expect(response.status).toBe(200);
      return response;
    }),
  );
  expect(opened).toHaveLength(10);
  await page.goto(stack.webUrl);
  await expect(page.getByText('Поток: живой')).toBeVisible();

  const legB = stack.cli([
    'world',
    'run',
    '--agent',
    'agent:finch',
    '--route',
    'route:bridge-to-yard',
  ]);
  expect(legB.exitCode, legB.stdout).toBe(0);
  await expect
    .poll(() => completedFor('agent:finch'), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
  const afterB = legOf(stack.cli(['world', 'events']).stdout, 'agent:finch').slice(-2);

  for (const controller of controllers) controller.abort();

  // Форма произошедшего совпадает: те же типы в том же порядке.
  expect(afterB.map((event) => event.type)).toEqual(afterA.map((event) => event.type));
  expect(afterA.map((event) => event.type)).toEqual(['journey.started', 'journey.completed']);

  // И длительность пути в МИРОВОМ времени одинакова — сорок минут маршрута, а не сколько-то,
  // зависящее от числа зрителей.
  const durationA = minutesBetween(afterA[0]!.worldTime!, afterA[1]!.worldTime!);
  const durationB = minutesBetween(afterB[0]!.worldTime!, afterB[1]!.worldTime!);
  expect(durationA).toBe(40);
  expect(durationB).toBe(durationA);

  // Ноль подключений после обрыва: API жив, смотреть по-прежнему есть чем.
  const health = await fetch(`${stack.apiUrl}/health`);
  expect(health.ok).toBe(true);
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
