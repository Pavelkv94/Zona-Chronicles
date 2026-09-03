/**
 * World event envelope v1 (`09_EVENT_AND_COMMAND_CONTRACTS` §3) и первый contract slice (§11).
 *
 * Событие — уже случившийся факт мира. Оно не содержит художественный текст, UI importance и
 * observer visibility: это разные слои ADR-005, и они принадлежат projections/representations.
 * Схема запрещает такие поля не рекомендацией, а `additionalProperties: false`.
 *
 * Union по `type` дискриминированный и закрытый: добавление типа события без ветки в `evolve`
 * обязано ломать компиляцию потребителя (A8), поэтому `type` — литерал в каждом варианте, а
 * не общая строка с отдельной валидацией.
 */
import { type Static, Type } from '@sinclair/typebox';
import { requireCanonical } from './canonical-json.ts';
import { ENVELOPE_SCHEMA_VERSION } from './command.ts';
import { RUNTIME_ID_PREFIXES } from './identifier.ts';
import { NeedKindSchema, NeedLevelSchema } from './need.ts';
import { DecisionTraceSchema, GoalKindSchema } from './goal.ts';
import {
  DottedNameSchema,
  DrawCountSchema,
  DrawIndexSchema,
  IdSetSchema,
  InstantSchema,
  NamespacedIdSchema,
  RuntimeIdSchema,
  RuntimeIdSetSchema,
  SchemaVersionSchema,
  SemanticVersionSchema,
  SequenceSchema,
} from './schema-primitives.ts';
import {
  type ValidationIssue,
  type ValidationResult,
  failure,
  idSetIsSorted,
  isRecord,
  isValidationIssue,
  normalizeInstantField,
  schemaIssues,
} from './validation.ts';

/** Типы событий первого slice (§11). Расширяется только итерацией из §12. */
export const WORLD_EVENT_TYPES = [
  'journey.started',
  'journey.completed',
  'plan.invalidated',
  'need.threshold.crossed',
  'agent.ate',
  'agent.rested',
  'rest.started',
  'goal.chosen',
  'risk.observed',
] as const;

export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number];

/** Поля envelope события: список нужен для проверки §4 «payload не дублирует envelope». */
export const WORLD_EVENT_ENVELOPE_KEYS = [
  'event_id',
  'world_id',
  'sequence',
  'world_time',
  'recorded_at',
  'type',
  'schema_version',
  'rules_version',
  'content_version',
  'actor_ids',
  'subject_ids',
  'location_id',
  'correlation_id',
  'causation_id',
  'caused_by',
  'command_id',
  'random_audit',
  'payload',
] as const;

/**
 * Audit случайности (§7): stream key и диапазон использованных draw.
 *
 * `rules_version` сюда НЕ входит, хотя §7 перечисляет её среди audit-полей: она уже есть в
 * envelope, а §4 запрещает дублировать поля envelope. Второй экземпляр того же значения — это
 * второй источник истины, который однажды разойдётся с первым.
 */
export const RandomAuditSchema = Type.Object(
  {
    stream_key: Type.Unsafe<string>({
      ...NamespacedIdSchema,
      description: 'Стабильный ключ потока: мир, агент, сцена или система (§7).',
    }),
    first_draw_index: DrawIndexSchema,
    draw_count: DrawCountSchema,
  },
  {
    additionalProperties: false,
    description: 'Метаданные использованной случайности; null, если outcome её не использовал.',
  },
);

/** Поля, общие для всех событий. `type` и `payload` добавляет конкретный вариант. */
const envelopeFields = {
  event_id: RuntimeIdSchema(RUNTIME_ID_PREFIXES.event, 'Глобальный id события (§1).'),
  world_id: NamespacedIdSchema,
  sequence: SequenceSchema,
  world_time: Type.Unsafe<string>({
    ...InstantSchema,
    description: 'Время факта внутри мира (§3).',
  }),
  recorded_at: Type.Unsafe<string>({
    ...InstantSchema,
    description: 'Операционный wall clock; не участвует в доменной логике и replay (§3).',
  }),
  schema_version: SchemaVersionSchema,
  rules_version: SemanticVersionSchema,
  content_version: SemanticVersionSchema,
  actor_ids: IdSetSchema('Акторы факта; множество, отсортированное по возрастанию.'),
  subject_ids: IdSetSchema('Субъекты факта; множество, отсортированное по возрастанию.'),
  location_id: Type.Optional(NamespacedIdSchema),
  correlation_id: RuntimeIdSchema(
    RUNTIME_ID_PREFIXES.correlation,
    'Весь workflow/scene/plan (§3).',
  ),
  causation_id: Type.Optional(
    RuntimeIdSchema(RUNTIME_ID_PREFIXES.event, 'Непосредственное событие-триггер (§3).'),
  ),
  caused_by: RuntimeIdSetSchema(
    RUNTIME_ID_PREFIXES.event,
    'Дополнительные причинные рёбра для летописи; множество, отсортированное по возрастанию.',
  ),
  command_id: Type.Optional(
    RuntimeIdSchema(
      RUNTIME_ID_PREFIXES.command,
      'Идемпотентный источник, если факт создан командой.',
    ),
  ),
  random_audit: Type.Union([RandomAuditSchema, Type.Null()], {
    description: 'Метаданные случайности либо null, если outcome её не использовал (§3).',
  }),
} as const;

/** `journey.started`: агент вышел на маршрут (§3). */
export const JourneyStartedPayloadSchema = Type.Object(
  {
    route_id: NamespacedIdSchema,
    expected_arrival: InstantSchema,
  },
  { additionalProperties: false, description: 'Маршрут и ожидаемый момент прибытия.' },
);

/**
 * `journey.completed`: агент дошёл (§11).
 *
 * Payload намеренно состоит из одного поля, и это не недосказанность — всё остальное уже есть
 * в envelope, а §4 запрещает дублирование:
 *
 * - момент прибытия — это `world_time` события;
 * - дошедший агент — `actor_ids`;
 * - место прибытия — `location_id`. Событие происходит в точке назначения, поэтому отдельного
 *   `arrival_location_id` не нужно. Это ПРОЧТЕНИЕ §3, а не цитата: документ определяет
 *   `location_id` как место факта и не разбирает случай завершённого пути отдельно;
 * - опоздание считается как `world_time` минус `expected_arrival` из `journey.started`,
 *   связанного через `correlation_id`;
 * - `journey.interrupted` — отдельный тип события (`07_MVP_MECHANICS_SPEC` §20), а не флаг
 *   внутри этого. Поэтому §12 «событие не заменяет state machine одним успешным флагом» здесь
 *   соблюдено разделением типов, а не полем `success`.
 *
 * РЕШЕНИЕ LEAD-А I01 о связи со scheduled action. §6 требует, чтобы повторное завершение
 * предотвращалось «unique link с resulting command/event batch», но не говорит, на какой
 * стороне живёт эта связь. Решено: связь принадлежит СТРОКЕ SCHEDULED ACTION, а не envelope
 * события. Envelope не меняется — ни сейчас, ни в I02B. Основания:
 *
 * - подавляющее большинство событий не порождается scheduled action, поэтому поле
 *   envelope-уровня, пустое почти всегда, было бы налогом на каждый факт мира ради одного
 *   случая;
 * - §5 помещает `update scheduled actions` в ТУ ЖЕ транзакцию, что и append событий, поэтому
 *   статус строки действия и `expected_actor_version` уже дают однократность без участия
 *   envelope;
 * - причинность события описывают `causation_id` и `caused_by`, а scheduled action событием
 *   не является и целью этих ссылок быть не может; трассируемость сохраняется в направлении
 *   `action → полученный batch`, и для летописи этого достаточно.
 */
export const JourneyCompletedPayloadSchema = Type.Object(
  {
    route_id: NamespacedIdSchema,
  },
  {
    additionalProperties: false,
    description:
      'Пройденный маршрут. Момент прибытия — world_time, место прибытия — location_id, ' +
      'агент — actor_ids: §4 запрещает дублировать их в payload.',
  },
);

/**
 * Предусловия, чьё невыполнение срывает план (I05-C).
 *
 * Закрытый список, хотя схема принимает любое точечное имя: имя предусловия читает
 * расследование, а свободная строка означала бы, что каждый производитель придумывает своё —
 * и «еды не стало» появилось бы в журнале под тремя разными названиями.
 *
 * Схема при этом не сужается до перечисления намеренно: она заморожена с I01, а журнал
 * невосполним — факт, записанный старым производителем с другим именем, обязан продолжать
 * читаться.
 */
export const PLAN_PRECONDITION_TYPES = [
  /** Предмет, который агент собирался съесть, больше не существует или ему не принадлежит. */
  'item.available_to_actor',
  /** Агент оказался занят к моменту шага, который требовал свободы. */
  'agent.is_idle',
  /** Нужда, которую план НЕ лечит, дошла до предела — emergency interrupt §6. */
  'agent.not_in_emergency',
] as const;

export type PlanPreconditionType = (typeof PLAN_PRECONDITION_TYPES)[number];

/**
 * `plan.invalidated`: перед шагом плана не выполнилось предусловие
 * (`07_MVP_MECHANICS_SPEC` §6), после чего агент перепланирует действие.
 */
export const PlanInvalidatedPayloadSchema = Type.Object(
  {
    plan_id: NamespacedIdSchema,
    precondition_type: Type.Unsafe<string>({
      ...DottedNameSchema,
      description: 'Тип невыполненного предусловия, например agent.is_on_route (§6).',
    }),
  },
  { additionalProperties: false, description: 'План и невыполненное предусловие.' },
);

/**
 * `need.threshold.crossed`: нужда агента перешла через порог (I04, §5).
 *
 * Значения нужды в payload НЕТ намеренно. Значение — производная величина, вычисляемая из
 * момента отсчёта и коэффициентов; записанное в факт, оно стало бы измерением, устаревающим в
 * следующий момент. Фактом является переход, и он описан парой уровней.
 *
 * `from_level` не дублирует envelope и не дублирует состояние: он делает факт самодостаточным
 * для летописи («был спокоен — стал голоден») и задаёт направление перехода без отдельного поля
 * `direction`, которое пришлось бы держать согласованным с парой уровней.
 *
 * `next_threshold_at` — момент СЛЕДУЮЩЕГО пересечения либо `null`, если следующего нет (уровень
 * крайний). Это предсказание, а не факт, и оно здесь по тому же основанию, что
 * `expected_arrival` у `journey.started`: расписание выводится из журнала чистой функцией
 * `evolve`, у которой нет доступа к коэффициентам ruleset. Без этого поля пересимуляция не
 * смогла бы восстановить расписание, и его пришлось бы держать вторым механизмом, способным
 * молча разойтись с историей.
 */
export const NeedThresholdCrossedPayloadSchema = Type.Object(
  {
    need: NeedKindSchema,
    from_level: NeedLevelSchema,
    to_level: NeedLevelSchema,
    next_threshold_at: Type.Union([InstantSchema, Type.Null()], {
      description: 'Момент следующего пересечения; null — следующего порога нет.',
    }),
  },
  {
    additionalProperties: false,
    description:
      'Переход нужды через порог. Агент — actor_ids, момент перехода — world_time: ' +
      '§4 запрещает дублировать их в payload.',
  },
);

/**
 * `agent.ate`: агент съел предмет, и предмет перестал существовать (I04).
 *
 * Это СТОК: единственный способ, которым предмет уходит из мира в этой итерации. Поэтому факт
 * называет предмет — без него «в мире стало на одну банку меньше» было бы утверждением без
 * подлежащего, и conservation проверялась бы сравнением количеств, а не разбором истории.
 *
 * Уровня нужды здесь НЕТ: восстановление выражается отдельным `need.threshold.crossed`, тем же
 * фактом, что и ухудшение. Иначе у перехода было бы два разных представления в зависимости от
 * направления, и потребителю пришлось бы уметь оба.
 */
export const AgentAtePayloadSchema = Type.Object(
  {
    item_id: NamespacedIdSchema,
  },
  {
    additionalProperties: false,
    description: 'Съеденный предмет. Едок — actor_ids, место — location_id (§4).',
  },
);

/** `agent.rested`: агент отдохнул; усталость отсчитывается заново с `world_time` (I04). */
export const AgentRestedPayloadSchema = Type.Object(
  {},
  {
    additionalProperties: false,
    description: 'Отдых не имеет собственных полей: кто и когда — уже в envelope.',
  },
);

/**
 * `rest.started`: агент лёг отдыхать (I05).
 *
 * Отдых перестал быть мгновенным, и у него появилась та же форма, что у пути: начало — факт,
 * конец — отдельный факт, а между ними агент занят и его состояние можно прервать. Мгновенный
 * отдых из I04 был названным упрощением; здесь оно снято, потому что без цены отдыха выбор
 * между «поесть» и «отдохнуть» вырождается в сравнение одного числа.
 *
 * `expected_end` — предсказание, а не факт, и оно здесь по тому же основанию, что
 * `expected_arrival` у `journey.started`: расписание выводит чистая `evolve`, у которой нет
 * коэффициентов ruleset.
 */
export const RestStartedPayloadSchema = Type.Object(
  {
    expected_end: InstantSchema,
  },
  {
    additionalProperties: false,
    description: 'Ожидаемый момент конца отдыха. Отдыхающий — actor_ids, место — location_id.',
  },
);

/**
 * `goal.chosen`: агент выбрал цель (I05, §6).
 *
 * Публикуется, когда решение ИЗМЕНИЛО МИР: у агента появилась новая цель либо прежняя цель
 * получила новый исполнимый шаг. Решение, не изменившее ничего, фактом не является и в журнал
 * не попадает — иначе лента наполнилась бы записями «подумал и остался при своём», а летопись
 * перестала бы быть перечнем произошедшего.
 *
 * `previous_goal` делает факт самодостаточным для летописи («был празден — решил поесть») по
 * тому же основанию, что `from_level` у пересечения порога: без него направление перехода
 * пришлось бы восстанавливать из состояния, которого лента не читает.
 *
 * `trace` — разбор оценок (§6). Он канонический, но НЕ публичный: observer-контракт его не
 * содержит, и это требование §7 `03_TECHNICAL_DESIGN`, а не осторожность. Зритель видит факт
 * «решил поесть», а расследование читает журнал.
 */
export const GoalChosenPayloadSchema = Type.Object(
  {
    goal: GoalKindSchema,
    previous_goal: GoalKindSchema,
    trace: DecisionTraceSchema,
  },
  {
    additionalProperties: false,
    description: 'Выбранная цель, прежняя цель и разбор оценок. Решающий — actor_ids (§4).',
  },
);

/**
 * `risk.observed`: агент узнал, насколько опасна дорога (I06, §8, §12).
 *
 * Единственный способ, которым знание входит в мир. Это решение, а не оформление: узнать можно
 * будет по-разному — пройдя самому, увидев издали, услышав от другого, — и если каждый способ
 * станет побочным эффектом своего события, то «знание не появляется без provenance» (SIM-05)
 * придётся соблюдать дисциплиной в N местах вместо одного. Один тип факта — одна точка входа.
 *
 * **Поля `source_type` здесь НЕТ**, хотя §12 его называет. Источник у этого среза ровно один —
 * увиденное своими глазами, — и он выражен самим типом события. Поле с единственным значением
 * заморозило бы форму пересказа и вывода раньше, чем принято решение об их правилах (§12
 * контрактов запрещает реализовывать схемы будущих slices заранее).
 *
 * Provenance при этом полон: кто узнал — `actor_ids`, когда — `world_time`, из-за чего —
 * `caused_by`. Запись в субъективной карте помнит `event_id` этого факта.
 */
export const RiskObservedPayloadSchema = Type.Object(
  {
    route_id: NamespacedIdSchema,
    risk: Type.Integer({
      minimum: 0,
      maximum: 1000,
      description: 'Узнанная опасность дороги в тысячных.',
    }),
  },
  {
    additionalProperties: false,
    description: 'Узнанная дорога и её опасность. Узнавший — actor_ids, момент — world_time (§4).',
  },
);

const PAYLOAD_SCHEMAS = {
  'journey.started': JourneyStartedPayloadSchema,
  'journey.completed': JourneyCompletedPayloadSchema,
  'plan.invalidated': PlanInvalidatedPayloadSchema,
  'need.threshold.crossed': NeedThresholdCrossedPayloadSchema,
  'agent.ate': AgentAtePayloadSchema,
  'agent.rested': AgentRestedPayloadSchema,
  'rest.started': RestStartedPayloadSchema,
  'goal.chosen': GoalChosenPayloadSchema,
  'risk.observed': RiskObservedPayloadSchema,
} as const;

/** Моменты внутри payload, которые декодер обязан привести к канонической форме. */
const PAYLOAD_INSTANT_FIELDS: Readonly<Record<WorldEventType, readonly string[]>> = {
  'journey.started': ['expected_arrival'],
  'journey.completed': [],
  'plan.invalidated': [],
  // `null` допустим и означает «следующего порога нет»; нормализация обязана его пропускать,
  // а не пытаться разобрать как момент.
  'need.threshold.crossed': ['next_threshold_at'],
  'agent.ate': [],
  'agent.rested': [],
  'rest.started': ['expected_end'],
  'goal.chosen': [],
  'risk.observed': [],
};

function eventVariant<T extends WorldEventType>(type: T) {
  return Type.Object(
    {
      ...envelopeFields,
      type: Type.Literal(type),
      payload: PAYLOAD_SCHEMAS[type],
    },
    {
      $id: `zona:world-event/${type}/1`,
      additionalProperties: false,
      description: `World event ${type} v1.`,
    },
  );
}

export const JourneyStartedEventSchema = eventVariant('journey.started');
export const JourneyCompletedEventSchema = eventVariant('journey.completed');
export const PlanInvalidatedEventSchema = eventVariant('plan.invalidated');
export const NeedThresholdCrossedEventSchema = eventVariant('need.threshold.crossed');
export const AgentAteEventSchema = eventVariant('agent.ate');
export const AgentRestedEventSchema = eventVariant('agent.rested');
export const RestStartedEventSchema = eventVariant('rest.started');
export const GoalChosenEventSchema = eventVariant('goal.chosen');
export const RiskObservedEventSchema = eventVariant('risk.observed');

/**
 * Каталог вариантов, ПОЛНЫЙ по построению.
 *
 * `satisfies` здесь несёт всю нагрузку: он требует ключ на каждый тип из `WORLD_EVENT_TYPES` и
 * при этом сохраняет точные типы значений, без которых `Static` ниже выродился бы в `unknown`.
 * До этого каталог был обычным `as const`, и пропущенный вариант ничего не ломал.
 */
const VARIANT_SCHEMAS = {
  'journey.started': JourneyStartedEventSchema,
  'journey.completed': JourneyCompletedEventSchema,
  'plan.invalidated': PlanInvalidatedEventSchema,
  'need.threshold.crossed': NeedThresholdCrossedEventSchema,
  'agent.ate': AgentAteEventSchema,
  'agent.rested': AgentRestedEventSchema,
  'rest.started': RestStartedEventSchema,
  'goal.chosen': GoalChosenEventSchema,
  'risk.observed': RiskObservedEventSchema,
} as const satisfies Readonly<Record<WorldEventType, unknown>>;

export const WorldEventSchema = Type.Union(
  // Порядок вариантов задан каталогом, а не вторым списком: два списка расходятся молча.
  WORLD_EVENT_TYPES.map((type) => VARIANT_SCHEMAS[type]),
  {
    $id: 'zona:world-event/1',
    description: 'World event envelope v1, дискриминированный по type (§3, §11).',
  },
);

/** Метаданные использованной случайности; `null` в событии означает «случайность не использовалась». */
export type RandomAudit = Static<typeof RandomAuditSchema>;

export type JourneyStartedEvent = Static<typeof JourneyStartedEventSchema>;
export type JourneyCompletedEvent = Static<typeof JourneyCompletedEventSchema>;
export type PlanInvalidatedEvent = Static<typeof PlanInvalidatedEventSchema>;
export type NeedThresholdCrossedEvent = Static<typeof NeedThresholdCrossedEventSchema>;
export type AgentAteEvent = Static<typeof AgentAteEventSchema>;
export type AgentRestedEvent = Static<typeof AgentRestedEventSchema>;
export type RestStartedEvent = Static<typeof RestStartedEventSchema>;
export type GoalChosenEvent = Static<typeof GoalChosenEventSchema>;
export type RiskObservedEvent = Static<typeof RiskObservedEventSchema>;

/**
 * Закрытый union canonical events v1 — ВЫВЕДЕННЫЙ из каталога, а не выписанный рядом с ним.
 *
 * `Static<typeof WorldEventSchema>` не годится: он не даёт компилятору дискриминатор, и
 * `switch (event.type)` без одной ветки перестал бы сужаться до `never`. Отображение по
 * `WorldEventType` его даёт — у каждого варианта `type` объявлен литералом, — и при этом union
 * не может отстать от каталога.
 *
 * Раньше здесь стояло перечисление вручную, и обещание A8 из докстринга ниже было пустым.
 * Измерено пробой Gate A: тип, добавленный в `WORLD_EVENT_TYPES`, в payload-карты и в схему
 * union, но не в это перечисление, не ломал НИ ОДНОГО потребителя — `pnpm typecheck` давал ноль
 * ошибок во всём workspace. Новое событие молча выпадало бы из ленты, то есть ровно то, от чего
 * `assertNeverWorldEvent` и поставлен.
 *
 * Незанудная проверка: `WorldEventVariants` — отображение ПО union-у типов, поэтому пропущенный
 * вариант ломает компиляцию здесь, в каталоге, а не у потребителя, который ни при чём.
 */
type WorldEventVariants = {
  [Type in WorldEventType]: Static<(typeof VARIANT_SCHEMAS)[Type]>;
};

export type WorldEvent = WorldEventVariants[WorldEventType];

/**
 * Исчерпывающая проверка типов событий. Аргумент типа `never` означает «сюда невозможно
 * попасть, если обработаны все варианты»; добавление типа события ломает компиляцию каждого
 * потребителя, который его не обработал (A8).
 *
 * Runtime-ветка тоже нужна: событие могло прийти из журнала, записанного более новой версией
 * кода. Тогда это громкий отказ, а не молчаливое `undefined`.
 */
export function assertNeverWorldEvent(event: never): never {
  throw new Error(
    `необработанный тип события: ${JSON.stringify((event as { type?: unknown }).type)}`,
  );
}

/** Валидирует и нормализует событие; возвращает типизированные ошибки с путём (A4). */
export function decodeWorldEvent(input: unknown): ValidationResult<WorldEvent> {
  if (!isRecord(input)) {
    return failure('', 'world event envelope обязан быть объектом');
  }

  const discriminator = checkDiscriminator(input);
  if (discriminator !== null) {
    return { errors: [discriminator] };
  }

  const type = input['type'] as WorldEventType;
  const issues = detailRandomAudit(schemaIssues(VARIANT_SCHEMAS[type], input), input);
  if (issues.length > 0) {
    return { errors: issues };
  }

  const event = input as unknown as WorldEvent;
  const payload = (event as { payload: Record<string, unknown> }).payload;

  const invariantIssues: ValidationIssue[] = [
    ...idSetIsSorted('/actor_ids', event.actor_ids),
    ...idSetIsSorted('/subject_ids', event.subject_ids),
    ...idSetIsSorted('/caused_by', event.caused_by),
  ];

  const normalizedPayload: Record<string, unknown> = { ...payload };
  const normalized: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>) };

  for (const field of ['world_time', 'recorded_at'] as const) {
    const result = normalizeInstantField(`/${field}`, event[field]);
    if (isValidationIssue(result)) {
      invariantIssues.push(result);
    } else {
      normalized[field] = result.iso;
    }
  }

  for (const field of PAYLOAD_INSTANT_FIELDS[type]) {
    // `null` — законное значение поля-момента там, где схема его допускает («следующего порога
    // нет»). Нормализовать нечего, и попытка разобрать его как строку дала бы отказ по схеме,
    // которую значение на самом деле проходит.
    if (payload[field] === null) continue;
    const result = normalizeInstantField(`/payload/${field}`, payload[field] as string);
    if (isValidationIssue(result)) {
      invariantIssues.push(result);
    } else {
      normalizedPayload[field] = result.iso;
    }
  }

  if (invariantIssues.length > 0) {
    return { errors: invariantIssues };
  }

  normalized['payload'] = normalizedPayload;
  return { value: normalized as unknown as WorldEvent };
}

/**
 * Каноническая сериализация события: один и тот же текст на любой машине (SIM-01).
 *
 * Инварианты множеств id проверяются и ЗДЕСЬ, а не только в `decodeWorldEvent`. Прежде
 * проверка была односторонней: продюсер, который строит событие сам и сразу считает над ним
 * checksum, канонизировал «что дали» и получал другой checksum того же факта — расхождение
 * всплывало у потребителя, далеко от места, где его создали (minor 4 верификации I01).
 *
 * Бросает, а не возвращает ошибку: несортированное множество на выходе продюсера — дефект кода,
 * а не входные данные, ровно как неканонизируемое значение в `requireCanonical`.
 */
export function encodeWorldEvent(event: WorldEvent): string {
  const issues = [
    ...idSetIsSorted('/actor_ids', event.actor_ids),
    ...idSetIsSorted('/subject_ids', event.subject_ids),
    ...idSetIsSorted('/caused_by', event.caused_by),
  ];
  if (issues.length > 0) {
    const detail = issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
    throw new Error(`невозможно сериализовать world event ${event.type}: ${detail}`);
  }
  return requireCanonical(event, `world event ${event.type}`);
}

/**
 * Раскрывает отказ union `RandomAudit | null`.
 *
 * TypeBox для union сообщает только «Expected union value» и теряет причину: лишнее поле
 * `rules_version` внутри `random_audit` неотличимо от неверного `draw_count`. A4 требует
 * ТИПИЗИРОВАННОЙ ошибки, а не факта отказа, поэтому нарушение перепроверяется по схеме
 * варианта — единственного, который вообще мог подойти для не-null значения.
 */
function detailRandomAudit(
  issues: readonly ValidationIssue[],
  input: Record<string, unknown>,
): ValidationIssue[] {
  const audit = input['random_audit'];
  if (!isRecord(audit)) {
    return [...issues];
  }
  return issues.flatMap((issue) => {
    if (issue.path !== '/random_audit') {
      return [issue];
    }
    const detailed = schemaIssues(RandomAuditSchema, audit).map((inner) => ({
      path: `/random_audit${inner.path}`,
      message: inner.message,
    }));
    return detailed.length > 0 ? detailed : [issue];
  });
}

function checkDiscriminator(input: Record<string, unknown>): ValidationIssue | null {
  const { type, schema_version: schemaVersion } = input;

  if (typeof type !== 'string' || !(WORLD_EVENT_TYPES as readonly string[]).includes(type)) {
    return {
      path: '/type',
      message:
        `неизвестный тип события ${JSON.stringify(type)}; ` +
        `первый contract slice содержит только ${WORLD_EVENT_TYPES.join(', ')} (§11)`,
    };
  }

  if (schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
    return {
      path: '/schema_version',
      message:
        `неподдерживаемая мажорная версия схемы ${JSON.stringify(schemaVersion)}; ` +
        `этот контракт читает версию ${ENVELOPE_SCHEMA_VERSION}, для другой нужен upcaster (§4)`,
    };
  }

  return null;
}
