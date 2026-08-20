import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromRoot = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** Тесты читают исходники пакетов напрямую: gate не должен зависеть от предварительного build. */
const alias = {
  '@zona/contracts': fromRoot('./packages/contracts/src/index.ts'),
  '@zona/domain': fromRoot('./packages/domain/src/index.ts'),
  '@zona/simulation': fromRoot('./packages/simulation/src/index.ts'),
  '@zona/persistence': fromRoot('./packages/persistence/src/index.ts'),
  '@zona/projections': fromRoot('./packages/projections/src/index.ts'),
  '@zona/representation': fromRoot('./packages/representation/src/index.ts'),
  '@zona/content': fromRoot('./packages/content/src/index.ts'),
  '@zona/testkit': fromRoot('./packages/testkit/src/index.ts'),
};

const COMMON_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/.turbo/**'];
const SPECIALIZED = ['**/*.property.test.ts', '**/*.integration.test.ts', '**/*.contract.test.ts'];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['{apps,packages,tools}/*/src/**/*.test.ts'],
          exclude: [...COMMON_EXCLUDE, ...SPECIALIZED, 'tools/agent-harness/**'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'hooks',
          include: ['tools/agent-harness/src/**/*.test.ts'],
          exclude: COMMON_EXCLUDE,
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'property',
          include: ['{apps,packages,tools}/*/src/**/*.property.test.ts'],
          exclude: COMMON_EXCLUDE,
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'contract',
          include: [
            '{apps,packages,tools}/*/src/**/*.contract.test.ts',
            'tests/contract/**/*.test.ts',
          ],
          exclude: COMMON_EXCLUDE,
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: [
            '{apps,packages}/*/src/**/*.integration.test.ts',
            'tests/integration/**/*.test.ts',
          ],
          exclude: COMMON_EXCLUDE,
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'replay',
          include: ['tests/replay/**/*.test.ts'],
          exclude: COMMON_EXCLUDE,
          environment: 'node',
          testTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
