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

/**
 * I03: фикстуры на СУЖЕНИЕ правила `hardcoded-network-url`.
 *
 * Сужение (петлевые адреса и документационные имена под `.example` — не находка) без фикстур
 * было бы просто ослаблением: ADR-003 — «правило без фикстуры считается несуществующим», и это
 * в равной мере относится к границам правила. Ниже обе стороны: что перестало ловиться и что
 * обязано ловиться по-прежнему.
 */
export const LOOPBACK_URL_SAMPLES = [
  `const a = "${['htt', 'p'].join('')}://localhost:3100";`,
  `const b = \`${['htt', 'p'].join('')}://localhost:\${String(port)}/health\`;`,
  `const c = "${['htt', 'p'].join('')}://127.0.0.1:5432";`,
  `const d = "${['htt', 'p'].join('')}://[::1]:3000/v1";`,
].join('\n');

/** Документационные имена RFC 2606 под `.example` — существовать не могут, каналом не являются. */
export const DOC_DOMAIN_URL_SAMPLES = [
  `const e = "${['htt', 'ps'].join('')}://ok.example,*";`,
  `const f = "${['htt', 'ps'].join('')}://example.com/x";`,
].join('\n');

/**
 * Обход сужения: чужой хост, ЗАКАНЧИВАЮЩИЙСЯ петлевым или документационным именем внутри себя.
 * Ровно то, что сужение по подстроке пропустило бы, — и ровно то, ради чего оно сделано
 * привязанным к концу адреса.
 */
export const LOOPBACK_LOOKALIKE_URL_SAMPLES = [
  `const g = "${['htt', 'p'].join('')}://localhost.evil.test/collect";`,
  `const h = "${['htt', 'ps'].join('')}://example.com.evil.test/x";`,
].join('\n');

export const CLEAN_STATIC_SAMPLE = [
  "import { execFileSync } from 'node:child_process';",
  "execFileSync('git', ['ls-files'], { encoding: 'utf8' });",
].join('\n');
