#!/usr/bin/env node
/**
 * Проверка заявленных workspace-зависимостей против матрицы ADR-002.
 *
 * pnpm workspaces физически запрещают импорт необъявленного пакета, поэтому
 * package.json является первым слоем enforcement; dependency-cruiser проверяет
 * фактические импорты, а этот скрипт — декларации. Оба входят в `boundaries:check`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type PackageManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const ALLOWED: Record<string, readonly string[]> = {
  '@zona/contracts': [],
  '@zona/domain': ['@zona/contracts'],
  '@zona/simulation': ['@zona/contracts', '@zona/domain'],
  '@zona/persistence': ['@zona/contracts', '@zona/domain'],
  '@zona/projections': ['@zona/contracts', '@zona/domain', '@zona/persistence'],
  '@zona/representation': ['@zona/contracts', '@zona/projections'],
  '@zona/content': [],
  '@zona/testkit': ['@zona/contracts', '@zona/domain'],
  '@zona/api': ['@zona/contracts', '@zona/projections'],
  '@zona/worker': [
    '@zona/contracts',
    '@zona/domain',
    '@zona/simulation',
    '@zona/persistence',
    '@zona/projections',
    '@zona/representation',
  ],
  '@zona/cli': [
    '@zona/contracts',
    '@zona/domain',
    '@zona/simulation',
    '@zona/persistence',
    '@zona/projections',
    '@zona/content',
  ],
  '@zona/agent-harness': [],
  '@zona/security-scan': [],
};

/**
 * Внешние зависимости канонического ядра — ALLOW-LIST, а не deny-list (ADR-003, ACCEPTANCE B10).
 *
 * Первая редакция перечисляла шесть запрещённых имён (`pg`, `kysely`, `fastify`, …). Независимый
 * аудит I02A показал, чего стоит такое перечисление: `nanoid` или `uuid` в `packages/domain`
 * проходят обе проверки границ насквозь — объявленная зависимость резолвится, поэтому
 * `no-unresolvable` молчит, а в список запрещённых она не входит. Проверено исполнением:
 * `nanoid` в манифесте домена давал `boundaries:check` зелёным. Тот же класс — `undici`/`axios`
 * (глобальный `fetch` закрыт eslint-ом, библиотечный HTTP нет), `luxon`/`date-fns`,
 * `drizzle-orm`. Именно от id на случайности предостерегает шапка `id-factory.ts`, и именно его
 * deny-list не ловил.
 *
 * Поэтому список перевёрнут: ядру запрещено ВСЁ, кроме явно перечисленного. Сейчас перечислять
 * нечего — и это правильное состояние, а не недосмотр. Каждое будущее исключение придётся
 * добавить сюда явно, то есть объяснить в diff-е.
 */
const CORE_EXTERNAL_ALLOWLIST: Record<string, readonly string[]> = {
  '@zona/contracts': ['@sinclair/typebox'],
  '@zona/domain': [],
  '@zona/simulation': [],
  '@zona/content': [],
};

const WORKSPACE_ROOTS = ['apps', 'packages', 'tools'] as const;
const violations: string[] = [];

for (const root of WORKSPACE_ROOTS) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
    const name = manifest.name;
    if (name === undefined) {
      violations.push(`${manifestPath}: отсутствует поле name`);
      continue;
    }
    const allowed = ALLOWED[name];
    if (allowed === undefined) {
      violations.push(
        `${name}: пакет не описан в матрице ADR-002 (scripts/boundaries/check-workspace-graph.ts)`,
      );
      continue;
    }
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ].filter((dependency) => dependency.startsWith('@zona/'));

    for (const dependency of declared) {
      if (!allowed.includes(dependency)) {
        violations.push(`${name} -> ${dependency}: запрещённая зависимость по ADR-002`);
      }
    }

    const allowlist = CORE_EXTERNAL_ALLOWLIST[name];
    if (allowlist !== undefined) {
      const declaredExternal = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ].filter((dependency) => !dependency.startsWith('@zona/'));

      for (const dependency of declaredExternal) {
        if (!allowlist.includes(dependency)) {
          violations.push(
            `${name} -> ${dependency}: каноническому ядру внешние зависимости запрещены, кроме ` +
              `явно перечисленных [${allowlist.join(', ') || 'ни одной'}] ` +
              '(ADR-003, scripts/boundaries/check-workspace-graph.ts)',
          );
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Нарушения границ пакетов:');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log('workspace graph: границы ADR-002 соблюдены');
