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
  /** Мировое время: действие доступно, когда `due_at <= worldTime`. */
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
export const claimDueActions = async (
  db: DatabaseConnection,
  options: ClaimOptions,
): Promise<readonly ClaimedAction[]> => {
  const now = options.now ?? ((): Date => new Date());
  const leaseUntil = new Date(now().getTime() + options.leaseMs);

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
           and due_at <= ${options.worldTime}
           and (lease_owner is null or lease_until <= ${now()})
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
  readonly batchSize?: number;
  readonly leaseMs?: number;
  /** Реальные часы: срок аренды и `recorded_at`. Инъектируются для проб с просроченной арендой. */
  readonly now?: () => Date;
}

export interface TickResult {
  readonly claimed: number;
  readonly executed: readonly CommandExecution[];
  readonly worldTime: string;
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
export const runWorldTick = async (
  db: DatabaseConnection,
  options: TickOptions,
): Promise<TickResult> => {
  const state = await loadWorldState(db, options.worldId);
  if (state === null) throw new Error(`scheduler: мир ${options.worldId} не существует`);

  const claimed = await claimDueActions(db, {
    worldId: options.worldId,
    worldTime: state.worldTime,
    owner: options.owner,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const meta = await loadWorldMeta(db, options.worldId);
  if (meta === null) throw new Error(`scheduler: мир ${options.worldId} не существует`);

  const executed: CommandExecution[] = [];
  for (const action of claimed) {
    // Версия мира перечитывается перед КАЖДЫМ действием: предыдущее её уже сдвинуло.
    const current = await loadWorldState(db, options.worldId);
    if (current === null) throw new Error(`scheduler: мир ${options.worldId} исчез посреди шага`);

    const command = commandFor(action, {
      worldId: options.worldId,
      schemaVersion: meta.versions.schemaVersion,
      version: current.worldVersion,
    });
    executed.push(
      await executeCommand(db, command, {
        worldTime: action.dueAt,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    );
  }

  const after = await loadWorldState(db, options.worldId);
  return { claimed: claimed.length, executed, worldTime: after?.worldTime ?? state.worldTime };
};

/**
 * Команда завершения, выведенная из действия ДЕТЕРМИНИРОВАННО.
 *
 * `command_id` выводится из `action_id`, а не из случайности: повторная обработка того же
 * действия — например после истечения аренды у зависшего worker-а — обязана попасть в journal
 * идемпотентности и вернуть записанный результат, а не создать второе событие (C6).
 */
export const commandFor = (
  action: ClaimedAction,
  world: { readonly worldId: string; readonly schemaVersion: number; readonly version: number },
): Command => ({
  command_id: new DerivedIdFactory(`${action.actionId}:command`).next(RUNTIME_ID_PREFIXES.command),
  world_id: world.worldId,
  type: 'journey.complete',
  schema_version: world.schemaVersion,
  actor_id: action.entityId,
  issued_at_world_time: action.dueAt,
  expected_world_version: world.version,
  correlation_id: new DerivedIdFactory(`${action.actionId}:correlation`).next(
    RUNTIME_ID_PREFIXES.correlation,
  ),
  caused_by_event_id: action.actionId,
  payload: { route_id: action.routeId },
});
