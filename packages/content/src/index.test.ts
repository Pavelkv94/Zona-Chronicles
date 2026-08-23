/**
 * Инварианты `PROTOTYPE_WORLD` (I01, PLAN §6: "1 мир, 2–4 локации, 1–2 маршрута, 3–5 агентов").
 *
 * Пакет не может импортировать `@zona/contracts` (правило `content-is-data-only`, см.
 * `packages/content/src/index.ts`), поэтому форма id здесь проверяется своей копией паттерна,
 * а не переиспользованием `NAMESPACED_ID_PATTERN` — не потому что правило другое, а потому что
 * этот пакет физически не может сослаться на источник истины.
 */
import { describe, expect, it } from 'vitest';
import { CONTENT_VERSION, PROTOTYPE_WORLD } from './index.ts';

const NAMESPACED_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;

function uniqueIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

describe('PROTOTYPE_WORLD (PLAN §6 fixtures)', () => {
  it('содержит world id в форме namespaced id', () => {
    expect(PROTOTYPE_WORLD.worldId).toMatch(NAMESPACED_ID);
    expect(PROTOTYPE_WORLD.worldId.startsWith('world:')).toBe(true);
  });

  it('содержит от 2 до 4 локаций (PLAN §6)', () => {
    expect(PROTOTYPE_WORLD.locations.length).toBeGreaterThanOrEqual(2);
    expect(PROTOTYPE_WORLD.locations.length).toBeLessThanOrEqual(4);
  });

  /**
   * Верхняя граница поднята в I03 (master-plan: «расширение fixture до 3 location и нескольких
   * routes»). Ограничение «1–2 маршрута» пришло из PLAN §6 итерации I01, где мир только
   * порождался и никуда не шёл; после I03 за ним наблюдают, а мир без обратных маршрутов
   * замирает через несколько переходов. Нижняя граница не тронута.
   */
  it('содержит от 1 до 6 маршрутов (I03: связный граф с возвратом)', () => {
    expect(PROTOTYPE_WORLD.routes.length).toBeGreaterThanOrEqual(1);
    expect(PROTOTYPE_WORLD.routes.length).toBeLessThanOrEqual(6);
  });

  /**
   * D12: недостижимая локация обязана существовать в контенте, иначе критерий «отказ несвязного
   * маршрута виден и объясним» нечем проверить — а исчезнуть она может незаметно, одной правкой
   * контента.
   */
  it('в мире есть локация, к которой не ведёт ни один маршрут (D12)', () => {
    const touched = new Set(
      PROTOTYPE_WORLD.routes.flatMap((route) => [route.fromLocationId, route.toLocationId]),
    );
    const isolated = PROTOTYPE_WORLD.locations.filter((location) => !touched.has(location.id));
    expect(isolated.map((location) => location.id)).toContain('loc:relay-station');
  });

  /**
   * Мир, из которого нельзя вернуться, наблюдать нечем: агенты упираются в тупик и замирают.
   * Проверяется наличие обратного маршрута у каждого прямого — не «маршрутов стало больше».
   */
  it('каждый маршрут имеет обратный (I03)', () => {
    const pairs = new Set(
      PROTOTYPE_WORLD.routes.map((route) => `${route.fromLocationId}>${route.toLocationId}`),
    );
    for (const route of PROTOTYPE_WORLD.routes) {
      expect(pairs).toContain(`${route.toLocationId}>${route.fromLocationId}`);
    }
  });

  it('содержит от 3 до 5 агентов (PLAN §6)', () => {
    expect(PROTOTYPE_WORLD.agents.length).toBeGreaterThanOrEqual(3);
    expect(PROTOTYPE_WORLD.agents.length).toBeLessThanOrEqual(5);
  });

  it('id локаций уникальны и имеют форму namespaced id с префиксом loc:', () => {
    const ids = PROTOTYPE_WORLD.locations.map((location) => location.id);
    expect(uniqueIds(ids)).toBe(true);
    for (const id of ids) {
      expect(id).toMatch(NAMESPACED_ID);
      expect(id.startsWith('loc:')).toBe(true);
    }
  });

  it('id агентов уникальны и имеют форму namespaced id с префиксом agent:', () => {
    const ids = PROTOTYPE_WORLD.agents.map((agent) => agent.id);
    expect(uniqueIds(ids)).toBe(true);
    for (const id of ids) {
      expect(id).toMatch(NAMESPACED_ID);
      expect(id.startsWith('agent:')).toBe(true);
    }
  });

  it('id маршрутов уникальны, а from/to ссылаются на объявленные локации', () => {
    const locationIds = new Set(PROTOTYPE_WORLD.locations.map((location) => location.id));
    const routeIds = PROTOTYPE_WORLD.routes.map((route) => route.id);
    expect(uniqueIds(routeIds)).toBe(true);

    for (const route of PROTOTYPE_WORLD.routes) {
      expect(route.id).toMatch(NAMESPACED_ID);
      expect(route.id.startsWith('route:')).toBe(true);
      expect(
        locationIds.has(route.fromLocationId),
        `route ${route.id}: fromLocationId неизвестен`,
      ).toBe(true);
      expect(
        locationIds.has(route.toLocationId),
        `route ${route.id}: toLocationId неизвестен`,
      ).toBe(true);
      expect(route.fromLocationId).not.toBe(route.toLocationId);
    }
  });

  it('travelMinutes — положительное конечное целое (A5: конечность и явная единица)', () => {
    for (const route of PROTOTYPE_WORLD.routes) {
      expect(Number.isInteger(route.travelMinutes)).toBe(true);
      expect(route.travelMinutes).toBeGreaterThan(0);
    }
  });

  it('initialWorldTime — валидный ISO-8601 момент с явным смещением', () => {
    // Полный разбор — привилегия @zona/contracts (сюда его нельзя импортировать); здесь
    // проверяется только форма, которую этот пакет обязан гарантировать сам.
    expect(PROTOTYPE_WORLD.initialWorldTime).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
    );
  });

  it('CONTENT_VERSION — semantic version MAJOR.MINOR.PATCH', () => {
    expect(CONTENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
