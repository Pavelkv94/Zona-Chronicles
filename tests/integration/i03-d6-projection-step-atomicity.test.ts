/**
 * D6 — шаг проекции атомарен: лента и курсор двигаются ВМЕСТЕ или не двигаются вовсе.
 *
 * ## Почему это отдельный тест, а не следствие убийства процесса
 *
 * D6 сформулирован как «процесс сборщика убит и запущен заново». Acceptance-тест
 * `i03-d6-projection-restart` действительно убивает настоящий процесс `SIGKILL` и проверяет
 * результат — и этого НЕДОСТАТОЧНО, что установлено исполнением, а не рассуждением.
 *
 * Проба: границу транзакции внутри `saveProjectionStep` временно разорвали (курсор стал
 * продвигаться отдельной транзакцией через 120 мс после записи ленты). Acceptance-тест с
 * убийствами прошёл ПЯТЬ раз из пяти. Причина в арифметике, а не в удаче: убийство приходится на
 * фиксированный момент после старта процесса, окно уязвимости — 120 мс на шаг, и попасть в него
 * систематически нельзя. Тест, который ловит дефект «иногда», в gate хуже, чем отсутствие теста:
 * он создаёт впечатление проверки и добавляет мигание.
 *
 * Поэтому атомарность проверяется там, где она объявлена, — на границе транзакции, и
 * детерминированно. Убийство процесса остаётся и доказывает своё: перезапуск читает курсор из
 * базы, а не из памяти, и не задваивает уже применённое.
 *
 * ## Где именно вызывается отказ, и почему не где попало
 *
 * Отказ обязан прийти НА ПОСЛЕДНЕМ шаге — на записи курсора, — и это выяснилось мутационной
 * пробой. Первая редакция роняла вторую запись ленты (повтор `projection_sequence`, отвергаемый
 * первичным ключом) и проверяла, что первая тоже не сохранилась. Такой тест проходит и на
 * РАЗОРВАННОЙ границе: если курсор двигать отдельной транзакцией, она просто не начнётся —
 * первая транзакция уже упала. Проба это и показала: разрыв границы прошёл незамеченным.
 *
 * Здесь отказ приходит на `update projection_state`: `check (projection_sequence >= 0)` отвергает
 * отрицательный курсор. К этому моменту записи ленты и агентов уже выполнены. Дальше две
 * конструкции расходятся наблюдаемо:
 *
 *   одна транзакция — откат целиком, лента пуста;
 *   две транзакции — лента ЗАКОММИЧЕНА, курсор остался на нуле, и следующий запуск сборщика
 *   вечно упирается в первичный ключ, пытаясь выдать уже занятый `projection_sequence`.
 *
 * Отказ приходит из БАЗЫ, без единого шва в рабочем коде.
 *
 * ## Почему тест лежит здесь, а не в `packages/projections`
 *
 * Ему нужна фикстура мигрированной базы из `packages/persistence`, а `projections` импортировать
 * `persistence` НЕ МОЖЕТ: `observer-api-does-not-reach-persistence` в `.dependency-cruiser.cjs`
 * действует транзитивно, и один такой импорт — даже в тестовом файле — открыл бы observer-пути
 * дорогу к каноническому хранилищу. Кросс-пакетные наборы живут в `tests/`, где границы пакетов
 * не нарушаются по построению. Импорты относительные — `tests/` не workspace-пакет.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObserverEvent } from '../../packages/contracts/src/index.ts';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../packages/persistence/src/__fixtures__/migrated-database.ts';
import type { ProjectionDatabase } from '../../packages/projections/src/projection-database.ts';
import {
  createProjectionDatabase,
  initialObserverProjection,
  initializeProjection,
  loadObserverEvents,
  loadProjectionCursor,
  parseProjectionDatabaseUrl,
  saveProjectionStep,
  type ObserverProjectionState,
} from '../../packages/projections/src/index.ts';

const WORLD_ID = 'world:atomicity';
const GENESIS_TIME = '2028-04-26T06:00:00.000Z';

const seedState = (): ObserverProjectionState =>
  initialObserverProjection({
    worldId: WORLD_ID,
    worldTime: GENESIS_TIME,
    nodes: [{ location_id: 'loc:a', name: 'А', description: 'узел А' }],
    edges: [
      {
        route_id: 'route:a-b',
        from_location_id: 'loc:a',
        to_location_id: 'loc:b',
        travel_minutes: 10,
      },
    ],
    agents: [
      { agent_id: 'agent:one', name: 'Один', location_id: 'loc:a', status: 'idle', route_id: null },
    ],
  });

const feedEntry = (projectionSequence: number, eventId: string): ObserverEvent => ({
  projection_sequence: projectionSequence,
  event_id: eventId,
  world_time: '2028-04-26T06:10:00.000Z',
  type: 'journey.started',
  actor_ids: ['agent:one'],
  location_id: 'loc:a',
  route_id: 'route:a-b',
});

describe('D6 — шаг проекции атомарен', () => {
  let migrated: MigratedDatabase;
  let projection: ProjectionDatabase;

  beforeAll(async () => {
    migrated = await createMigratedDatabase('projection_atomicity');
    projection = createProjectionDatabase(parseProjectionDatabaseUrl(migrated.testDb.url));
    const state = seedState();
    await initializeProjection(
      projection,
      state,
      { nodes: Object.values(state.nodes), edges: Object.values(state.edges) },
      new Date(),
    );
  }, 120_000);

  afterAll(async () => {
    await projection.destroy();
    await migrated.close();
  });

  it('отказ НА ЗАПИСИ КУРСОРА откатывает и уже записанную ленту', async () => {
    const before = await loadProjectionCursor(projection, WORLD_ID);
    expect(before?.projectionSequence).toBe(0);

    const state: ObserverProjectionState = {
      ...seedState(),
      // Отрицательный курсор отвергается `check (projection_sequence >= 0)` таблицы
      // projection_state — то есть НА ПОСЛЕДНЕМ шаге, когда лента уже вставлена.
      projectionSequence: -1,
      lastEventSequence: 5,
      worldTime: '2028-04-26T06:10:00.000Z',
    };

    await expect(
      saveProjectionStep(projection, state, [feedEntry(1, 'evt_first')], new Date()),
    ).rejects.toThrow();

    // Ключевая проверка: запись ленты, сделанная ДО отказа, не сохранилась.
    const feed = await loadObserverEvents(projection, WORLD_ID, { after: 0, limit: 100 });
    expect(feed.events).toEqual([]);

    const after = await loadProjectionCursor(projection, WORLD_ID);
    expect(after?.projectionSequence).toBe(0);
    expect(after?.lastEventSequence).toBe(0);
  });

  it('успешный шаг двигает и ленту, и курсор — иначе предыдущая проверка проходила бы на сломанной записи', async () => {
    const state: ObserverProjectionState = {
      ...seedState(),
      projectionSequence: 1,
      lastEventSequence: 7,
      worldTime: '2028-04-26T06:10:00.000Z',
    };

    await saveProjectionStep(projection, state, [feedEntry(1, 'evt_ok')], new Date());

    const feed = await loadObserverEvents(projection, WORLD_ID, { after: 0, limit: 100 });
    expect(feed.events.map((event) => event.event_id)).toEqual(['evt_ok']);

    const cursor = await loadProjectionCursor(projection, WORLD_ID);
    expect(cursor?.projectionSequence).toBe(1);
    expect(cursor?.lastEventSequence).toBe(7);
  });
});
