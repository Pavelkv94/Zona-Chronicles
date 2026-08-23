/**
 * M4 независимого архитектурного аудита I03 — `world init` атомарен.
 *
 * ## Чем был опасен полумир
 *
 * `initializeWorld`, `setWorldQualifiedProfile` и `writeSnapshot` шли ТРЕМЯ транзакциями. Обрыв
 * между ними оставлял мир, который: не принимает команд (нет квалифицированного профиля), не даёт
 * собрать проекцию (нет генезисного снимка), не пересоздаётся (`world init` отвечает «создан
 * параллельно другим процессом») и НЕ УДАЛЯЕТСЯ — команды drop/reset в CLI нет. Текст отказа при
 * этом советовал «пересоздайте мир», то есть действие, которого продукт не умеет.
 *
 * ## Почему тест устроен как свойство, а не как один сценарий
 *
 * Момент обрыва подобрать нельзя: транзакция коммитится за миллисекунды, и «попасть внутрь»
 * прицельно невозможно. Зато можно проверить СВОЙСТВО, которое обязано держаться при ЛЮБОМ
 * моменте обрыва: наблюдатель никогда не видит полумир. Мир либо есть целиком — строка `worlds`,
 * квалифицированный профиль и генезисный снимок, — либо его нет вовсе.
 *
 * Под старым кодом это свойство нарушалось наблюдаемо: между первой и второй транзакцией строка
 * `worlds` уже закоммичена, а снимка ещё нет.
 *
 * ## Защита от бессмысленного прогона
 *
 * Если бы все обрывы приходились ДО начала работы, тест проходил бы, ничего не проверив. Поэтому
 * требуется, чтобы среди попыток встретились ОБА исхода — «мира нет» и «мир создан целиком».
 * Оба сразу означают, что моменты обрыва легли по обе стороны операции, то есть окно между
 * транзакциями пересечено.
 *
 * Импорты относительные — `tests/` не workspace-пакет.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../../packages/persistence/src/__fixtures__/test-database.ts';
import {
  createDatabase,
  loadLatestSnapshot,
  loadWorldMeta,
  parseDatabaseConnectionUrl,
} from '../../packages/persistence/src/index.ts';
import { currentBundles, currentDeterministicRuntimeProfile } from '../../apps/cli/src/world.ts';
import { killAndWait } from '../support/kill-child.ts';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL('../../apps/cli/src/main.ts', import.meta.url));
const WORLD_ID = 'world:prototype';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type WorldShape = { readonly meta: boolean; readonly snapshot: boolean };

describe('M4 — обрыв world init не оставляет мир, который нельзя ни использовать, ни удалить', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('acceptance_i03_m4');
    const migrate = spawnWorldCliDirect(['world', 'migrate'], { env: { DATABASE_URL: db.url } });
    expect(migrate.exitCode, migrate.stdout).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await db.drop();
  });

  it('после любого обрыва мир либо есть целиком, либо его нет вовсе', async () => {
    const outcomes: WorldShape[] = [];

    const inspect = async (): Promise<WorldShape> => {
      const connection = createDatabase(parseDatabaseConnectionUrl(db.url));
      try {
        const meta = await loadWorldMeta(connection, WORLD_ID);
        if (meta === null) return { meta: false, snapshot: false };
        const snapshot = await loadLatestSnapshot(connection, WORLD_ID, {
          bundles: currentBundles(),
          runtimeProfile: currentDeterministicRuntimeProfile(),
        });
        return { meta: true, snapshot: snapshot !== null };
      } finally {
        await connection.destroy();
      }
    };

    // Обрывы на растущих задержках: ранние приходятся на старт процесса, поздние — на уже
    // завершённую работу, и где-то между ними лежит окно записи.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const child: ChildProcess = spawn('node', [CLI_ENTRY, 'world', 'init', '--seed', '42'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        env: { ...process.env, DATABASE_URL: db.url },
      });
      // Шаг задержки подобран замером, а не на глаз: при 150 + 60·n ни один прогон не успевал
      // дойти до конца за 16 попыток, и срабатывала защита от бессмысленного прогона — она же и
      // показала, что диапазон мал.
      await sleep(200 + attempt * 250);
      await killAndWait(child);

      const shape = await inspect();
      // СВОЙСТВО: полумира не бывает.
      expect(
        shape.meta === shape.snapshot,
        `попытка ${String(attempt)}: мир создан частично (worlds=${String(shape.meta)}, ` +
          `снимок=${String(shape.snapshot)}) — такой мир нельзя ни использовать, ни удалить`,
      ).toBe(true);
      outcomes.push(shape);

      if (shape.meta) break; // мир создан целиком: дальше обрывать нечего
    }

    // Защита от бессмысленного прогона: оба исхода обязаны встретиться.
    expect(
      outcomes.some((shape) => !shape.meta),
      'ни один обрыв не пришёлся до создания мира — тест не проверял окно',
    ).toBe(true);
    expect(
      outcomes.some((shape) => shape.meta),
      'ни один прогон не довёл создание до конца — окно записи не пересечено',
    ).toBe(true);
  }, 180_000);
});
