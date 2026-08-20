import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLEAN_IMPORT_SAMPLE,
  EMBEDDINGS_DIR_PATH_SAMPLE,
  ENV_VAR_DOTENV_SAMPLE,
  ENV_VAR_USAGE_SAMPLE,
  IMPORT_STATEMENT_SAMPLE,
  LOCKFILE_LINE_SAMPLE,
  PACKAGE_JSON_SAMPLE,
  PROMPTS_DIR_PATH_SAMPLE,
  REQUIRE_CALL_SAMPLE,
} from './__fixtures__/no-llm-samples.ts';
import { findLlmFindings } from './scan-no-llm.ts';
import { parsePolicy } from './policy.ts';
import type { SecurityPolicy } from './policy.ts';

const loadRealPolicy = (): SecurityPolicy => {
  const raw = readFileSync(new URL('../../../security/policy.json', import.meta.url), 'utf8');
  const result = parsePolicy(raw);
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.policy;
};

const policy = loadRealPolicy();

const emptyInput = {
  lockfileContent: '',
  packageJsonFiles: [],
  sourceFiles: [],
  trackedPaths: [],
  trackedFilesForEnv: [],
};

describe('findLlmFindings', () => {
  it('flags a denied package imported from source (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        sourceFiles: [{ path: 'apps/worker/src/x.ts', content: IMPORT_STATEMENT_SAMPLE }],
      },
      policy,
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags a denied package required via require() (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        sourceFiles: [{ path: 'apps/worker/src/x.ts', content: REQUIRE_CALL_SAMPLE }],
      },
      policy,
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags a denied scoped package present in pnpm-lock.yaml (positive)', () => {
    const findings = findLlmFindings(
      { ...emptyInput, lockfileContent: LOCKFILE_LINE_SAMPLE },
      policy,
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags a denied package declared in package.json devDependencies (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        packageJsonFiles: [{ path: 'apps/worker/package.json', content: PACKAGE_JSON_SAMPLE }],
      },
      policy,
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('flags a tracked path under a prompts/ directory (positive)', () => {
    const findings = findLlmFindings(
      { ...emptyInput, trackedPaths: [PROMPTS_DIR_PATH_SAMPLE] },
      policy,
    );
    expect(findings.some((f) => f.id === 'llm-directory')).toBe(true);
  });

  it('flags a tracked path under an embeddings/ directory (positive)', () => {
    const findings = findLlmFindings(
      { ...emptyInput, trackedPaths: [EMBEDDINGS_DIR_PATH_SAMPLE] },
      policy,
    );
    expect(findings.some((f) => f.id === 'llm-directory')).toBe(true);
  });

  it('flags a provider API key read from process.env (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        trackedFilesForEnv: [{ path: 'apps/worker/src/x.ts', content: ENV_VAR_USAGE_SAMPLE }],
      },
      policy,
    );
    expect(findings.some((f) => f.id === 'llm-env-var')).toBe(true);
  });

  it('flags a provider API key set in a dotenv-style assignment (positive)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        trackedFilesForEnv: [{ path: '.env.local', content: ENV_VAR_DOTENV_SAMPLE }],
      },
      policy,
    );
    expect(findings.some((f) => f.id === 'llm-env-var')).toBe(true);
  });

  it('finds nothing for clean, unrelated input (negative)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        sourceFiles: [{ path: 'apps/worker/src/x.ts', content: CLEAN_IMPORT_SAMPLE }],
      },
      policy,
    );
    expect(findings).toEqual([]);
  });

  it('skips source files matching llm_policy.allowlisted_paths (negative: allowlist)', () => {
    const findings = findLlmFindings(
      {
        ...emptyInput,
        sourceFiles: [
          {
            path: 'tools/security-scan/src/__fixtures__/no-llm-samples.ts',
            content: IMPORT_STATEMENT_SAMPLE,
          },
        ],
      },
      policy,
    );
    expect(findings).toEqual([]);
  });
});
