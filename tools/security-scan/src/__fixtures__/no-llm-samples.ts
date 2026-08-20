/**
 * Тестовые фикстуры для `scan-no-llm.test.ts` (NAR-02, ADR-006).
 *
 * Имена пакетов/переменных собираются конкатенацией по той же причине, что и в
 * `secret-samples.ts`/`static-samples.ts`: избежать буквального совпадения с
 * собственным содержимым `scan-no-llm.ts` при будущем git-tracked скане.
 */

const OPENAI_PKG = ['open', 'ai'].join('');
export const IMPORT_STATEMENT_SAMPLE = `import OpenAI from '${OPENAI_PKG}';`;
export const REQUIRE_CALL_SAMPLE = `const client = require('${OPENAI_PKG}');`;

const ANTHROPIC_SCOPE = ['@anthropic', '-ai/sdk'].join('');
export const LOCKFILE_LINE_SAMPLE = `  ${ANTHROPIC_SCOPE}@0.30.0:\n    resolution: {integrity: sha512-fake}\n`;

export const PACKAGE_JSON_SAMPLE = JSON.stringify({
  name: '@zona/example',
  devDependencies: { [OPENAI_PKG]: '^4.0.0' },
});

export const PROMPTS_DIR_PATH_SAMPLE = 'apps/worker/src/prompts/system.txt';
export const EMBEDDINGS_DIR_PATH_SAMPLE = 'packages/content/embeddings/index.ts';

const ENV_VAR_NAME = ['OPEN', 'AI_API_KEY'].join('');
export const ENV_VAR_USAGE_SAMPLE = `const key = process.env.${ENV_VAR_NAME};`;
export const ENV_VAR_DOTENV_SAMPLE = `${ENV_VAR_NAME}=sk-fake-example-value`;

export const CLEAN_IMPORT_SAMPLE = "import { readFileSync } from 'node:fs';";
