#!/usr/bin/env node
/**
 * Съёмка evidence-пакета итерации I03 (`10_ITERATION_MASTER_PLAN` §3).
 *
 * ## Почему это скрипт, а не руками выполненные команды
 *
 * Evidence-пакеты I02A и I02B собирались вручную: часть файлов — вывод CLI, часть — выгрузка
 * psql. Это работало, пока доказательством был текст. В I03 доказательством стал ЭКРАН, и
 * скриншот, снятый вручную, ничем не отличается от скриншота, снятого в другой момент, из
 * другого мира или из мира, подготовленного к съёмке. Скрипт снимает всё из ОДНОГО прогона
 * одного мира: канонический журнал, ответы observer API и четыре кадра экрана связаны общим
 * `world_id` и общей последовательностью, и это проверяемо по самим файлам.
 *
 * ## Что здесь доказывается, а что нет
 *
 * Скрипт НЕ является тестом и ничего не утверждает: он снимает. Утверждения живут в
 * acceptance-тестах D1–D14 и в `REPORT.md`. Единственная проверка, которую он делает сам, —
 * что стек вообще поднялся и что журнал непуст; иначе он падает, а не кладёт в артефакты
 * пустоту, выглядящую как результат.
 *
 * Канонический журнал читается ИЗ КАНОНИЧЕСКИХ ТАБЛИЦ, а ответы экрана — из observer API.
 * Это не дублирование: сверка «увиденное совпадает с журналом» имеет смысл только если два
 * файла пришли из двух РАЗНЫХ источников. Прочитай скрипт оба через API — он сверял бы
 * проекцию с самой собой.
 *
 * ## Запуск
 *
 *   pnpm build && node scripts/evidence/capture-i03.ts
 *
 * Нужны поднятый PostgreSQL (`docker compose up -d postgres`) и собранный `apps/web`:
 * `next start` не собирает, а стартует. Отсутствие сборки — явный отказ с командой, а не
 * загадочный таймаут ожидания экрана.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  createDatabase,
  loadWorldEvents,
  parseDatabaseConnectionUrl,
} from '../../packages/persistence/src/index.ts';
import { PROTOTYPE_WORLD } from '../../packages/content/src/index.ts';
import { startWorldStack } from '../../tests/e2e/support/world-stack.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT_DIR = join(REPO_ROOT, 'docs/iterations/I03-journey-to-browser/artifacts');
const SHOTS_DIR = join(OUT_DIR, 'screenshots');

/** Агент и маршрут демо. Те же, что в `PLAN.md` §2 — демо и артефакт обязаны совпадать. */
const AGENT = 'agent:rook';
const ROUTE = 'route:yard-to-bridge';
/** Локация без единого входящего маршрута — критерий отказа D12. */
const UNREACHABLE = 'loc:relay-station';

const write = (name: string, body: string): void => {
  writeFileSync(join(OUT_DIR, name), body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  process.stdout.write(`  сняли ${name}\n`);
};

async function main(): Promise<void> {
  if (!existsSync(join(REPO_ROOT, 'apps/web/.next'))) {
    throw new Error('evidence: apps/web не собран. Выполните `pnpm build`, затем повторите.');
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(SHOTS_DIR, { recursive: true });

  process.stdout.write('Поднимаю стек мира\n');
  // Темп 6 минут мира за секунду, а не 60 как в e2e. Причина найдена этой же съёмкой: при 60
  // горизонт одного тика перекрывает сорокаминутный путь, `journey.started` и
  // `journey.completed` рождаются в одном тике, и состояние «в пути» не существует ни в один
  // наблюдаемый момент. Кадр «агент на карте в пути» при таком темпе снять НЕЛЬЗЯ — не потому
  // что мир неправ, а потому что показывать нечего.
  const stack = await startWorldStack('evidence', { worldMinutesPerRealSecond: 6 });
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(stack.webUrl, { waitUntil: 'networkidle' });

    // Ждём ЖИВОЙ поток, а не загрузку страницы. `networkidle` наступает раньше, чем открывается
    // SSE, и первая редакция скрипта из-за этого снимала «путь начат» на странице, которая ещё
    // не подписана: событие не приходило вовсе, и съёмка падала по таймауту. Ошибка моя, но
    // поучительная — она ровно та, которую кадр «обновилось без перезагрузки» и обязан исключать:
    // без этого ожидания кадр доказывал бы работу перезагрузки.
    await page.getByText('Поток: живой').waitFor({ timeout: 30_000 });

    write('01-initial-state.txt', stack.cli(['world', 'state']).stdout);
    await page.screenshot({ path: join(SHOTS_DIR, '01-world-at-rest.png'), fullPage: true });

    // D12: отказ снимается ДО успешного пути. Артефакт, показывающий только удачу, доказывает
    // меньше, чем кажется: система, принимающая всё, тоже даёт такой артефакт.
    const refusal = stack.cli(['world', 'run', '--agent', AGENT, '--route', UNREACHABLE]);
    write(
      '02-refusal.txt',
      `$ world run --agent ${AGENT} --route ${UNREACHABLE}\n` +
        `exit code: ${String(refusal.exitCode)}\n\n${refusal.stdout}`,
    );

    process.stdout.write('Начинаю путь\n');
    const started = stack.cli(['world', 'run', '--agent', AGENT, '--route', ROUTE]);
    if (started.exitCode !== 0) throw new Error(`evidence: world run упал: ${started.stdout}`);
    write('03-run.txt', `$ world run --agent ${AGENT} --route ${ROUTE}\n\n${started.stdout}`);

    // Страница НЕ перезагружается: кадр обязан показать, что состояние приехало потоком.
    await page.getByText('В пути').waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(SHOTS_DIR, '02-journey-started.png'), fullPage: true });

    process.stdout.write('Жду завершения пути (мир идёт сам)\n');
    await page.getByText('journey.completed').first().waitFor({ timeout: 90_000 });
    await page.screenshot({ path: join(SHOTS_DIR, '03-journey-completed.png'), fullPage: true });

    // D11: перезагрузка восстанавливает состояние snapshot-ом, а не историей потока.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('journey.completed').first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: join(SHOTS_DIR, '04-after-reload.png'), fullPage: true });
    process.stdout.write('  сняли 4 кадра экрана\n');

    // Ответы observer API снимаются рядом с журналом: именно их сверка и есть проверка
    // «увиденное совпадает с каноническим журналом». Два файла — два независимых источника.
    const snapshot = await (await fetch(`${stack.apiUrl}/v1/world/snapshot`)).json();
    write('observer-snapshot.json', JSON.stringify(snapshot, null, 2));
    const feed = await (await fetch(`${stack.apiUrl}/v1/events?after=0&limit=100`)).json();
    write('observer-events.json', JSON.stringify(feed, null, 2));

    write('04-final-state.txt', stack.cli(['world', 'state']).stdout);
    write('05-events-cli.txt', stack.cli(['world', 'events']).stdout);
    write('06-replay.txt', stack.cli(['world', 'replay']).stdout);

    // Канонический журнал — из канонических таблиц, настоящим JSONL, по строке на событие.
    const db = createDatabase(parseDatabaseConnectionUrl(stack.databaseUrl));
    try {
      const events = await loadWorldEvents(db, PROTOTYPE_WORLD.worldId);
      if (events.length === 0)
        throw new Error('evidence: канонический журнал пуст — снимать нечего');
      write('events.jsonl', events.map((event) => JSON.stringify(event)).join('\n'));
    } finally {
      await db.destroy();
    }
  } finally {
    await browser.close();
    await stack.stop();
  }

  process.stdout.write(`\nГотово: ${OUT_DIR}\n`);
}

await main();
