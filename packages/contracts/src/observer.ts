/**
 * Observer contracts (I03, §7 `03_TECHNICAL_DESIGN`, ADR-005).
 *
 * Это ТРЕТИЙ слой, а не проекция канонического состояния «как есть». Различие не стилистическое:
 *
 * - **факт** живёт в `world_events` и `WorldState` — источник истины;
 * - **observer projection** (здесь) — то, что разрешено ВИДЕТЬ, со своей `projection_sequence`;
 * - **representation** — текст, который читает человек, и он появится в I11B.
 *
 * Отсюда два запрета, выраженные схемами, а не соглашением.
 *
 * **Здесь нет художественного текста.** `name` и `description` локации — это контент мира
 * (данные `@zona/content`), а не сгенерированная проза. Ни одно поле не содержит фразы,
 * описывающей СОБЫТИЕ: лента отдаёт факты (`type`, `actor_ids`, `location_id`), а как их
 * прочесть человеку — решает UI, и позже representation. ADR-005: текст никогда не является
 * источником факта, поэтому текста, который можно было бы принять за факт, здесь нет.
 *
 * **Здесь нет канонического снимка.** §7 прямо запрещает публичному snapshot сериализовать
 * canonical snapshot, hidden fields, точное knowledge state и decision trace. Поэтому
 * {@link ObserverWorldSnapshotSchema} — не `Snapshot` с вырезанными полями (такое сокращение
 * однажды «забудут» и вернут поле обратно), а самостоятельная схема с
 * `additionalProperties: false`: лишнее поле не проходит валидацию, а не проходит незамеченным.
 *
 * ## Почему у зрителя своя sequence
 *
 * Зритель получает `projection_sequence`, а не канонический `sequence`. Проекция может отставать,
 * пересобираться с нуля и не показывать события, не попадающие в observer-слой — её история своя.
 * Канонический номер зрителю знать неоткуда и незачем; выдать его значило бы пообещать
 * соответствие, которого контракт не даёт.
 *
 * ## Почему этих схем НЕТ в каноническом schema bundle
 *
 * `schema-bundle.ts` собирает схемы, под которыми ПОСЧИТАН мир: их checksum входит в снимок и
 * доказывает, по каким правилам получен канонический результат. Observer-схемы на канонический
 * результат не влияют вовсе — они описывают то, что показано снаружи.
 *
 * Включить их в bundle значило бы связать канонические снимки с контрактом UI: переименование
 * поля на экране меняло бы checksum bundle, и снимки, снятые до правки, объявлялись бы
 * несовместимыми. Мир перестал бы восстанавливаться из-за правки вёрстки — абсурд, который
 * заметили бы не сразу, потому что механика отказа выглядела бы законной.
 *
 * Версионируются они отдельно: `$id` каждой схемы несёт мажор (`zona:observer-event/1`), и
 * несовместимое изменение — новый мажор в `$id`. Запрет проверяется contract-тестом, а не
 * комментарием.
 */
import { type Static, Type } from '@sinclair/typebox';
import {
  InstantSchema,
  NamespacedIdSchema,
  ProjectionSequenceSchema,
  RuntimeIdSchema,
  TravelMinutesSchema,
} from './schema-primitives.ts';
import { RUNTIME_ID_PREFIXES } from './identifier.ts';
import { WORLD_EVENT_TYPES } from './world-event.ts';
import { NeedKindSchema, NeedLevelSchema, type NeedKind } from './need.ts';
import {
  type ValidationResult,
  isValidationIssue,
  normalizeInstantField,
  schemaIssues,
} from './validation.ts';

/** Статус агента, видимый зрителю. Совпадает с доменным — скрывать здесь нечего. */
export const OBSERVER_AGENT_STATUSES = ['idle', 'traveling'] as const;

/**
 * Уровни всех нужд агента. Ключи перечислены явно, а не собраны из `NEED_KINDS` в рантайме:
 * `Static` от собранной на лету схемы выродился бы в индексную сигнатуру, и пропущенный вид
 * нужды перестал бы ломать компиляцию. `satisfies` возвращает эту проверку — новый вид нужды
 * обязан появиться здесь, иначе схема не соберётся.
 */
const NEED_LEVEL_FIELDS = {
  hunger: NeedLevelSchema,
  fatigue: NeedLevelSchema,
} as const satisfies Readonly<Record<NeedKind, unknown>>;

export const NeedLevelsSchema = Type.Object(NEED_LEVEL_FIELDS, {
  additionalProperties: false,
  description: 'Уровень каждой нужды агента (07_MVP_MECHANICS_SPEC §5).',
});

export const ObserverAgentSchema = Type.Object(
  {
    agent_id: NamespacedIdSchema,
    name: Type.String({
      minLength: 1,
      description: 'Имя из контента мира, не сгенерированный текст.',
    }),
    /** `null`, пока агент в пути: он не находится ни в одной локации. */
    location_id: Type.Union([NamespacedIdSchema, Type.Null()]),
    status: Type.Union(OBSERVER_AGENT_STATUSES.map((value) => Type.Literal(value))),
    /** `null`, пока агент не в пути. */
    route_id: Type.Union([NamespacedIdSchema, Type.Null()]),
    /**
     * Уровни нужд, видимые зрителю (I04).
     *
     * УРОВЕНЬ, а не значение, и это не упрощение подачи. Значение нужды — производная величина
     * от мирового времени; чтобы показать его, проекции понадобились бы коэффициенты ruleset,
     * то есть право ВЫЧИСЛЯТЬ факт, а не отражать его. Уровень же приходит из события
     * `need.threshold.crossed` — проекция его только запоминает.
     */
    needs: NeedLevelsSchema,
    /**
     * Сколько съедобного у агента с собой (I04).
     *
     * Число, а не список: зрителю нужен ответ на вопрос «есть ли ещё чем поесть», а не опись
     * инвентаря. Опись — это уже интерфейс управления, которого у наблюдателя нет и не будет
     * (PR-01), и она выдала бы id предметов, по которым мир ничем не управляется извне.
     */
    food_carried: Type.Integer({
      minimum: 0,
      description: 'Число съедобных предметов у агента.',
    }),
  },
  { $id: 'zona:observer-agent/1', additionalProperties: false },
);

export const ObserverMapNodeSchema = Type.Object(
  {
    location_id: NamespacedIdSchema,
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
  },
  { $id: 'zona:observer-map-node/1', additionalProperties: false },
);

export const ObserverMapEdgeSchema = Type.Object(
  {
    route_id: NamespacedIdSchema,
    from_location_id: NamespacedIdSchema,
    to_location_id: NamespacedIdSchema,
    travel_minutes: TravelMinutesSchema,
  },
  { $id: 'zona:observer-map-edge/1', additionalProperties: false },
);

/**
 * Одно событие ленты. Полей ровно столько, чтобы зритель мог назвать ПРИЧИНУ увиденного:
 * что произошло, с кем, где и когда по мировому времени.
 *
 * `event_id` отдаётся намеренно: без него зритель не может сослаться на конкретный факт, а
 * «понятность» из гипотезы итерации требует именно возможности сослаться. Это идентификатор
 * уже опубликованного факта, а не скрытое состояние.
 */
export const ObserverEventSchema = Type.Object(
  {
    projection_sequence: ProjectionSequenceSchema,
    event_id: RuntimeIdSchema(RUNTIME_ID_PREFIXES.event, 'Идентификатор канонического события.'),
    world_time: InstantSchema,
    type: Type.Union(WORLD_EVENT_TYPES.map((value) => Type.Literal(value))),
    actor_ids: Type.Array(NamespacedIdSchema, { minItems: 1 }),
    location_id: Type.Union([NamespacedIdSchema, Type.Null()]),
    route_id: Type.Union([NamespacedIdSchema, Type.Null()]),
    /** Нужда и достигнутый уровень; `null` у событий, к нуждам не относящихся (I04). */
    need: Type.Union([NeedKindSchema, Type.Null()]),
    need_level: Type.Union([NeedLevelSchema, Type.Null()]),
  },
  { $id: 'zona:observer-event/1', additionalProperties: false },
);

/**
 * Полное состояние, которое зритель получает при загрузке страницы и при переподключении с
 * потерянным окном retention.
 *
 * OPS-02 требует, чтобы восстановление НЕ зависело от истории SSE. Поэтому snapshot
 * самодостаточен: карта, агенты и `projection_sequence`, с которой можно продолжить поток.
 * Лента в snapshot НЕ входит — она подгружается отдельным запросом с курсором, иначе размер
 * ответа рос бы с возрастом мира, и «восстановление» однажды перестало бы работать именно у
 * старых миров.
 */
export const ObserverWorldSnapshotSchema = Type.Object(
  {
    world_id: NamespacedIdSchema,
    projection_sequence: ProjectionSequenceSchema,
    world_time: InstantSchema,
    nodes: Type.Array(ObserverMapNodeSchema),
    edges: Type.Array(ObserverMapEdgeSchema),
    agents: Type.Array(ObserverAgentSchema),
  },
  { $id: 'zona:observer-world-snapshot/1', additionalProperties: false },
);

/**
 * Управляющее сообщение потока: клиент попросил продолжить с позиции, которой уже нет.
 *
 * §7: «при утрате retention window клиент получает явный `reset_required` и перечитывает observer
 * snapshot, а не canonical log». Явное сообщение, а не молчаливая отдача с начала: молчаливая
 * означала бы, что зритель видит дыру в ленте и не знает об этом.
 */
export const ObserverStreamResetSchema = Type.Object(
  {
    reason: Type.Literal('reset_required'),
    /**
     * С какой позиции проекция ещё может отдавать события; `null` — доступного нет ВОВСЕ.
     *
     * `null`, а не `0`, и это CR-I03-01 (одобрен владельцем 2026-08-29), а не вкусовщина.
     * `PROJECTION_SEQUENCE_UNIT.min = 1`, поэтому нуля в допустимом множестве нет; но главное —
     * тот же номер участвует в курсоре SSE и в снимке, и «нулевой шаг проекции» получил бы два
     * разных смысла в разных полях. Отсутствие кодируется отсутствием.
     *
     * Состояние законное, а не аварийное: проекцию только что пересобрали, либо она ещё не
     * дошла до генезиса. До этой правки контракт его выразить не мог, и маршрут молчал —
     * зритель видел подключённый поток без единого кадра (MAJOR-4).
     */
    earliest_available_sequence: Type.Union([ProjectionSequenceSchema, Type.Null()]),
  },
  { $id: 'zona:observer-stream-reset/1', additionalProperties: false },
);

export type ObserverAgent = Static<typeof ObserverAgentSchema>;
export type ObserverMapNode = Static<typeof ObserverMapNodeSchema>;
export type ObserverMapEdge = Static<typeof ObserverMapEdgeSchema>;
export type ObserverEvent = Static<typeof ObserverEventSchema>;
export type ObserverWorldSnapshot = Static<typeof ObserverWorldSnapshotSchema>;
export type ObserverStreamReset = Static<typeof ObserverStreamResetSchema>;

/**
 * Имена SSE-событий. Литералы, а не свободные строки: клиент подписывается по имени, и опечатка
 * в имени на сервере проявилась бы как «поток работает, но ничего не приходит».
 */
export const OBSERVER_STREAM_EVENT_NAMES = {
  /** Очередное событие ленты; `id` SSE-кадра равен его `projection_sequence`. */
  event: 'world.event',
  /** Требование перечитать snapshot (см. {@link ObserverStreamResetSchema}). */
  reset: 'stream.reset',
} as const;

/**
 * Декодеры приводят `world_time` к канонической форме, а не только валидируют шаблон.
 *
 * Тот же довод, что у снимка (A3): `…T20:20:00+02:00` и `…T18:20:00.000Z` — один момент мира.
 * Зритель, сравнивающий две ленты или сортирующий их по тексту времени, получил бы разный
 * порядок из-за смещения источника, а не из-за порядка событий.
 */
export function decodeObserverWorldSnapshot(
  input: unknown,
): ValidationResult<ObserverWorldSnapshot> {
  const issues = schemaIssues(ObserverWorldSnapshotSchema, input);
  if (issues.length > 0) return { errors: issues };
  const snapshot = input as ObserverWorldSnapshot;
  const worldTime = normalizeInstantField('/world_time', snapshot.world_time);
  if (isValidationIssue(worldTime)) return { errors: [worldTime] };
  return { value: { ...snapshot, world_time: worldTime.iso } };
}

export function decodeObserverEvent(input: unknown): ValidationResult<ObserverEvent> {
  const issues = schemaIssues(ObserverEventSchema, input);
  if (issues.length > 0) return { errors: issues };
  const event = input as ObserverEvent;
  const worldTime = normalizeInstantField('/world_time', event.world_time);
  if (isValidationIssue(worldTime)) return { errors: [worldTime] };
  return { value: { ...event, world_time: worldTime.iso } };
}
