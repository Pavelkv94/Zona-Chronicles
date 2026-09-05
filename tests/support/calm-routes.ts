/**
 * Спокойные дороги прототипного мира — те, что ведут туда, откуда агент не уходит сам.
 *
 * С I06-C у мира появилось место, которое агенты покидают по своей воле: мост опасен, и
 * пришедший туда немедленно решает уйти. Это продукт, а не помеха, — но тесты, проверяющие
 * МЕХАНИКУ (перезапуск worker-а, темп, догон проекции), не должны ставить агента в место, из
 * которого он тут же уходит: тогда они проверяют не то, что заявляют, и падают по причине, к
 * их утверждению отношения не имеющей.
 *
 * ## Список объявлен явно, а проверяется ПРОДУКТОВЫМ ПРАВИЛОМ
 *
 * Первая редакция стража сравнивала риски мест: «спокойное не опаснее беспокойного». Независимое
 * ревью I04-I06 (M3) показало, что это утверждение о ПОРЯДКЕ ЧИСЕЛ, а не то, ради чего список
 * заведён. Блокпост числами проходил, а по продуктовому правилу агент с осторожностью ниже 630 —
 * это 12.7% разыгрываемого генезисом диапазона, и при seed 42 таких двое из четырёх — уходит с
 * него по своей воле. Тесты оставались зелёными по ТАЙМИНГУ: в генезисе решение не назначается,
 * первое приходит на первом пороге нужды через семь мировых часов, а тесты механики успевают
 * раньше. Предпосылка была верна, её объявленное основание — нет.
 *
 * Поэтому страж теперь СПРАШИВАЕТ `chooseGoal` — тем же правилом, которым живёт мир, и при всех
 * значениях осторожности, какие мир способен разыграть. Возражение «нельзя проверять мир его же
 * арифметикой» здесь неприменимо: утверждение списка и есть утверждение о выборе цели, и
 * проверять его чем-то другим значит проверять что-то другое.
 */
import { PROTOTYPE_WORLD } from '../../packages/content/src/index.ts';
import {
  chooseGoal,
  type GoalSituation,
  type TravelOption,
} from '../../packages/domain/src/goals.ts';
import {
  PROTOTYPE_GOAL_WEIGHTS,
  PROTOTYPE_REST_MINUTES,
} from '../../packages/domain/src/ports/ruleset.ts';
import { PROTOTYPE_CAUTION_RANGE } from '../../packages/domain/src/ports/ruleset.ts';

/**
 * Места, откуда агент не уходит по своей воле НИ ПРИ КАКОМ характере.
 *
 * Блокпост отсюда убран по находке M3: числами он проходил (риск 300 против 600 у моста), а по
 * продуктовому правилу агент с осторожностью до 626 включительно уходит с него сам — и при
 * seed 42 таких двое из четырёх.
 */
export const CALM_LOCATIONS: readonly string[] = ['loc:quiet-yard', 'loc:ravine'];

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
/**
 * Что решил бы агент, поставленный сюда в свежем мире.
 *
 * Нужды спокойны намеренно: это ХУДШИЙ случай для утверждения «не уходит». Голодному есть чем
 * перебить уход, и место, из которого уходит только сытый, всё равно беспокойное.
 *
 * Дороги неизвестны: свежий мир никем не разведан, и знания у агента нет ни о какой из них.
 */
function goalAt(locationId: string, caution: number): string {
  const location = PROTOTYPE_WORLD.locations.find((node) => node.id === locationId);
  if (location === undefined)
    throw new Error(`calm-routes: локация ${locationId} исчезла из карты`);
  const travelOptions: TravelOption[] = PROTOTYPE_WORLD.routes
    .filter((route) => route.fromLocationId === locationId)
    .map((route) => ({
      routeId: route.id,
      travelMinutes: route.travelMinutes,
      perceivedRisk: null,
    }));
  const situation: GoalSituation = {
    currentGoal: 'idle',
    needLevels: { hunger: 'normal', fatigue: 'normal' },
    hasFood: true,
    isIdle: true,
    restMinutes: PROTOTYPE_REST_MINUTES,
    locationRisk: location.risk,
    travelOptions,
  };
  return chooseGoal(situation, PROTOTYPE_GOAL_WEIGHTS, caution).goal;
}

/**
 * Проверка предпосылки: список обязан соответствовать карте И правилу выбора цели.
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

  // Перебор целиком, а не по границам: цена дороги округляется вверх, и точка, где уход
  // перестаёт окупаться, лежит внутри диапазона, а не на его концах.
  const { minPermille, maxPermille } = PROTOTYPE_CAUTION_RANGE;
  for (let caution = minPermille; caution <= maxPermille; caution += 1) {
    for (const locationId of CALM_LOCATIONS) {
      if (goalAt(locationId, caution) === 'flee') {
        throw new Error(
          `calm-routes: из ${locationId} агент с осторожностью ${String(caution)} уходит сам — ` +
            'место больше не спокойное, список устарел',
        );
      }
    }
    if (goalAt(RESTLESS_LOCATION, caution) !== 'flee') {
      // Обратная сторона: беспокойное место обязано быть беспокойным для ЛЮБОГО характера, иначе
      // сценарий I06-D зелёный или красный в зависимости от того, кого туда поставил seed.
      throw new Error(
        `calm-routes: из ${RESTLESS_LOCATION} агент с осторожностью ${String(caution)} не уходит ` +
          '— демонстрация ухода перестала быть воспроизводимой',
      );
    }
  }
}
