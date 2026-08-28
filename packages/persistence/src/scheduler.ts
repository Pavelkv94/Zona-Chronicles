/**
 * Очередь запланированных действий и один шаг worker-а (I02B, ACCEPTANCE C2–C6).
 *
 * Живёт в `persistence`, а не в `simulation`, по границе ADR-002: это адаптер очереди поверх
 * PostgreSQL — `SKIP LOCKED`, аренда, порядок захвата. `simulation` знает только контракты и
 * домен и о существовании базы не подозревает. Оркестрацию используют и `apps/worker`, и
 * `apps/cli` (`world tick`), поэтому она не может жить внутри одного из них.
 *
 * ## Почему аренда, а не просто транзакция
 *
 * Захват и исполнение — разные транзакции. Исполнение вызывает `executeCommand`, который берёт
 * собственный `FOR NO KEY UPDATE` на мир; держать всё в одной транзакции значило бы держать
 * замок мира на время всей пачки. Аренда со сроком развязывает это: захваченное действие
 * невидимо другим worker-ам до истечения `lease_until`, а умерший worker не блокирует очередь
 * навсегда (C6).
 */
import { sql } from 'kysely';
import { RUNTIME_ID_PREFIXES, compareByCodePoint, type Command } from '@zona/contracts';
import { DerivedIdFactory } from '@zona/domain';
import type { DatabaseConnection } from './database.ts';
import { executeCommand, type CommandExecution } from './command-handler.ts';
import { loadWorldMeta, loadWorldState } from './world-repository.ts';

export interface ClaimedAction {
  readonly actionId: string;
  readonly kind: 'journey.complete';
  readonly dueAt: string;
  readonly priority: number;
  readonly entityId: string;
  readonly routeId: string;
}

export interface ClaimOptions {
  readonly worldId: string;
  /** Горизонт: действие доступно, когда `due_at <= worldTime`. См. `TickOptions.horizon`. */
  readonly worldTime: string;
  /** Кто захватывает. Разные worker-ы обязаны иметь разные значения. */
  readonly owner: string;
  readonly leaseMs: number;
  readonly batchSize: number;
  /** Реальные часы для срока аренды. Инъектируются, чтобы тест мог просрочить аренду. */
  readonly now?: () => Date;
}

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_BATCH_SIZE = 32;

/**
 * Захватывает ближайшие доступные действия в СТАБИЛЬНОМ порядке (C4).
 *
 * Порядок `(due_at, priority, entity_id, action_id)` совпадает с порядком индекса, поэтому он
 * не зависит ни от плана запроса, ни от скорости процесса. `FOR UPDATE SKIP LOCKED` даёт второму
 * worker-у пропустить строки, которые прямо сейчас захватывает первый, вместо ожидания (C5).
 */
/**
 * Выражение срока аренды: часы СЕРВЕРА БД (M1), либо инъектированные часы в тестовой пробе.
 * Один источник времени на всех worker-ов — расхождение часов в кластере это норма.
 */
const leaseExpression = (options: {
  readonly leaseMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}) =>
  options.now === undefined
    ? sql<Date>`now() + make_interval(secs => ${(options.leaseMs ?? DEFAULT_LEASE_MS) / 1000})`
    : sql<Date>`${new Date(options.now().getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS))}::timestamptz`;

export const claimDueActions = async (
  db: DatabaseConnection,
  options: ClaimOptions,
): Promise<readonly ClaimedAction[]> => {
  // M1 аудита: срок аренды и сравнение с ним берутся из ЧАСОВ СЕРВЕРА БД, а не из часов
  // процесса. Раньше и то, и другое приходило из `new Date()` вызывающего: worker с часами на
  // минуту вперёд уводил живую аренду у соседа. Пока писатель был один, это было безобидно —
  // спасала идемпотентность; со вторым писателем это вход в потерю пути.
  //
  // Один источник времени на всех worker-ов — свойство, которое нельзя получить настройкой
  // машин: расхождение часов в кластере это норма, а не сбой. `options.now` остаётся
  // ТЕСТОВЫМ переопределением: когда он задан, время берётся из него, и проба может состарить
  // аренду детерминированно.
  const leaseUntil = leaseExpression(options);
  const nowExpression =
    options.now === undefined ? sql<Date>`now()` : sql<Date>`${options.now()}::timestamptz`;

  const claimed = await sql<{
    action_id: string;
    kind: 'journey.complete';
    due_at: string;
    priority: number;
    entity_id: string;
    route_id: string;
  }>`
    update scheduled_actions target
       set lease_owner = ${options.owner}, lease_until = ${leaseUntil}
      from (
        select world_id, action_id
          from scheduled_actions
         where world_id = ${options.worldId}
           and completed_at is null
           and failed_at is null
           and due_at <= ${options.worldTime}
           and (lease_owner is null or lease_until <= ${nowExpression})
         order by due_at, priority, entity_id, action_id
         limit ${options.batchSize}
         for update skip locked
      ) as picked
     where target.world_id = picked.world_id and target.action_id = picked.action_id
    returning target.action_id, target.kind, target.due_at, target.priority,
              target.entity_id, target.route_id
  `.execute(db);

  // `returning` не гарантирует порядок; он восстанавливается тем же ключом, что и в запросе,
  // иначе стабильность обработки зависела бы от плана выполнения (C4).
  return [...claimed.rows]
    .map((row) => ({
      actionId: row.action_id,
      kind: row.kind,
      dueAt: row.due_at,
      priority: row.priority,
      entityId: row.entity_id,
      routeId: row.route_id,
    }))
    .sort(
      (a, b) =>
        compareByCodePoint(a.dueAt, b.dueAt) ||
        a.priority - b.priority ||
        compareByCodePoint(a.entityId, b.entityId) ||
        compareByCodePoint(a.actionId, b.actionId),
    );
};

export interface TickOptions {
  readonly worldId: string;
  readonly owner: string;
  /**
   * ГОРИЗОНТ: до какого мирового времени двигать мир этим шагом.
   *
   * Без него мир стоял бы вечно, и это не мелочь, а суть модели. ADR-004 выбрал
   * дискретно-событийное время вместо глобального тика: мировое время двигают САМИ события, а
   * не отдельный таймер. Значит, у первого действия нет никого, кто довёл бы мир до его
   * `due_at` — до горизонта эта конструкция была замкнутым кругом, и тесты обходили его,
   * подкручивая `worlds.world_time` руками.
   *
   * Горизонт приходит СНАРУЖИ, из оболочки (оператор, worker, связка со скоростью мира), и
   * именно поэтому детерминизм сохраняется: канонический результат зависит от горизонта, а не
   * от того, когда процессу дали процессорное время. Replay горизонта не требует вовсе — он
   * применяет уже записанные события.
   *
   * По умолчанию — текущее мировое время: тогда обрабатывается только то, что уже наступило,
   * и ненаступившее действие не исполняется (ACCEPTANCE C3).
   */
  readonly horizon?: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  /** Реальные часы: срок аренды и `recorded_at`. Инъектируются для проб с просроченной арендой. */
  readonly now?: () => Date;
}

export interface TickResult {
  readonly claimed: number;
  readonly executed: readonly CommandExecution[];
  readonly worldTime: string;
  /**
   * Срок БЛИЖАЙШЕГО ждущего действия после этого шага, `null` — миру нечего делать.
   *
   * Отдельное поле, а не следствие `claimed`: шаг захватывает ноль действий и когда расписание
   * пусто, и когда действие запланировано, но не наступило. Для оболочки, задающей горизонт, это
   * противоположные состояния — в первом накопленное реальное время обязано пропасть, во втором
   * обязано копиться, иначе горизонт не дорастёт до срока никогда. Различить их снаружи можно
   * было только вторым запросом к расписанию, то есть продублировав здешнее знание.
   *
   * Отвергнутые и завершённые действия ждущими не считаются: строка, оставшаяся в расписании
   * после отказа, иначе держала бы мир «занятым» вечно.
   */
  readonly nextDueAt: string | null;
}

/**
 * Один шаг worker-а: захватить доступные действия и исполнить каждое как команду.
 *
 * Действие превращается в НАМЕРЕНИЕ (`journey.complete`) и идёт через тот же `executeCommand`,
 * что внешняя команда: у мира один способ измениться (см. `COMMAND_TYPES` в контрактах).
 * Отсюда же берётся идемпотентность — `command_id` действия детерминирован, поэтому повторное
 * исполнение того же действия вернёт записанный результат, а не создаст второе событие (C6).
 *
 * Мировое время продвигается к `due_at` обрабатываемого действия и только вперёд (C12).
 */
/**
 * Ключ advisory-лока мира. Выводится из `world_id` детерминированно, чтобы два процесса,
 * работающих с одним миром, получили один ключ, а разные миры друг друга не блокировали.
 */
const worldLockKey = (worldId: string): number => {
  let hash = 0x811c9dc5;
  for (const char of worldId) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // `pg_try_advisory_lock(int)` принимает знаковое 32-битное — приводим в его диапазон.
  return hash | 0;
};

export interface TickResultSkipped {
  readonly claimed: 0;
  readonly executed: readonly [];
  readonly worldTime: string;
  /** `true` — мир в этот момент обрабатывал другой worker, и шаг не выполнялся. */
  readonly skipped: true;
  /**
   * ВСЕГДА отсутствует: шаг не выполнялся, и о расписании этот результат не знает ничего.
   * Отдельное «неизвестно» вместо `null` не случайно — `null` означал бы «нечего делать», то
   * есть утверждение о мире, которого пропущенный шаг не делал.
   */
  readonly nextDueAt?: undefined;
}

/**
 * Один шаг worker-а: захватить доступные действия и исполнить каждое как команду.
 *
 * ## Почему шаг держит advisory lock мира
 *
 * `03_TECHNICAL_DESIGN` §5 шаг 1 предписывает transaction-level advisory lock канонического
 * мира, и I02A записала отклонение от него как безобидное. Независимый аудит I02B и
 * последующая проба показали, что оно таковым не является.
 *
 * Мировое время монотонно и ГЛОБАЛЬНО: его двигает каждое обработанное действие к своему
 * `due_at`. Два worker-а, выбирающие батчи независимо, неизбежно берут действия с РАЗНЫМИ
 * `due_at` — и тот, кому досталось более раннее, пытается сдвинуть время назад. Воспроизведено:
 * шесть агентов с разными сроками, три worker-а, `2028-04-26T06:30:00.000Z -> …06:25:00.000Z`.
 *
 * То есть параллелизм между worker-ами на ОДНОМ мире несовместим с одними монотонными часами —
 * это не дефект реализации, а свойство модели, и §5 его учитывал.
 *
 * `pg_try_advisory_lock`, а не `pg_advisory_lock`: второй worker не ждёт, а честно сообщает,
 * что мир сейчас обрабатывается, и возвращается пустым шагом. Ожидание превратило бы очередь
 * worker-ов в скрытую сериализацию с непредсказуемой задержкой.
 *
 * `SKIP LOCKED` при этом остаётся нужным: он развязывает worker-ов на РАЗНЫХ мирах и защищает
 * от строк, захваченных на время собственного батча.
 *
 * Мировое время продвигается к `due_at` обрабатываемого действия и только вперёд (C12).
 */
export const runWorldTick = async (
  db: DatabaseConnection,
  options: TickOptions,
): Promise<TickResult | TickResultSkipped> =>
  db.connection().execute(async (connection) => {
    const key = worldLockKey(options.worldId);
    const acquired = await sql<{ ok: boolean }>`select pg_try_advisory_lock(${key}) as ok`.execute(
      connection,
    );
    if (acquired.rows[0]?.ok !== true) {
      const current = await loadWorldState(db, options.worldId);
      if (current === null) throw new Error(`scheduler: мир ${options.worldId} не существует`);
      return { claimed: 0, executed: [], worldTime: current.worldTime, skipped: true };
    }

    try {
      return await tickUnderLock(db, options);
    } finally {
      await sql`select pg_advisory_unlock(${key})`.execute(connection);
    }
  });

const tickUnderLock = async (db: DatabaseConnection, options: TickOptions): Promise<TickResult> => {
  const state = await loadWorldState(db, options.worldId);
  if (state === null) throw new Error(`scheduler: мир ${options.worldId} не существует`);

  const horizon = options.horizon ?? state.worldTime;
  if (compareByCodePoint(horizon, state.worldTime) < 0) {
    throw new Error(
      `scheduler: горизонт ${horizon} раньше текущего мирового времени ${state.worldTime}: ` +
        'мир не идёт назад (C12)',
    );
  }

  const claimed = await claimDueActions(db, {
    worldId: options.worldId,
    worldTime: horizon,
    owner: options.owner,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const meta = await loadWorldMeta(db, options.worldId);
  if (meta === null) throw new Error(`scheduler: мир ${options.worldId} не существует`);

  const executed: CommandExecution[] = [];
  for (const action of claimed) {
    // M2 аудита: аренда бралась один раз на всю пачку, а действия исполняются последовательно
    // отдельными транзакциями. При `batchSize` 32 и аренде 30 секунд она истекает на середине,
    // и остаток параллельно подхватывает другой worker — то есть worker работает над тем, что
    // ему уже не принадлежит.
    //
    // Владение перепроверяется и ПРОДЛЕВАЕТСЯ перед каждым действием, одним оператором: если
    // строка больше не наша (аренду перехватили), обновится ноль строк, и действие
    // пропускается — его уже ведёт другой. Дубля события не будет в любом случае
    // (идемпотентность по `command_id`), но делать двойную работу незачем, а рассинхрон
    // владения — источник будущих гонок.
    //
    // ЧЕСТНАЯ ГРАНИЦА: тестом это не покрыто, и покрыть без шва в продукте нельзя. Перехват
    // должен произойти МЕЖДУ захватом и исполнением внутри одного тика; снаружи в это окно не
    // попасть, а добавлять `afterClaim`-хук ради теста значило бы вернуть в публичный код шов,
    // существующий только чтобы его проверяли, — ровно то, что уже убиралось из этого пакета
    // однажды. Попытка написать такой тест снаружи дала тест, проходивший по неверной причине,
    // и он удалён, а не оставлен зелёным.
    const held = await db
      .updateTable('scheduled_actions')
      .set({ lease_until: leaseExpression(options) })
      .where('world_id', '=', options.worldId)
      .where('action_id', '=', action.actionId)
      .where('lease_owner', '=', options.owner)
      .where('completed_at', 'is', null)
      .where('failed_at', 'is', null)
      .executeTakeFirst();
    if ((held.numUpdatedRows ?? 0n) === 0n) continue;

    const command = commandFor(action, {
      worldId: options.worldId,
      schemaVersion: meta.versions.schemaVersion,
    });
    const outcome = await executeCommand(db, command, {
      worldTime: action.dueAt,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    executed.push(outcome);

    if (outcome.outcome === 'rejected') {
      // Доменный отказ на запланированном действии — нормальный исход (действие могло
      // устареть, пока ждало очереди), но он обязан быть КОНЕЧНЫМ. Без этой пометки действие
      // возвращалось в очередь каждым следующим тиком и отвергалось вечно, а агент навсегда
      // оставался в пути (blocker аудита I02B, воспроизведён детерминированно).
      //
      // Починить автоматически нельзя: мир не знает, чего хотел оператор. Можно только
      // перестать делать вид, что всё в порядке.
      await db
        .updateTable('scheduled_actions')
        .set({
          failed_at: (options.now ?? ((): Date => new Date()))(),
          failure_code: outcome.rejectionCode,
          lease_owner: null,
          lease_until: null,
        })
        .where('world_id', '=', options.worldId)
        .where('action_id', '=', action.actionId)
        .execute();
    }
  }

  const after = await loadWorldState(db, options.worldId);
  const pending = await db
    .selectFrom('scheduled_actions')
    .select('due_at')
    .where('world_id', '=', options.worldId)
    .where('completed_at', 'is', null)
    .where('failed_at', 'is', null)
    .orderBy('due_at')
    .limit(1)
    .executeTakeFirst();
  return {
    claimed: claimed.length,
    executed,
    worldTime: after?.worldTime ?? state.worldTime,
    nextDueAt: pending?.due_at ?? null,
  };
};

/**
 * Команда завершения, выведенная из действия ДЕТЕРМИНИРОВАННО.
 *
 * `command_id` выводится из `action_id`, а не из случайности: повторная обработка того же
 * действия — например после истечения аренды у зависшего worker-а — обязана попасть в journal
 * идемпотентности и вернуть записанный результат, а не создать второе событие (C6).
 *
 * `expected_world_version` НЕ ставится (ADR-011): действие породил сам мир, проверять нечего, а
 * его присутствие делало отпечаток зависимым от гонки — конкурентный сдвиг версии между чтением
 * и захватом замка приводил к вечному `precondition_failed` и агенту, застрявшему `traveling`
 * навсегда (blocker независимого аудита I02B, воспроизведён).
 */
export const commandFor = (
  action: ClaimedAction,
  world: { readonly worldId: string; readonly schemaVersion: number },
): Command => ({
  command_id: new DerivedIdFactory(`${action.actionId}:command`).next(RUNTIME_ID_PREFIXES.command),
  world_id: world.worldId,
  type: 'journey.complete',
  schema_version: world.schemaVersion,
  actor_id: action.entityId,
  issued_at_world_time: action.dueAt,
  correlation_id: new DerivedIdFactory(`${action.actionId}:correlation`).next(
    RUNTIME_ID_PREFIXES.correlation,
  ),
  caused_by_event_id: action.actionId,
  payload: { route_id: action.routeId },
});
