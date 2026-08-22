/**
 * `decide(state, command, context) -> events | typed rejection` — первый slice (§11):
 * `journey.start` → `journey.started`. `journey.completed` и `plan.invalidated` уже описаны в
 * `@zona/contracts`, но их порождение требует scheduled action (I02A/I02B) и здесь не
 * реализуется (§5 плана итерации, "out of scope").
 *
 * `context` содержит только явные зависимости — мировое время, PRNG, версии правил и id factory
 * (ADR-003) — и ничего сверх этого: домен не читает `process`, часы или сеть напрямую (A6).
 *
 * Ожидаемые отказы — типизированный `DecideRejection` из замороженного перечисления
 * `CommandRejectionCode` (`@zona/contracts`), а не брошенное исключение: команда — обычный
 * вход, отказ по домену — обычный, ожидаемый результат (`09_EVENT_AND_COMMAND_CONTRACTS` §2).
 */
import {
  RUNTIME_ID_PREFIXES,
  isInstantError,
  parseCanonicalInstant,
  requireAddMinutes,
  type Command,
  type CommandRejectionCode,
  type Instant,
  type JourneyCompletedEvent,
  type JourneyStartedEvent,
  type PlanInvalidatedEvent,
} from '@zona/contracts';
import type { Clock } from './ports/clock.ts';
import type { IdFactory } from './ports/id-factory.ts';
import type { RandomSource } from './ports/random-source.ts';
import type { Ruleset } from './ports/ruleset.ts';
import type { WorldState } from './state.ts';

export interface DecideContext {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly ids: IdFactory;
  readonly ruleset: Ruleset;
}

export interface DecideRejection {
  readonly code: CommandRejectionCode;
  readonly message: string;
}

/**
 * Факт, ещё не помеченный операционным `recorded_at`: домен его не знает (SIM-01, комментарий
 * `world-event.ts` — "recorded_at… не участвует в доменной логике"). Слой, который проставляет
 * `recorded_at` при записи факта (реальный wall clock), — адаптер персистентности (I02A), вне
 * домена; здесь событие остаётся "черновиком" до этого шага.
 *
 * Явное перечисление вариантов, а не `Omit<WorldEvent, 'recorded_at'>`: встроенный `Omit`
 * применяется к `keyof (A|B|C)`, а не к каждому варианту union по отдельности, и «плющит»
 * дискриминированный union в `payload`, который перестаёт сужаться по `type`.
 */
export type DraftWorldEvent =
  | Omit<JourneyStartedEvent, 'recorded_at'>
  | Omit<JourneyCompletedEvent, 'recorded_at'>
  | Omit<PlanInvalidatedEvent, 'recorded_at'>;

export type DecideResult =
  | { readonly kind: 'accepted'; readonly events: readonly DraftWorldEvent[] }
  | { readonly kind: 'rejected'; readonly rejection: DecideRejection };

/**
 * Проверка optimistic concurrency, выполняемая ТОЛЬКО когда команда её запросила (ADR-011).
 *
 * Отсутствие `expected_world_version` — это не «версия ноль», а «проверять нечего»: так
 * помечают команду, выведенную из уже принятого факта мира. Сериализацию для неё обеспечивает
 * замок мира в адаптере персистентности, а не сравнение версий.
 */
function checkExpectedVersion(state: WorldState, command: Command): DecideResult | null {
  if (command.expected_world_version === undefined) return null;
  if (command.expected_world_version === state.worldVersion) return null;
  return rejected(
    'stale_world_version',
    `команда ожидала версию мира ${command.expected_world_version}, текущая версия ${state.worldVersion}`,
  );
}

function rejected(code: CommandRejectionCode, message: string): DecideResult {
  return { kind: 'rejected', rejection: { code, message } };
}

/**
 * Момент, инъектированный `Clock`/полученный из `addMinutes`, приводится к КАНОНИЧЕСКОЙ форме
 * (`…T18:20:00.000Z`) перед тем, как попасть в событие: `Clock.now()` обязан отдавать валидный
 * `Instant`, но не обязан отдавать канонический текст, а SIM-01/A3 требуют, чтобы один и тот же
 * момент давал один и тот же checksum независимо от смещения или числа знаков дробной части
 * источника (тот же довод, что в `world-event.ts`/`change request A4`).
 */
function toCanonicalIso(instant: Instant): string {
  const canonical = parseCanonicalInstant(instant.iso);
  if (isInstantError(canonical)) {
    throw new Error(`decide: момент из Clock/addMinutes невалиден: ${canonical.error}`);
  }
  return canonical.iso;
}

export function decide(state: WorldState, command: Command, context: DecideContext): DecideResult {
  switch (command.type) {
    case 'journey.start':
      return decideJourneyStart(state, command, context);
    case 'journey.complete':
      return decideJourneyComplete(state, command, context);
    default:
      return assertNeverCommand(command);
  }
}

/**
 * Завершение пути (I02B).
 *
 * Идёт тем же путём, что внешняя команда, и это решение, а не удобство: у мира должен быть
 * ОДИН способ измениться. Отдельная ветка «домен для scheduled actions» дала бы второй, со
 * своими правилами и своими отказами, и расхождение между ними было бы невидимым.
 *
 * Отказы здесь — обычные доменные отказы, а не ошибки scheduler-а: due action мог устареть,
 * пока ждал своей очереди (агент уже завершил путь другим способом, маршрут изменился), и это
 * нормальный исход, который обязан быть записан, а не брошен.
 */
function decideJourneyComplete(
  state: WorldState,
  command: Extract<Command, { type: 'journey.complete' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined) {
    return rejected('actor_not_actionable', `актор ${command.actor_id} неизвестен миру`);
  }
  if (agent.status !== 'traveling' || agent.routeId !== command.payload.route_id) {
    return rejected(
      'precondition_failed',
      agent.status !== 'traveling'
        ? `актор ${command.actor_id} не в пути (статус "${agent.status}")`
        : `актор ${command.actor_id} идёт по маршруту ${String(agent.routeId)}, а не по ` +
            `${command.payload.route_id}`,
    );
  }

  const route = state.routes[command.payload.route_id];
  if (route === undefined) {
    return rejected('route_unavailable', `маршрут ${command.payload.route_id} неизвестен миру`);
  }

  const worldTime = context.clock.now();
  const versions = context.ruleset.versions;

  const event: Omit<JourneyCompletedEvent, 'recorded_at'> = {
    event_id: context.ids.next(RUNTIME_ID_PREFIXES.event),
    world_id: state.worldId,
    sequence: state.sequence + 1,
    world_time: toCanonicalIso(worldTime),
    type: 'journey.completed',
    schema_version: versions.schemaVersion,
    rules_version: versions.rulesVersion,
    content_version: versions.contentVersion,
    actor_ids: [command.actor_id],
    subject_ids: [],
    location_id: route.toLocationId,
    correlation_id: command.correlation_id,
    caused_by: command.caused_by_event_id === undefined ? [] : [command.caused_by_event_id],
    command_id: command.command_id,
    random_audit: null,
    payload: { route_id: route.id },
  };

  return { kind: 'accepted', events: [event] };
}

/**
 * Исчерпывающая обработка типов команд проверяется КОМПИЛЯТОРОМ (тот же приём, что в `evolve`):
 * новый тип команды без ветки здесь не сузится до `never`, и `pnpm typecheck` упадёт раньше,
 * чем код дойдёт до review.
 */
function assertNeverCommand(command: never): never {
  throw new Error(`decide: необработанный тип команды ${JSON.stringify(command)}`);
}

function decideJourneyStart(
  state: WorldState,
  command: Extract<Command, { type: 'journey.start' }>,
  context: DecideContext,
): DecideResult {
  const staleness = checkExpectedVersion(state, command);
  if (staleness !== null) return staleness;

  const agent = state.agents[command.actor_id];
  if (agent === undefined || agent.status !== 'idle') {
    return rejected(
      'actor_not_actionable',
      agent === undefined
        ? `актор ${command.actor_id} неизвестен миру`
        : `актор ${command.actor_id} уже в статусе "${agent.status}", не idle`,
    );
  }

  const route = state.routes[command.payload.route_id];
  if (route === undefined || route.fromLocationId !== agent.locationId) {
    return rejected(
      'route_unavailable',
      route === undefined
        ? `маршрут ${command.payload.route_id} неизвестен миру`
        : `маршрут ${command.payload.route_id} не начинается в текущей локации актора ` +
            `(${agent.locationId}, маршрут начинается в ${route.fromLocationId})`,
    );
  }

  const worldTime = context.clock.now();
  // `requireAddMinutes`, а не `addMinutes`: с M1 сдвиг возвращает `Instant | InstantError`, а
  // нецелое `travelMinutes` из контента обязано быть громким отказом, а не тихим округлением.
  // Обработать его здесь нечем — это дефект bundle-а, не отказ по доменному правилу.
  const expectedArrival = requireAddMinutes(
    worldTime,
    route.travelMinutes,
    `travelMinutes маршрута ${route.id}`,
  );
  const versions = context.ruleset.versions;

  const event: Omit<JourneyStartedEvent, 'recorded_at'> = {
    event_id: context.ids.next(RUNTIME_ID_PREFIXES.event),
    world_id: state.worldId,
    sequence: state.sequence + 1,
    world_time: toCanonicalIso(worldTime),
    type: 'journey.started',
    schema_version: versions.schemaVersion,
    rules_version: versions.rulesVersion,
    content_version: versions.contentVersion,
    actor_ids: [command.actor_id],
    subject_ids: [],
    location_id: agent.locationId,
    correlation_id: command.correlation_id,
    caused_by: [],
    command_id: command.command_id,
    random_audit: null,
    payload: {
      route_id: route.id,
      expected_arrival: toCanonicalIso(expectedArrival),
    },
  };

  return { kind: 'accepted', events: [event] };
}
