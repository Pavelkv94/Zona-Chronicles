/**
 * Спокойные дороги прототипного мира — те, что ведут туда, откуда агент не уходит сам.
 *
 * С I06-C у мира появилось место, которое агенты покидают по своей воле: мост опасен, и
 * пришедший туда немедленно решает уйти. Это продукт, а не помеха, — но тесты, проверяющие
 * МЕХАНИКУ (перезапуск worker-а, темп, догон проекции), не должны ставить агента в место, из
 * которого он тут же уходит: тогда они проверяют не то, что заявляют, и падают по причине, к
 * их утверждению отношения не имеющей.
 *
 * Список назван явно, а не выведен из коэффициентов. Вывод потребовал бы повторить здесь правило
 * выбора цели — то есть проверять мир его же арифметикой. Явный список при изменении карты
 * падает громко (проверка ниже), и это ровно то поведение, которое нужно.
 */
import { PROTOTYPE_WORLD } from '../../packages/content/src/index.ts';

/** Места, откуда агент не уходит по своей воле: их опасность ниже цены любого ухода. */
export const CALM_LOCATIONS: readonly string[] = ['loc:quiet-yard', 'loc:ravine', 'loc:checkpoint'];

/** Место, которое агенты покидают сами. Названо, чтобы «спокойные» читались как НЕ оно. */
export const RESTLESS_LOCATION = 'loc:bridge';

/**
 * Расстановка агентов из вывода `world state`.
 *
 * Живёт здесь, а не в каждом тесте: три копии одного разбора разошлись бы при первой же правке
 * формата вывода, и разошлись бы молча — тест с устаревшим разбором просто перестал бы находить
 * агентов и стал бы зелёным на пустом множестве.
 */
export function parseAgentLocations(stateOutput: string): Readonly<Record<string, string>> {
  const locations: Record<string, string> = {};
  for (const line of stateOutput.split('\n')) {
    const match = /(agent:[a-z-]+)\s+idle\s+в (loc:[a-z-]+)/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) locations[match[1]] = match[2];
  }
  return locations;
}

export interface CalmLeg {
  readonly agentId: string;
  readonly routeId: string;
  readonly travelMinutes: number;
  readonly toLocationId: string;
}

/**
 * Дорога в спокойное место для каждого агента, стоящего в спокойном месте.
 *
 * Агенты, оказавшиеся в беспокойном месте, пропускаются: им и без оператора есть чем заняться.
 */
export function calmLegs(agentLocations: Readonly<Record<string, string>>): readonly CalmLeg[] {
  const legs: CalmLeg[] = [];
  for (const [agentId, locationId] of Object.entries(agentLocations)) {
    if (!CALM_LOCATIONS.includes(locationId)) continue;
    const route = PROTOTYPE_WORLD.routes.find(
      (candidate) =>
        candidate.fromLocationId === locationId && CALM_LOCATIONS.includes(candidate.toLocationId),
    );
    if (route === undefined) continue;
    legs.push({
      agentId,
      routeId: route.id,
      travelMinutes: route.travelMinutes,
      toLocationId: route.toLocationId,
    });
  }
  return legs;
}

/**
 * Проверка предпосылки: список спокойных мест обязан соответствовать карте.
 *
 * Вызывается тестами, которые на него опираются. Молчаливое расхождение дало бы тесты, зелёные
 * по неверной причине: агент ушёл бы сам, а тест решил бы, что так и было задумано.
 */
export function assertCalmLocationsMatchMap(): void {
  const known = new Set(PROTOTYPE_WORLD.locations.map((location) => location.id));
  for (const id of [...CALM_LOCATIONS, RESTLESS_LOCATION]) {
    if (!known.has(id)) {
      throw new Error(`calm-routes: локация ${id} исчезла из карты — список устарел`);
    }
  }
  const restless = PROTOTYPE_WORLD.locations.find((location) => location.id === RESTLESS_LOCATION);
  const calmest = PROTOTYPE_WORLD.locations
    .filter((location) => CALM_LOCATIONS.includes(location.id))
    .map((location) => location.risk);
  if (restless === undefined || Math.max(...calmest) >= restless.risk) {
    throw new Error(
      'calm-routes: беспокойное место перестало быть опаснее спокойных — список устарел',
    );
  }
}
