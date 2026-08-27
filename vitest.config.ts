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
          /**
           * Тесты этого проекта ПОРОЖДАЮТ НАСТОЯЩИЕ ПРОЦЕССЫ: hook-скрипты запускаются так же,
           * как их запускает платформа, — иначе проверялась бы функция, а не контроль. Плюс
           * `boundary-fixtures` держит внутри себя полный прогон eslint и depcruise.
           *
           * Пять секунд по умолчанию перестало хватать в I03, когда фикстур стало больше (m11):
           * в полном gate пять тестов упали по таймауту, а изолированно те же 27 проходят.
           * Причина не в них — в конкуренции за процессор внутри одного проекта.
           *
           * Тридцать секунд — не «пусть уж как-нибудь пройдёт»: это признание реальной цены
           * порождения процесса под нагрузкой. Ослабления проверки здесь нет, ни один assert не
           * тронут; тест, падающий по таймауту вместо своей причины, доказывает не больше, чем
           * не запущенный.
           */
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'property',
          include: ['{apps,packages,tools}/*/src/**/*.property.test.ts'],
          exclude: COMMON_EXCLUDE,
          environment: 'node',
          /**
           * Property-тесты по природе длительны: `fc.assert` прогоняет сотни случаев, а поиск
           * сдвига среди тысяч потоков PRNG (A7) — тысячи. Пять секунд по умолчанию оказались
           * впритык: в полном gate I03 два теста упали по таймауту, потратив 13.9 и 6.5 секунды
           * фактической работы.
           *
           * Число прогонов НЕ снижено — это запрещено прямо (`CLAUDE.md`, обязательный рабочий
           * цикл), и запрещено по делу: property-тест с уменьшенным числом случаев перестаёт быть
           * тем тестом, который принимали. Поднят таймаут — он описывает стоимость, а не строгость.
           */
          testTimeout: 60_000,
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
          // Acceptance-набор итерации. Отдельный проект, а не часть `unit`: он порождает
          // настоящие процессы (A1 — 100 запусков CLI), поэтому не должен идти в быстром
          // цикле Red/Green. Намеренно НЕ входит в `pnpm verify` — см. `test:acceptance`.
          name: 'acceptance',
          include: ['tests/acceptance/**/*.test.ts'],
          exclude: COMMON_EXCLUDE,
          environment: 'node',
          testTimeout: 300_000,
          hookTimeout: 300_000,
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
