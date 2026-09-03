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
import { PROTOTYPE_WORLD } from '../../packages/content/src/index.ts';
import {
  assertCalmLocationsMatchMap,
  calmLegs,
  parseAgentLocations,
} from '../support/calm-routes.ts';
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

/**
 * Спокойная дорога для агента, выведенная из карты и текущей расстановки.
 *
 * С I06-C мир перестал быть неподвижным между командами оператора: пришедший в опасное место
 * агент немедленно уходит сам, и «агент виден на карте в точке прибытия» переставало быть
 * верным к моменту проверки. Расстановка же меняется вместе с картой, поэтому пара «агент —
 * маршрут» больше не выписывается руками.
 */
const calmLeg = (): {
  agentId: string;
  agentName: string;
  routeId: string;
  fromName: string;
  toName: string;
} => {
  assertCalmLocationsMatchMap();
  const state = stack.cli(['world', 'state']);
  expect(state.exitCode, state.stdout).toBe(0);
  const [leg] = calmLegs(parseAgentLocations(state.stdout));
  if (leg === undefined) throw new Error('ни один агент не стоит в спокойном месте');
  const route = PROTOTYPE_WORLD.routes.find((candidate) => candidate.id === leg.routeId);
  const nameOf = (locationId: string): string =>
    PROTOTYPE_WORLD.locations.find((location) => location.id === locationId)?.name ?? locationId;
  return {
    agentId: leg.agentId,
    agentName:
      PROTOTYPE_WORLD.agents.find((agent) => agent.id === leg.agentId)?.name ?? leg.agentId,
    routeId: leg.routeId,
    fromName: nameOf(route?.fromLocationId ?? ''),
    toName: nameOf(leg.toLocationId),
  };
};

test('D13: путь начат командой, виден на карте и в ленте, переживает перезагрузку', async ({
  page,
}) => {
  await page.goto(stack.webUrl);

  const leg = calmLeg();

  // Мир только создан: карта есть, лента пуста.
  await expect(page.getByText('Тихий двор')).toBeVisible();
  await expect(page.getByText('Пока ничего не произошло.')).toBeVisible();
  await expect(page.getByText(leg.agentName).first()).toBeVisible();

  // Дожидаемся живого потока: без него следующая проверка доказывала бы работу перезагрузки,
  // а не обновления без неё.
  await expect(page.getByText('Поток: живой')).toBeVisible();

  const started = stack.cli(['world', 'run', '--agent', leg.agentId, '--route', leg.routeId]);
  expect(started.exitCode, started.stdout).toBe(0);

  // БЕЗ ПЕРЕЗАГРУЗКИ: событие приходит потоком.
  await expect(page.getByText('journey.started').first()).toBeVisible();
  await expect(page.getByText(`${leg.agentId} вышел в путь`).first()).toBeVisible();

  // D13 требует, чтобы состояние менялось НА КАРТЕ, а не только в ленте. Лента — это журнал
  // произошедшего; карта — это мир сейчас. Проверка одной ленты пропускала бы проекцию, которая
  // исправно копит события и не двигает агентов.
  const travelingCard = page.locator('.node', { hasText: 'В пути' });
  await expect(travelingCard.getByText(`${leg.agentName} → ${leg.routeId}`)).toBeVisible();
  // И он ушёл с прежнего места: остаться в обоих сразу агент не может.
  await expect(
    page.locator('.node', { hasText: leg.fromName }).first().getByText(leg.agentName),
  ).toBeHidden();

  // Мир доводит путь до конца сам — ни одной команды между этими строками.
  await expect(page.getByText('journey.completed').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(`${leg.agentId} дошёл`).first()).toBeVisible();

  // Агент оказался в конечной локации: проверяем В КАРТОЧКЕ места, а не «где-то на странице».
  const arrivalCard = page.locator('.node', { hasText: leg.toName }).first();
  await expect(arrivalCard.getByText(leg.agentName)).toBeVisible();

  const worldTimeBefore = await page.locator('.status').innerText();

  // D11: перезагрузка восстанавливает то же состояние — snapshot-ом, а не историей потока.
  await page.reload();
  await expect(page.getByText(`${leg.agentId} дошёл`).first()).toBeVisible();
  await expect(
    page.locator('.node', { hasText: leg.toName }).first().getByText(leg.agentName),
  ).toBeVisible();
  expect(await page.locator('.status').innerText()).toBe(worldTimeBefore);

  // Увиденное совпадает с каноническим журналом: сверяем с CLI, а не с самим экраном.
  const events = stack.cli(['world', 'events']);
  expect(events.exitCode, events.stdout).toBe(0);
  expect(events.stdout).toContain('journey.started');
  expect(events.stdout).toContain('journey.completed');
  expect(events.stdout).toContain(leg.agentId);
});

test('D3: десять зрителей не меняют того, что произвёл мир', async ({ page }) => {
  /**
   * События пути конкретного агента.
   *
   * `goal.chosen` и `risk.observed` отфильтрованы намеренно: с I05-B прибывший агент СВОБОДЕН и
   * немедленно выбирает, что делать дальше, а с I06-B он ещё и узнаёт пройденную дорогу. Оба
   * факта правильные, но к утверждению D3 — «число зрителей не меняет того, что произвёл мир» —
   * отношения не имеют: здесь сравнивается путь.
   * Форма сравнения при этом остаётся точной, а не «содержит»: выпавший или лишний шаг ПУТИ
   * по-прежнему роняет тест.
   */
  const legOf = (events: string, agentId: string) =>
    events
      .split('\n')
      .filter(
        (line) =>
          line.includes(agentId) &&
          !line.includes('goal.chosen') &&
          !line.includes('risk.observed'),
      )
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
   * Оба плеча идут по одинаковым дорогам, выведенным из карты и расстановки.
   *
   * Раньше пары «агент — маршрут» были выписаны руками и держались на том, где агенты оказались
   * при seed 42 и куда их успел перевести предыдущий сценарий. И то и другое меняется вместе с
   * картой; тест дважды падал названной причиной «маршрут не начинается в текущей локации
   * актора» — отказ был правильный, неправ был тест.
   *
   * Дороги берутся спокойные: с I06-C агент, попавший в опасное место, уходит сам, и «мир
   * произвёл ровно это» перестало бы быть утверждением об операторе.
   */
  assertCalmLocationsMatchMap();
  const legsBefore = calmLegs(parseAgentLocations(stack.cli(['world', 'state']).stdout));
  const [first, second] = legsBefore;
  expect(first, 'нужны двое агентов в спокойных местах').toBeDefined();
  expect(second, 'нужны двое агентов в спокойных местах').toBeDefined();
  if (first === undefined || second === undefined) return;

  // ── Плечо A: ни одного подключения. Страница даже не открыта.
  //
  // Ожидание считается от ПРИРОСТА, а не от абсолютного числа: сценарии делят один мир, и агент
  // мог завершить путь ещё в D13. Абсолютный порог тогда выполняется мгновенно, и сравнивались
  // бы события прошлого сценария — что и произошло.
  const completedA = completedFor(first.agentId);
  const legA = stack.cli(['world', 'run', '--agent', first.agentId, '--route', first.routeId]);
  expect(legA.exitCode, legA.stdout).toBe(0);
  await expect
    .poll(() => completedFor(first.agentId), { timeout: 60_000 })
    .toBeGreaterThan(completedA);
  const afterA = legOf(stack.cli(['world', 'events']).stdout, first.agentId).slice(-2);

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

  const completedB = completedFor(second.agentId);
  const legB = stack.cli(['world', 'run', '--agent', second.agentId, '--route', second.routeId]);
  expect(legB.exitCode, legB.stdout).toBe(0);
  await expect
    .poll(() => completedFor(second.agentId), { timeout: 60_000 })
    .toBeGreaterThan(completedB);
  const afterB = legOf(stack.cli(['world', 'events']).stdout, second.agentId).slice(-2);

  for (const controller of controllers) controller.abort();

  // Форма произошедшего совпадает: те же типы в том же порядке.
  expect(afterB.map((event) => event.type)).toEqual(afterA.map((event) => event.type));
  expect(afterA.map((event) => event.type)).toEqual(['journey.started', 'journey.completed']);

  // И длительность пути в МИРОВОМ времени — ровно та, что записана у дороги, а не сколько-то,
  // зависящее от числа зрителей.
  const durationA = minutesBetween(afterA[0]!.worldTime!, afterA[1]!.worldTime!);
  const durationB = minutesBetween(afterB[0]!.worldTime!, afterB[1]!.worldTime!);
  // Длительность берётся ИЗ КАРТЫ, а не из числа в тесте: дороги выбираются по расстановке, и
  // выписанное число проверяло бы согласие карты с моей памятью о ней.
  const minutesOf = (routeId: string): number =>
    PROTOTYPE_WORLD.routes.find((route) => route.id === routeId)?.travelMinutes ?? 0;
  expect(durationA).toBe(minutesOf(first.routeId));
  expect(durationB).toBe(minutesOf(second.routeId));

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
