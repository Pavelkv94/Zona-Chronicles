#!/usr/bin/env node
/**
 * Прогон цепочки command → events → state в отдельном процессе.
 *
 * Существует из-за finding m7 верификации I01: acceptance-критерий A1 гоняет 100 процессов по
 * пути CLI, а тот строит состояние напрямую из контента и не вызывает `decide`/`evolve` вовсе.
 * Формально A1 выполнялся, но **главная гипотеза итерации** — «цепочка command → events → state
 * полностью проверяема без базы и framework» — этим прогоном не покрывалась. Детерминизм ядра
 * был доказан только внутрипроцессно, то есть способом, который сам `ACCEPTANCE` в разделе
 * «Что НЕ является приёмкой» называет недостаточным.
 *
 * Скрипт намеренно не является командой CLI: `world run` зарезервирован за I02A, и выдумывать
 * продуктовую поверхность ради теста — худший способ закрыть пробел в доказательстве.
 */
import {
  DeterministicRandomSource,
  FixedClock,
  SequentialIdFactory,
  decide,
  evolve,
  testRuleset,
  type WorldState,
} from '../../../packages/domain/src/index.ts';
import {
  canonicalChecksum,
  canonicalize,
  isCanonicalizationError,
  type Command,
  type WorldEvent,
} from '../../../packages/contracts/src/index.ts';

const seedArg = process.argv.indexOf('--seed');
const seed = seedArg === -1 ? Number.NaN : Number(process.argv[seedArg + 1]);
if (!Number.isSafeInteger(seed)) {
  process.stderr.write('использование: decide-evolve-chain.ts --seed <целое>\n');
  process.exit(2);
}

const WORLD_TIME = '2034-05-17T18:20:00.000Z';

const initialState: WorldState = {
  worldId: 'world:prototype',
  worldVersion: 0,
  worldTime: '2034-05-17T18:00:00.000Z',
  sequence: 0,
  agents: {
    'agent:rook': {
      id: 'agent:rook',
      locationId: 'loc:quiet-yard',
      status: 'idle',
      routeId: null,
      needBaseline: { hunger: '2034-05-17T18:00:00.000Z', fatigue: '2034-05-17T18:00:00.000Z' },
    },
  },
  routes: {
    'route:yard-to-bridge': {
      id: 'route:yard-to-bridge',
      fromLocationId: 'loc:quiet-yard',
      toLocationId: 'loc:bridge',
      travelMinutes: 40,
    },
  },
  items: {},
  scheduledActions: {},
};

const command: Command = {
  command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  world_id: 'world:prototype',
  type: 'journey.start',
  schema_version: 1,
  actor_id: 'agent:rook',
  issued_at_world_time: WORLD_TIME,
  expected_world_version: 0,
  correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  payload: { route_id: 'route:yard-to-bridge' },
};

const result = decide(initialState, command, {
  clock: new FixedClock(WORLD_TIME),
  // Seed входит именно сюда: если бы цепочка от него не зависела, критерий «разный seed даёт
  // другой результат» нельзя было бы выразить, и тест выродился бы в проверку константы.
  random: new DeterministicRandomSource(seed),
  ids: new SequentialIdFactory(seed),
  ruleset: testRuleset(),
});

if (result.kind === 'rejected') {
  process.stderr.write(`команда отклонена: ${result.rejection.code} ${result.rejection.message}\n`);
  process.exit(3);
}

// `recorded_at` домен не производит (решение 9), поэтому его ставит здесь тот же слой, который
// в I02A станет адаптером персистентности. Значение фиксировано: операционная отметка не
// участвует в доменной логике и не должна влиять на результат цепочки.
const events: WorldEvent[] = result.events.map((draft) => ({
  ...draft,
  recorded_at: '2026-01-01T00:00:00.000Z',
}));

const finalState = events.reduce<WorldState>((state, event) => evolve(state, event), initialState);

// `recorded_at` исключается из сравниваемого результата: он операционный и по решению 9 не
// участвует ни в доменной логике, ни в replay. Оставить его — значит сравнивать константу,
// которую мы сами и подставили строкой выше.
const output = {
  events: events.map(({ recorded_at: _recordedAt, ...rest }) => rest),
  state: finalState,
};
const canonical = canonicalize(output);
if (isCanonicalizationError(canonical)) {
  process.stderr.write(`результат цепочки неканоничен: ${canonical.error}\n`);
  process.exit(4);
}
const checksum = canonicalChecksum(output);
if (isCanonicalizationError(checksum)) {
  process.stderr.write(`checksum не вычислен: ${checksum.error}\n`);
  process.exit(4);
}

process.stdout.write(`${checksum.checksum} ${canonical.json}\n`);
