/**
 * Тестовые фикстуры для `scan-static.test.ts` (OPS-03).
 *
 * Как и в `secret-samples.ts`, опасные подстроки собираются конкатенацией —
 * `scan-static.ts` сканирует git-tracked `apps/**`, `packages/**`, `tools/**`,
 * и этот файл сам лежит под `tools/**`.
 */

const EVAL_WORD = ['ev', 'al'].join('');
export const EVAL_CALL_SAMPLE = `const result = ${EVAL_WORD}("2 + 2");`;

const FUNCTION_WORD = ['Funct', 'ion'].join('');
export const NEW_FUNCTION_SAMPLE = `const fn = new ${FUNCTION_WORD}("return 1");`;

const EXEC_WORD = ['exec', 'Sync'].join('');
export const CHILD_PROCESS_TEMPLATE_SAMPLE = `${EXEC_WORD}(\`rm -rf \${userInput}\`);`;

const SCHEME = ['htt', 'ps'].join('');
export const HARDCODED_URL_SAMPLE = `const endpoint = "${SCHEME}://example.invalid/api";`;

export const CLEAN_STATIC_SAMPLE = [
  "import { execFileSync } from 'node:child_process';",
  "execFileSync('git', ['ls-files'], { encoding: 'utf8' });",
].join('\n');
