/**
 * Транзакционный command handler (I02A ACCEPTANCE B2–B6, PLAN §7).
 *
 * Порядок внутри одной транзакции фиксирован и является контрактом итерации:
 *
 * ```text
 * SELECT ... FROM worlds FOR UPDATE      -- сериализация команд одного мира
 * -> идемпотентность по command_id       -- ДО проверки версии (B3)
 * -> чистый decide(state, command, ctx)  -- правила живут только здесь
 * -> INSERT world_events                 -- append-only
 * -> UPDATE agents (только изменившиеся)
 * -> UPDATE worlds (version, last_sequence, world_time)
 * -> INSERT outbox                       -- ровно одна строка на событие
 * -> INSERT command_results              -- accepted и rejected одинаково
 * COMMIT
 * ```
 *
 * Почему `FOR UPDATE`, а не только optimistic-версия: без блокировки две конкурентные команды
 * читают одну версию, обе проходят `decide`, и вторая падает уже на уникальном индексе
 * `(world_id, sequence)` — то есть техническим сбоем вместо доменного отказа
 * `stale_world_version`. Блокировка превращает гонку в ожидание, после которого вторая команда
 * видит новую версию и получает НАЗВАННЫЙ отказ (B6). Optimistic-версия при этом остаётся: она
 * защищает от команды, собранной по устаревшему прочтению мира вне транзакции.
 */
import { sql } from 'kysely';
import {
  CANONICAL_TRANSACTION_ISOLATION_LEVEL,
  compareByCodePoint,
  commandFingerprintSource,
  requireCanonical,
  requireChecksum,
  type Command,
  type CommandRejectionCode,
  type WorldEvent,
} from '@zona/contracts';
import {
  DerivedIdFactory,
  FixedClock,
  FixedRuleset,
  decide,
  evolve,
  type AgentState,
  type WorldState,
} from '@zona/domain';
import { requireSafeInteger, type DatabaseConnection } from './database.ts';
import { PersistentRandomSource } from './prng-positions.ts';
import { loadWorldMeta, loadWorldState, type WorldMeta } from './world-repository.ts';

/** Точки, после которых можно инъектировать сбой (B5). Порядок совпадает с порядком записи. */
export const TRANSACTION_STEPS = [
  'world-locked',
  'attempt-recorded',
  'event-inserted',
  'schedule-updated',
  'agent-updated',
  'world-updated',
  'outbox-inserted',
  'command-result-inserted',
  'before-commit',
] as const;

export type TransactionStep = (typeof TRANSACTION_STEPS)[number];

/** Сколько попыток на (мир, command_id) хранит аудитный приёмник (p-6). */
export const MAX_ATTEMPTS_PER_COMMAND = 10;

/**
 * Точки, реально достигаемые каждым путём.
 *
 * Отказ не пишет ни события, ни состояния, ни outbox, поэтому проходит только три точки из
 * семи. Списки объявлены ДАННЫМИ, а не выведены из кода: тест сверяет фактически пройденные
 * точки с этими списками, и удаление любого `afterStep` становится падением, а не тишиной
 * (finding independent review, раунд 1: инъекция сбоя проверялась только на accepted-пути,
 * и убрать `afterStep` с rejected-ветки можно было незаметно для всех 56 тестов).
 */
export const ACCEPTED_PATH_STEPS: readonly TransactionStep[] = [
  'world-locked',
  'event-inserted',
  'schedule-updated',
  'agent-updated',
  'world-updated',
  'outbox-inserted',
  'command-result-inserted',
  'before-commit',
];

export const REJECTED_PATH_STEPS: readonly TransactionStep[] = [
  'world-locked',
  'command-result-inserted',
  'before-commit',
];

/**
 * Третий путь: отказ по несовпадению отпечатка (N-3). Он ТОЖЕ пишет в базу, поэтому обязан
 * иметь свои точки инъекции — p-5 узкой проверки: утверждение «сбой инъектируется после
 * каждого шага записи» перестало быть верным ровно в тот момент, когда появился новый путь
 * записи. Тот же класс, который test-reviewer закрыл в первом раунде для rejected-пути.
 */
export const FINGERPRINT_MISMATCH_PATH_STEPS: readonly TransactionStep[] = [
  'world-locked',
  'attempt-recorded',
  'before-commit',
];

export interface CommandAccepted {
  readonly outcome: 'accepted';
  readonly commandId: string;
  readonly eventIds: readonly string[];
  readonly worldVersionBefore: number;
  readonly worldVersionAfter: number;
  /** `true` — результат прочитан из journal, команда исполнялась раньше (B3). */
  readonly replayed: boolean;
}

export interface CommandRejected {
  readonly outcome: 'rejected';
  readonly commandId: string;
  readonly rejectionCode: CommandRejectionCode;
  readonly rejectionMessage: string;
  readonly worldVersionBefore: number;
  readonly worldVersionAfter: number;
  readonly replayed: boolean;
}

export type CommandExecution = CommandAccepted | CommandRejected;

export interface ExecuteCommandOptions {
  /** Операционные часы для `recorded_at`. Инъектируются, чтобы тест мог их зафиксировать. */
  readonly now?: () => Date;
  /** Инъекция сбоя после названного шага (B5). Бросок отменяет всю транзакцию. */
  readonly afterStep?: (step: TransactionStep) => Promise<void> | void;
  /**
   * Мировое время, к которому продвигается мир этой командой (I02B).
   *
   * По умолчанию команда исполняется в текущем мировом времени: внешнее намерение время не
   * двигает. Scheduler передаёт `due_at` обрабатываемого действия — тогда событие получает
   * момент, в который оно произошло В МИРЕ, а не момент, когда до него дошли руки.
   * Движение назад запрещено (C12): время мира монотонно.
   */
  readonly worldTime?: string;
}

/**
 * Источник случайности команды (M4, PLAN §4.6).
 *
 * Раньше здесь стоял `UnavailableRandomSource`, бросавший исключение: позиции PRNG не были
 * durable, а собирать `DeterministicRandomSource(seed)` заново на каждую команду значило бы
 * выдавать одно и то же значение всю жизнь мира — и не заметить этого, потому что ни одна
 * команда I02A/I02B розыгрышей не делает.
 *
 * Позиции теперь живут в строке `worlds` (миграция 0009) и двигаются в ТОЙ ЖЕ транзакции, что
 * событие. Поэтому источник можно построить честно: он продолжает потоки ровно с той точки, где
 * их оставила предыдущая принятая команда.
 *
 * Позиции читаются ВНУТРИ транзакции команды и записываются обратно там же — иначе два
 * параллельных исполнителя прочитали бы одну позицию и сделали бы один и тот же розыгрыш.
 */
const commandRandomSource = (meta: WorldMeta): PersistentRandomSource =>
  new PersistentRandomSource({ seed: meta.seed, startPositions: meta.prngStreamPositions });

const jsonOrNull = (value: unknown, label: string): string | null =>
  value === null || value === undefined ? null : requireCanonical(value, label);

/**
 * Отпечаток тела команды — канонический checksum её СЕМАНТИЧЕСКИХ полей.
 *
 * Состав задан в контракте (`COMMAND_FINGERPRINT_KEYS`), а не здесь: перечисление, живущее
 * рядом с самой командой, не может разойтись с ней незамеченным — контрактный тест требует,
 * чтобы включённые и исключённые поля в сумме давали весь envelope.
 *
 * Первая редакция хешировала envelope целиком. N-4 повторного аудита показал цену: в отпечаток
 * попадал `correlation_id`, поэтому добросовестный повтор, пересобранный другим клиентом со
 * свежим id трассировки, объявлялся бы подменой — то есть ровно противоположное тому, ради чего
 * journal существует.
 */
/**
 * Ключ происхождения id событий, порождённых командой (m-3 аудита I02A).
 *
 * Функция, а не соглашение в комментарии: раньше формат `<world_id>:<sequence>` был записан
 * словами здесь и скопирован в acceptance-тест. Scheduler в I02B, которому тоже нужно
 * порождать события, разошёлся бы с этим форматом молча — и получил бы другие `event_id` на
 * том же seed, то есть нарушил SIM-01, ничего при этом не сломав на глаз.
 */
export const eventIdOriginKey = (worldId: string, sequence: number): string =>
  `${worldId}:${String(sequence)}`;

export const commandFingerprint = (command: Command): string =>
  requireChecksum(commandFingerprintSource(command), `command(${command.command_id})`);

const readStoredResult = async (
  db: DatabaseConnection,
  worldId: string,
  commandId: string,
  expectedFingerprint: string,
): Promise<CommandExecution | 'fingerprint-mismatch' | null> => {
  const row = await db
    .selectFrom('command_results')
    .selectAll()
    .where('world_id', '=', worldId)
    .where('command_id', '=', commandId)
    .executeTakeFirst();
  if (row === undefined) return null;
  if (row.command_fingerprint !== expectedFingerprint) return 'fingerprint-mismatch';

  const before = requireSafeInteger(
    row.world_version_before,
    'command_results.world_version_before',
  );
  const after = requireSafeInteger(row.world_version_after, 'command_results.world_version_after');

  if (row.outcome === 'accepted') {
    return {
      outcome: 'accepted',
      commandId: row.command_id,
      eventIds: row.event_ids,
      worldVersionBefore: before,
      worldVersionAfter: after,
      replayed: true,
    };
  }
  if (row.rejection_code === null) {
    throw new Error(
      `persistence: строка command_results ${commandId} помечена rejected без rejection_code`,
    );
  }
  return {
    outcome: 'rejected',
    commandId: row.command_id,
    rejectionCode: row.rejection_code as CommandRejectionCode,
    rejectionMessage: row.rejection_message ?? '',
    worldVersionBefore: before,
    worldVersionAfter: after,
    replayed: true,
  };
};

/** Отпечаток, записанный при первой попытке под этим `command_id` (для аудита отказа). */
const readStoredFingerprint = async (
  db: DatabaseConnection,
  worldId: string,
  commandId: string,
): Promise<string> => {
  const row = await db
    .selectFrom('command_results')
    .select('command_fingerprint')
    .where('world_id', '=', worldId)
    .where('command_id', '=', commandId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new Error(
      `persistence: строка command_results ${commandId} исчезла между проверкой отпечатка и ` +
        'записью аудита — это невозможно внутри одной транзакции',
    );
  }
  return row.command_fingerprint;
};

const changedAgents = (before: WorldState, after: WorldState): readonly AgentState[] =>
  Object.values(after.agents).filter((agent) => {
    const previous = before.agents[agent.id];
    return (
      previous === undefined ||
      previous.locationId !== agent.locationId ||
      previous.status !== agent.status ||
      previous.routeId !== agent.routeId
    );
  });

/**
 * Исполняет команду. Доменный отказ — обычный результат (`outcome: 'rejected'`), а не исключение;
 * исключения остаются за техническими сбоями и нарушениями причинности.
 */
export const executeCommand = async (
  db: DatabaseConnection,
  command: Command,
  options: ExecuteCommandOptions = {},
): Promise<CommandExecution> => {
  const now = options.now ?? ((): Date => new Date());
  const afterStep = options.afterStep ?? ((): void => {});

  // Уровень изоляции задаётся ЯВНО (M-1 аудита I02A). Корректность handler-а завязана на
  // READ COMMITTED: под REPEATABLE READ/SERIALIZABLE конкурентная команда получает не
  // названный доменный отказ `stale_world_version`, а брошенный 40001
  // (`could not serialize access due to concurrent update`) — без строки в `command_results` и
  // без ретрая. Раньше уровень брался из настроек сервера, то есть `ALTER DATABASE` вне
  // репозитория молча менял наблюдаемую семантику отказа, и ни один тест этого не ловил.
  return db
    .transaction()
    .setIsolationLevel(CANONICAL_TRANSACTION_ISOLATION_LEVEL)
    .execute(async (trx) => {
      const locked = await trx
        .selectFrom('worlds')
        .select(['world_id', 'version'])
        .where('world_id', '=', command.world_id)
        // `FOR NO KEY UPDATE`, а не `FOR UPDATE` (M-6 аудита I02A). На `worlds` ссылаются шесть
        // таблиц; вставка в любую из них берёт `FOR KEY SHARE` на родительскую строку, а он
        // конфликтует с `FOR UPDATE`. Handler ключевых колонок `worlds` не меняет — только
        // `version`, `last_sequence`, `world_time` — поэтому более слабый замок даёт ту же
        // сериализацию команд мира, не блокируя проверки внешних ключей. С одним писателем
        // разницы не видно; со scheduler-ом I02B она станет измеримой.
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (locked === undefined) {
        throw new Error(`persistence: мир ${command.world_id} не существует`);
      }
      await afterStep('world-locked');

      // Идемпотентность проверяется ДО optimistic-версии: повтор уже исполненной команды обязан
      // вернуть прежний ответ, даже когда мир с тех пор ушёл вперёд (B3). Но «повтор» — это ТА
      // ЖЕ команда, а не тот же `command_id` (M-2): чужое тело под записанным id — подмена, и
      // она получает названный отказ и запись в аудит попыток (N-3).
      const fingerprint = commandFingerprint(command);
      const stored = await readStoredResult(trx, command.world_id, command.command_id, fingerprint);

      if (stored === 'fingerprint-mismatch') {
        const worldVersion = requireSafeInteger(locked.version, 'worlds.version');
        const recordedFingerprint = await readStoredFingerprint(
          trx,
          command.world_id,
          command.command_id,
        );
        // Записать в `command_results` нельзя: первичный ключ `(world_id, command_id)` занят
        // исходной командой, и перезапись потеряла бы её результат. Поэтому у попытки
        // собственный приёмник аудита — это не command journal и в идемпотентности не участвует.
        await trx
          .insertInto('command_attempt_rejections')
          .values({
            world_id: command.world_id,
            command_id: command.command_id,
            rejection_code: 'precondition_failed',
            recorded_fingerprint: recordedFingerprint,
            attempted_fingerprint: fingerprint,
            recorded_at: now(),
          })
          .execute();

        // p-6: приёмник наполняется ВНЕШНИМ входом (`--command-id` — публичный флаг), поэтому
        // рост ограничен на месте, а не отложен до retention-политики. Хранится последние
        // `MAX_ATTEMPTS_PER_COMMAND` попыток на (мир, command_id): сигнал «этот id перебирают»
        // сохраняется, а объём — нет.
        await sql`
          delete from command_attempt_rejections
           where world_id = ${command.world_id}
             and command_id = ${command.command_id}
             and attempt_id not in (
               select attempt_id from command_attempt_rejections
                where world_id = ${command.world_id} and command_id = ${command.command_id}
                order by attempt_id desc
                limit ${MAX_ATTEMPTS_PER_COMMAND}
             )
        `.execute(trx);

        await afterStep('attempt-recorded');
        await afterStep('before-commit');
        return {
          outcome: 'rejected',
          commandId: command.command_id,
          rejectionCode: 'precondition_failed',
          rejectionMessage:
            `command_id ${command.command_id} уже записан в journal этого мира с ДРУГИМ телом ` +
            'команды. Идемпотентность требует той же команды, а не только того же ' +
            'идентификатора. Попытка записана в command_attempt_rejections.',
          worldVersionBefore: worldVersion,
          worldVersionAfter: worldVersion,
          replayed: false,
        };
      }

      if (stored !== null) return stored;

      const [state, meta] = await Promise.all([
        loadWorldState(trx, command.world_id),
        loadWorldMeta(trx, command.world_id),
      ]);
      if (state === null || meta === null) {
        throw new Error(`persistence: мир ${command.world_id} исчез внутри транзакции`);
      }

      const worldTime = options.worldTime ?? state.worldTime;
      if (compareByCodePoint(worldTime, state.worldTime) < 0) {
        // Каноническая ISO-форма сравнима лексикографически, поэтому сравнение текстов и есть
        // сравнение моментов — без обращения к `Date` и без часового пояса.
        throw new Error(
          `persistence: мировое время не может идти назад (${state.worldTime} -> ${worldTime})`,
        );
      }

      const nextSequence = state.sequence + 1;
      const random = commandRandomSource(meta);
      const result = decide(state, command, {
        clock: new FixedClock(worldTime),
        random,
        // Ключ происхождения id — (мир, следующая sequence): воспроизводимо при пересимуляции и
        // уникально между командами, потому что принятая команда всегда двигает sequence.
        ids: new DerivedIdFactory(eventIdOriginKey(state.worldId, nextSequence)),
        ruleset: new FixedRuleset(meta.versions),
      });

      const recordedAt = now();

      if (result.kind === 'rejected') {
        await trx
          .insertInto('command_results')
          .values({
            world_id: command.world_id,
            command_id: command.command_id,
            type: command.type,
            outcome: 'rejected',
            rejection_code: result.rejection.code,
            rejection_message: result.rejection.message,
            event_ids: [],
            command_fingerprint: fingerprint,
            world_version_before: state.worldVersion,
            world_version_after: state.worldVersion,
            recorded_at: recordedAt,
          })
          .execute();
        await afterStep('command-result-inserted');
        await afterStep('before-commit');
        return {
          outcome: 'rejected',
          commandId: command.command_id,
          rejectionCode: result.rejection.code,
          rejectionMessage: result.rejection.message,
          worldVersionBefore: state.worldVersion,
          worldVersionAfter: state.worldVersion,
          replayed: false,
        };
      }

      let nextState = state;
      const eventIds: string[] = [];
      const recorded: WorldEvent[] = [];
      for (const draft of result.events) {
        // `recorded_at` ставит именно этот слой: домен операционных часов не знает
        // (`world-event.ts`, `decide.ts` — `DraftWorldEvent` намеренно без этого поля).
        const event: WorldEvent = { ...draft, recorded_at: recordedAt.toISOString() };
        await trx
          .insertInto('world_events')
          .values({
            event_id: event.event_id,
            world_id: event.world_id,
            sequence: event.sequence,
            world_time: event.world_time,
            type: event.type,
            schema_version: event.schema_version,
            rules_version: event.rules_version,
            content_version: event.content_version,
            actor_ids: [...event.actor_ids],
            subject_ids: [...event.subject_ids],
            location_id: event.location_id,
            correlation_id: event.correlation_id,
            caused_by: [...event.caused_by],
            command_id: event.command_id ?? null,
            random_audit: jsonOrNull(event.random_audit, `random_audit(${event.event_id})`),
            payload: requireCanonical(event.payload, `payload(${event.event_id})`),
            recorded_at: recordedAt,
            // Снимается с события ДО записи: `jsonb` не сохраняет канонический порядок ключей,
            // и точность обратного чтения обязана быть проверяемой, а не предполагаемой (M-3).
            event_checksum: requireChecksum(event, `event(${event.event_id})`),
          })
          .execute();
        eventIds.push(event.event_id);
        recorded.push(event);
        nextState = evolve(nextState, event);
      }
      await afterStep('event-inserted');

      // Расписание — часть канонического состояния (`ScheduledAction` в домене), поэтому
      // записывается в той же транзакции, что событие: ACCEPTANCE C1 требует, чтобы не было ни
      // события без запланированного завершения, ни завершения без события.
      //
      // Появившиеся действия вставляются, исчезнувшие ПОМЕЧАЮТСЯ выполненными, а не удаляются
      // (C2): каноническим является только незавершённое расписание, а история обработки нужна
      // для расследования «почему это произошло тогда, а не раньше».
      for (const action of Object.values(nextState.scheduledActions)) {
        if (state.scheduledActions[action.id] !== undefined) continue;
        await trx
          .insertInto('scheduled_actions')
          .values({
            world_id: command.world_id,
            action_id: action.id,
            kind: action.kind,
            due_at: action.dueAt,
            priority: action.priority,
            entity_id: action.entityId,
            route_id: action.routeId,
            lease_owner: null,
            lease_until: null,
            completed_at: null,
          })
          .execute();
      }
      for (const action of Object.values(state.scheduledActions)) {
        if (nextState.scheduledActions[action.id] !== undefined) continue;
        await trx
          .updateTable('scheduled_actions')
          .set({ completed_at: recordedAt, lease_owner: null, lease_until: null })
          .where('world_id', '=', command.world_id)
          .where('action_id', '=', action.id)
          .execute();
      }
      await afterStep('schedule-updated');

      for (const agent of changedAgents(state, nextState)) {
        await trx
          .updateTable('agents')
          .set({ location_id: agent.locationId, status: agent.status, route_id: agent.routeId })
          .where('world_id', '=', command.world_id)
          .where('agent_id', '=', agent.id)
          .execute();
      }
      await afterStep('agent-updated');

      await trx
        .updateTable('worlds')
        .set({
          version: nextState.worldVersion,
          last_sequence: nextState.sequence,
          world_time: nextState.worldTime,
          // Позиции двигаются ТОЛЬКО на принятой команде, и это не деталь реализации.
          // Отвергнутая команда событий не порождает, а replay проигрывает только события —
          // значит, розыгрыш, сделанный перед отказом, при пересимуляции не повторится. Если
          // бы позиция при отказе сдвигалась, replay разошёлся бы с непрерывным прогоном,
          // причём тем сильнее, чем чаще мир отвергает команды (SIM-01).
          prng_stream_positions: requireCanonical(
            random.positions(),
            `worlds.prng_stream_positions(${command.world_id})`,
          ),
        })
        .where('world_id', '=', command.world_id)
        .execute();
      await afterStep('world-updated');

      // Outbox пишется последним из фактов: строка доставки не должна существовать раньше
      // состояния, которое подписчик по ней прочитает (PLAN §7, инвариант 3).
      for (const event of recorded) {
        await trx
          .insertInto('outbox')
          .values({
            world_id: event.world_id,
            event_id: event.event_id,
            sequence: event.sequence,
            payload: requireCanonical(event, `outbox(${event.event_id})`),
            created_at: recordedAt,
            published_at: null,
          })
          .execute();
      }
      await afterStep('outbox-inserted');

      await trx
        .insertInto('command_results')
        .values({
          world_id: command.world_id,
          command_id: command.command_id,
          type: command.type,
          outcome: 'accepted',
          rejection_code: null,
          rejection_message: null,
          event_ids: eventIds,
          command_fingerprint: fingerprint,
          world_version_before: state.worldVersion,
          world_version_after: nextState.worldVersion,
          recorded_at: recordedAt,
        })
        .execute();
      await afterStep('command-result-inserted');

      // m-4 аудита I02A: `changedAgents` перечисляет поля `AgentState` вручную, поэтому новое
      // поле агента молча не персистилось бы — и ни один тест бы этого не заметил.
      // Перечитываем состояние ВНУТРИ той же транзакции и сверяем с тем, что вычислил домен:
      // расхождение значит, что запись потеряла часть состояния, и коммитить его нельзя.
      //
      // Граница защиты (n-6): она ловит «писатель забыл» только когда «читатель помнит». Для
      // ОБЯЗАТЕЛЬНОГО нового поля `AgentState` цепочка замыкается через typecheck —
      // `loadWorldState` не скомпилируется без него, и тогда guard поймает писателя. Для
      // НЕОБЯЗАТЕЛЬНОГО поля промолчат обе стороны, а значит и guard.
      const persisted = await loadWorldState(trx, command.world_id);
      if (persisted === null) {
        // n-5: внутри транзакции недостижимо, но без этой ветки `requireChecksum(null)` дал бы
        // checksum строки "null", и вместо «мир исчез» диагностика сказала бы «состояние не
        // совпало» — правдоподобно и неверно.
        throw new Error(
          `persistence: мир ${command.world_id} исчез между записью и перечитыванием внутри ` +
            'одной транзакции',
        );
      }
      const expectedChecksum = requireChecksum(nextState, 'состояние после evolve');
      const persistedChecksum = requireChecksum(persisted, 'состояние, прочитанное из БД');
      if (persistedChecksum !== expectedChecksum) {
        throw new Error(
          `persistence: записанное состояние мира ${command.world_id} не совпадает с ` +
            `результатом evolve (ожидалось ${expectedChecksum}, в БД ${persistedChecksum}). ` +
            'Транзакция отменена: частично сохранённое состояние хуже отсутствующего.',
        );
      }

      await afterStep('before-commit');

      return {
        outcome: 'accepted',
        commandId: command.command_id,
        eventIds,
        worldVersionBefore: state.worldVersion,
        worldVersionAfter: nextState.worldVersion,
        replayed: false,
      };
    });
};
