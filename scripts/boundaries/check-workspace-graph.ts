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

interface CorePackagePolicy {
  readonly runtime: readonly string[];
  readonly development: readonly string[];
}

const CORE_TEST_TOOLING: readonly string[] = ['vitest', 'fast-check'];

/**
 * Пакеты проекта: workspace-зависимости и, для пакетов ядра, разрешённые внешние.
 *
 * ОДНА таблица, а не две (n-14 аудита). Прежде списки были раздельными и вели себя
 * противоположно: отсутствие пакета в матрице ADR-002 было ошибкой, а отсутствие в core-списке
 * — молчаливым снятием всего внешнего контроля. Новый пакет ядра обязан был попасть в два
 * места, и забывание второго ничего не ломало. Теперь признак `core` и оба списка живут рядом,
 * поэтому пропуск структурно невозможен.
 */
interface PackagePolicy {
  readonly workspace: readonly string[];
  /** Есть только у пакетов канонического ядра; отсутствие означает «не ядро». */
  readonly external?: CorePackagePolicy;
}

const CORE_EXTERNAL: CorePackagePolicy = { runtime: [], development: CORE_TEST_TOOLING };

const PACKAGES: Record<string, PackagePolicy> = {
  '@zona/contracts': {
    workspace: [],
    external: { runtime: ['@sinclair/typebox'], development: CORE_TEST_TOOLING },
  },
  '@zona/domain': { workspace: ['@zona/contracts'], external: CORE_EXTERNAL },
  '@zona/simulation': {
    workspace: ['@zona/contracts', '@zona/domain'],
    external: CORE_EXTERNAL,
  },
  '@zona/content': { workspace: [], external: CORE_EXTERNAL },

  '@zona/persistence': { workspace: ['@zona/contracts', '@zona/domain'] },
  // I03: `@zona/persistence` УБРАН из разрешённых, а не просто не используется. От проекций
  // зависит `apps/api`, а запрет observer-пути на канонические таблицы транзитивен
  // (`observer-api-does-not-reach-persistence`): объявленная зависимость была бы приглашением
  // однажды ею воспользоваться и молча снять запрет для всего API. `@zona/domain` убран по той
  // же причине — проекция сворачивает записанные факты, доменные правила ей не нужны.
  '@zona/projections': { workspace: ['@zona/contracts'] },
  '@zona/representation': { workspace: ['@zona/contracts', '@zona/projections'] },
  '@zona/testkit': { workspace: ['@zona/contracts', '@zona/domain'] },
  '@zona/api': { workspace: ['@zona/contracts', '@zona/projections'] },
  '@zona/worker': {
    workspace: [
      '@zona/contracts',
      '@zona/domain',
      '@zona/simulation',
      '@zona/persistence',
      '@zona/projections',
      '@zona/representation',
      // I03: worker собирает observer projection и потому обязан знать, из какого контента
      // построены bundles генезисного снимка — иначе он не сможет его прочитать.
      '@zona/content',
    ],
  },
  '@zona/cli': {
    workspace: [
      '@zona/contracts',
      '@zona/domain',
      '@zona/simulation',
      '@zona/persistence',
      '@zona/projections',
      '@zona/content',
    ],
  },
  '@zona/agent-harness': { workspace: [] },
  '@zona/security-scan': { workspace: [] },
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
    const policy = PACKAGES[name];
    if (policy === undefined) {
      violations.push(
        `${name}: пакет не описан в матрице ADR-002 (scripts/boundaries/check-workspace-graph.ts)`,
      );
      continue;
    }

    const runtimeDeps = Object.keys(manifest.dependencies ?? {});
    const developmentDeps = Object.keys(manifest.devDependencies ?? {});

    for (const dependency of [...runtimeDeps, ...developmentDeps]) {
      if (!dependency.startsWith('@zona/')) continue;
      if (!policy.workspace.includes(dependency)) {
        violations.push(`${name} -> ${dependency}: запрещённая зависимость по ADR-002`);
      }
    }

    if (policy.external === undefined) continue;

    // Поставка и тестовый инструментарий проверяются РАЗДЕЛЬНО: ADR-003 ограничивает то, с чем
    // ядро поставляется, а не то, чем оно тестируется (N-5).
    const checks: readonly (readonly [string, readonly string[], readonly string[]])[] = [
      ['dependencies', runtimeDeps, policy.external.runtime],
      ['devDependencies', developmentDeps, policy.external.development],
    ];
    for (const [section, declared, allowlist] of checks) {
      for (const dependency of declared) {
        if (dependency.startsWith('@zona/')) continue;
        if (allowlist.includes(dependency)) continue;
        violations.push(
          `${name} -> ${dependency} (${section}): каноническому ядру разрешены только ` +
            `[${allowlist.join(', ') || 'ни одной'}] (ADR-003, ` +
            'scripts/boundaries/check-workspace-graph.ts)',
        );
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
