/**
 * I01 ACCEPTANCE A1 + A2 (`docs/iterations/I01-deterministic-domain-core/ACCEPTANCE.md`).
 *
 * A1 is the main criterion of the iteration: same seed, byte-identical canonical world, across
 * 100 separate OS processes — not 100 loop iterations. The document is explicit about why:
 * "одинаковый результат внутри одного процесса не исключает зависимости от порядка
 * инициализации модулей или от накопленного состояния." A2 exists so A1 cannot be satisfied by
 * a constant: "always return an empty object" passes 100-processes-agree trivially, but fails
 * "different seed gives a different world."
 *
 * Both are RED right now, on purpose: `packages/domain`, `packages/simulation` and
 * `packages/content` are all still empty stubs (I01-T3/T4), and `apps/cli`'s `world seed` is
 * registered but `status: 'planned'` with no argument parsing for `--seed` (I00 skeleton). See
 * the handoff for the exact failure this test currently observes.
 */
import { decodeSnapshot, isValidationFailure } from '@zona/contracts';
import { describe, expect, it } from 'vitest';
import { spawnWorldCliDirect } from '../support/spawn-world-cli.ts';

/**
 * "не должно быть ниже 100 в gate без решения lead-а" (CLAUDE.md; ACCEPTANCE "Что НЕ является
 * приёмкой"). Overridable for local iteration speed, but the override is refused below 100 so
 * a quick local run can never silently become the number that ships.
 */
const DEFAULT_RUN_COUNT = 100;
const RUN_COUNT = Number(process.env['ZONA_A1_RUN_COUNT'] ?? DEFAULT_RUN_COUNT);

if (!Number.isInteger(RUN_COUNT) || RUN_COUNT < 100) {
  throw new Error(
    `ZONA_A1_RUN_COUNT=${String(process.env['ZONA_A1_RUN_COUNT'])} — A1 и CLAUDE.md запрещают ` +
      'снижать число прогонов ниже 100 без отдельного решения lead-а; это не gate-параметр ' +
      'для удобства локального запуска.',
  );
}

function seedWorldProcess(seed: number) {
  return spawnWorldCliDirect(['world', 'seed', '--seed', String(seed)]);
}

/**
 * GO-критерий I01 в `10_ITERATION_MASTER_PLAN` требует «100 повторов на **нескольких** seed»,
 * тогда как A1 в `ACCEPTANCE.md` называет один фиксированный seed. Прогон ведётся по всем
 * перечисленным здесь seed: строже из двух документов — мастер-план.
 *
 * Разные по характеру: степень двойки, соседнее нечётное, ноль (граница), большое значение.
 * Один seed не отличил бы детерминизм от совпадения на удачном входе.
 */
const DETERMINISM_SEEDS = [42, 43, 0, 987654321] as const;

describe('I01 A1 — same seed, byte-identical world across 100 separate OS processes', () => {
  it.each(DETERMINISM_SEEDS)(
    `produces identical canonical JSON and checksum across ${RUN_COUNT} process spawns (seed=%i)`,
    { timeout: Math.max(120_000, RUN_COUNT * 2_000) },
    (seed: number) => {
      const outputs: string[] = [];

      for (let run = 0; run < RUN_COUNT; run += 1) {
        const result = seedWorldProcess(seed);
        expect(
          result.exitCode,
          `запуск #${run}: ожидался exit 0 от "world seed --seed ${seed}", ` +
            `получено exit=${String(result.exitCode)} signal=${String(result.signal)} ` +
            `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
        ).toBe(0);
        outputs.push(result.stdout.trim());
      }

      const first = outputs[0]!;
      outputs.forEach((output, index) => {
        expect(output, `прогон #${index} разошёлся с прогоном #0 — детерминизм нарушен`).toBe(
          first,
        );
      });

      // A1 требует совпадения canonical JSON И checksum, а не просто идентичного текста stdout.
      // Snapshot несёт checksum как собственное поле (`SnapshotSchema`, A9), поэтому декодирование
      // и проверка схемы здесь — это и есть проверка checksum, а не отдельный шаг.
      const parsed: unknown = JSON.parse(first);
      const decoded = decodeSnapshot(parsed);
      expect(
        isValidationFailure(decoded),
        `вывод "world seed" не прошёл decodeSnapshot: ${JSON.stringify(decoded)}`,
      ).toBe(false);
    },
  );
});

describe('I01 A2 — different seed produces a different, schema-valid world', () => {
  it('gives different checksums for seed=42 and seed=43, both passing runtime validation', () => {
    const first = seedWorldProcess(42);
    const second = seedWorldProcess(43);

    expect(first.exitCode, `seed=42: stderr=${JSON.stringify(first.stderr)}`).toBe(0);
    expect(second.exitCode, `seed=43: stderr=${JSON.stringify(second.stderr)}`).toBe(0);

    const firstOutput = first.stdout.trim();
    const secondOutput = second.stdout.trim();

    // Существует ровно для того, чтобы A1 нельзя было пройти константой (ACCEPTANCE A2).
    expect(firstOutput).not.toBe(secondOutput);

    for (const output of [firstOutput, secondOutput]) {
      const decoded = decodeSnapshot(JSON.parse(output));
      expect(isValidationFailure(decoded), `невалидный snapshot: ${JSON.stringify(decoded)}`).toBe(
        false,
      );
    }
  });
});
