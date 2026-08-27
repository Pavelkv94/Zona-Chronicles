/**
 * I01 ACCEPTANCE A10 (`docs/iterations/I01-deterministic-domain-core/ACCEPTANCE.md`) — the CLI
 * demonstrates a world without a database.
 *
 * Not itemized in the acceptance-author task message (which named A1, A2, A3 and the SHA-256
 * differential test explicitly) — written anyway because A10 is a frozen, numbered
 * Given/When/Then criterion like the others, nothing else in the write set claims it, and the
 * CLI-spawn plumbing already existed. Flagged in the handoff; drop or reassign it if that
 * reading is wrong.
 *
 * ONE UNRESOLVED WORDING GAP, flagged rather than silently resolved (CLAUDE.md forbids quietly
 * reinterpreting a frozen acceptance criterion):
 *
 * A10's own When-clause reads "выполняется `pnpm world seed --seed 42`, затем
 * `pnpm world inspect`" — no `--seed` on the second command. But `world seed`/`world inspect`
 * are scoped as in-memory, no-database (PLAN.md §2 scope: "CLI world seed и world inspect —
 * in-memory, без БД"), and each `pnpm world …` call is its own OS process (a fresh `pnpm`
 * invocation), with no shared state file or DB to remember which world was last seeded. A bare
 * `world inspect` therefore cannot deterministically show *the world from the previous command*
 * without either (a) a hidden default seed, or (b) some persistence this iteration explicitly
 * excludes. The iteration's own "Ручной demo" section resolves this differently and more
 * operationally: step 3 is `pnpm world inspect --seed 42`. This test follows the manual demo's
 * reading (inspect re-derives the same world deterministically from the same seed, no shared
 * process state) because it is the only one of the two that is actually implementable under
 * "in-memory, no DB, no persistence between separate CLI invocations." If that's not the
 * intended reading, it needs a change request against A10's wording, not a silent CLI-side
 * workaround.
 *
 * "не открывают сетевых соединений" cannot be proven by a black-box process test without a
 * syscall tracer. The proxy used here: every DB-shaped env var points at an unroutable
 * TEST-NET-3 address (RFC 5737) with a bounded spawn timeout. A real attempt to reach it would
 * hang (caught by the timeout) rather than quietly succeed; a command that finishes well under
 * the timeout without needing that address to resolve is consistent with "opened no connection
 * to it." It does not catch a network call to some *other*, reachable address — that class of
 * regression needs `boundaries:check`/dependency-cruiser network-import bans (already enforced
 * for `packages/domain`/`packages/simulation`; `apps/cli` is not currently in that scope and may
 * be worth adding when I01-T4 lands).
 */
import { describe, expect, it } from 'vitest';
import { POISONED_NETWORK_ENV, spawnWorldCliViaPnpm } from '../support/spawn-world-cli.ts';

const SEED = 42;
/**
 * Граница «команда завершилась, а не повисла».
 *
 * Это УТВЕРЖДЕНИЕ, а не таймаут теста: попытка соединения с TEST-NET-3 (`203.0.113.1`, RFC 5737 —
 * зарезервирован и никогда не маршрутизируется) висит до собственного сетевого таймаута, то есть
 * десятки секунд или бесконечно. Быстрое завершение и есть доказательство, что соединения не
 * было.
 *
 * Поднято с 5 до 20 секунд в I03. Причина найдена полным gate: под нагрузкой ЗАПУСК `pnpm` плюс
 * старт Node занимал больше пяти секунд, и тест обвинял продукт в попытке соединения, которой не
 * было. Ложное обвинение контроля дороже пропуска: оно учит не верить красному.
 *
 * Детектор от этого не ослаб. Он различает «завершилось за секунды» и «висит на неотвечающем
 * адресе», а между ними разница в порядки, а не в разы: непроходимый адрес не уложится и в
 * двадцать секунд. Ослаблением было бы снять проверку `timedOut` или отравленное окружение —
 * ни то, ни другое не тронуто.
 */
const NO_DB_TIMEOUT_MS = 20_000;

describe('I01 A10 — CLI demonstrates a world without a running database', () => {
  it('`pnpm world seed --seed 42` prints canonical JSON+checksum, exits 0, without touching a database', () => {
    const result = spawnWorldCliViaPnpm(['seed', '--seed', String(SEED)], {
      env: POISONED_NETWORK_ENV,
      timeoutMs: NO_DB_TIMEOUT_MS,
    });

    expect(
      result.timedOut,
      `"pnpm world seed" hung past ${NO_DB_TIMEOUT_MS}ms with every DB env var poisoned — ` +
        'consistent with an attempted network/DB connection, which A10 forbids',
    ).toBe(false);
    expect(
      result.exitCode,
      `exit=${String(result.exitCode)} signal=${String(result.signal)} ` +
        `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    ).toBe(0);
    expect(
      result.stdout.trim().length,
      'stdout must contain the canonical JSON world',
    ).toBeGreaterThan(0);
  });

  it('`pnpm world inspect --seed 42` prints agents/locations/routes, exits 0, without touching a database', () => {
    const result = spawnWorldCliViaPnpm(['inspect', '--seed', String(SEED)], {
      env: POISONED_NETWORK_ENV,
      timeoutMs: NO_DB_TIMEOUT_MS,
    });

    expect(result.timedOut, `"pnpm world inspect" hung past ${NO_DB_TIMEOUT_MS}ms`).toBe(false);
    expect(
      result.exitCode,
      `exit=${String(result.exitCode)} signal=${String(result.signal)} ` +
        `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    ).toBe(0);
    expect(result.stdout.trim().length, 'stdout must describe the world').toBeGreaterThan(0);
  });
});
