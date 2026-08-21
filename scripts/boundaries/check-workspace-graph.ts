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
  ],
  '@zona/agent-harness': [],
  '@zona/security-scan': [],
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
  }
}

if (violations.length > 0) {
  console.error('Нарушения границ пакетов:');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log('workspace graph: границы ADR-002 соблюдены');
