import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A11 — детерминизм самой цепочки `command → events → state` в разных процессах.
 *
 * Введён по finding m7 верификации I01. A1 гоняет 100 процессов по пути CLI, но CLI строит
 * состояние напрямую из контента и не вызывает `decide`/`evolve` вовсе. Формально A1 выполнялся,
 * а **главная гипотеза итерации** (§1 плана) оставалась доказанной только внутрипроцессно — то
 * есть способом, который сам `ACCEPTANCE` в разделе «Что НЕ является приёмкой» называет
 * недостаточным.
 *
 * Здесь прогоняется именно ядро: `decide` порождает события, `evolve` их применяет, результат
 * канонизируется и хешируется. Разные процессы обязательны по той же причине, что в A1:
 * одинаковый результат внутри одного процесса не исключает зависимости от порядка инициализации
 * модулей или накопленного состояния.
 */
const CHAIN_SCRIPT = fileURLToPath(new URL('./support/decide-evolve-chain.ts', import.meta.url));

const DEFAULT_RUN_COUNT = 100;
const RUN_COUNT = Number(process.env['ZONA_A11_RUN_COUNT'] ?? DEFAULT_RUN_COUNT);
if (!Number.isInteger(RUN_COUNT) || RUN_COUNT < DEFAULT_RUN_COUNT) {
  throw new Error(
    `ZONA_A11_RUN_COUNT=${String(process.env['ZONA_A11_RUN_COUNT'])} — снижение числа прогонов ` +
      `ниже ${DEFAULT_RUN_COUNT} запрещено CLAUDE.md наравне с ослаблением assertions.`,
  );
}

const SEEDS = [42, 43, 0, 987654321] as const;

function runChain(seed: number): { readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [CHAIN_SCRIPT, '--seed', String(seed)], {
    encoding: 'utf8',
    // Пустое окружение: цепочка не имеет права зависеть ни от одной переменной.
    env: { PATH: process.env['PATH'] ?? '' },
  });
  expect(
    result.status,
    `seed=${seed}: ожидался exit 0, получено ${String(result.status)}; stderr=${result.stderr}`,
  ).toBe(0);
  return { stdout: result.stdout.trim(), stderr: result.stderr };
}

describe('I01 A11 — цепочка command → events → state детерминирована между процессами', () => {
  it.each(SEEDS)(
    `даёт одинаковый результат в ${RUN_COUNT} отдельных процессах (seed=%i)`,
    { timeout: Math.max(120_000, RUN_COUNT * 2_000) },
    (seed: number) => {
      const first = runChain(seed).stdout;
      expect(first, `seed=${seed}: цепочка не напечатала результат`).not.toBe('');

      for (let run = 1; run < RUN_COUNT; run += 1) {
        expect(runChain(seed).stdout, `seed=${seed}, прогон #${run} разошёлся с #0`).toBe(first);
      }
    },
  );

  it('разный seed даёт другой результат — иначе A11 проходился бы константой', () => {
    const outputs = SEEDS.map((seed) => runChain(seed).stdout);
    expect(new Set(outputs).size, `результаты по seed ${SEEDS.join(', ')} совпали`).toBe(
      SEEDS.length,
    );
  });

  it('locale и timezone не влияют на результат цепочки', () => {
    const base = runChain(42).stdout;
    const exotic = spawnSync(process.execPath, [CHAIN_SCRIPT, '--seed', '42'], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        TZ: 'Pacific/Chatham',
        LC_ALL: 'tr_TR.UTF-8',
        LANG: 'tr_TR.UTF-8',
      },
    });
    expect(exotic.status, `exotic locale: stderr=${exotic.stderr}`).toBe(0);
    expect(exotic.stdout.trim(), 'TZ/locale изменили результат цепочки').toBe(base);
  });
});
