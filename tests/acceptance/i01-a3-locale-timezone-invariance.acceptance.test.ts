/**
 * I01 ACCEPTANCE A3 (`docs/iterations/I01-deterministic-domain-core/ACCEPTANCE.md`) — locale and
 * timezone must not affect the canonical world.
 *
 * `TZ=Pacific/Chatham LC_ALL=tr_TR.UTF-8` is not an arbitrary choice:
 *
 * - Turkish breaks ASCII case folding (`I`/`ı`, `i`/`İ`) — a `toLowerCase`/`localeCompare` that
 *   snuck past lint (`no-restricted-syntax` forbids `.toLocaleLowerCase`/`localeCompare` etc. in
 *   `packages/domain`/`packages/simulation`, but a plain `.toLowerCase()` used for *comparison*
 *   is not itself forbidden, and V8's `Intl`-backed default locale genuinely does shift under
 *   `LC_ALL` — confirmed directly on this host: `Intl.DateTimeFormat().resolvedOptions().locale`
 *   is `"tr-TR"` under this env, `"en-US"`-ish otherwise).
 * - `Pacific/Chatham` is UTC+12:45 — a non-round number of minutes. Arithmetic that silently
 *   assumes whole-hour offsets (a fairly natural bug when hand-rolling offset math, which this
 *   codebase does deliberately in `instant.ts` to avoid `Date.*`) breaks exactly here.
 *
 * The contract-steward (I01-T1) proved structural TZ/locale-independence of `packages/contracts`
 * on paper: `packages/contracts` cannot itself run this check because `node:child_process` is
 * banned there (ADR-002/003 — leaf packages don't spawn processes). This file is what actually
 * exercises that claim end-to-end, once `apps/cli`/`packages/domain` exist to have a claim about.
 *
 * Not covered here, and not coverable from a CLI black box: "объекts состояния строятся с
 * разным порядком вставки ключей" — the CLI does not expose a way to control internal object
 * construction order. That half of A3 is proven at the `canonicalize()` level already, by
 * `packages/contracts/src/canonical-json.property.test.ts` ("результат не зависит от порядка
 * вставки ключей"), which is green today. See the handoff for why this is not a gap I am
 * silently leaving — it is a scope boundary of what a process-level acceptance test can observe.
 */
import { describe, expect, it } from 'vitest';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';

const SEED = 42;

const BASELINE_ENV = { TZ: 'UTC', LC_ALL: 'C' };
const TURKISH_CHATHAM_ENV = { TZ: 'Pacific/Chatham', LC_ALL: 'tr_TR.UTF-8' };

function seedWorldUnder(env: Readonly<Record<string, string>>) {
  return spawnWorldCliDirect(['world', 'seed', '--seed', String(SEED)], { env });
}

describe('I01 A3 — locale and timezone do not affect the canonical world', () => {
  it('gives byte-identical canonical JSON under TZ=UTC/LC_ALL=C and TZ=Pacific/Chatham/LC_ALL=tr_TR.UTF-8', () => {
    const baseline = seedWorldUnder(BASELINE_ENV);
    const turkishChatham = seedWorldUnder(TURKISH_CHATHAM_ENV);

    expect(
      baseline.exitCode,
      `baseline (TZ=UTC LC_ALL=C): exit=${String(baseline.exitCode)} ` +
        `stderr=${JSON.stringify(baseline.stderr)}`,
    ).toBe(0);
    expect(
      turkishChatham.exitCode,
      `TZ=Pacific/Chatham LC_ALL=tr_TR.UTF-8: exit=${String(turkishChatham.exitCode)} ` +
        `stderr=${JSON.stringify(turkishChatham.stderr)}`,
    ).toBe(0);

    expect(turkishChatham.stdout.trim()).toBe(baseline.stdout.trim());
  });
});
