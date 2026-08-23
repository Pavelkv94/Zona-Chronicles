/**
 * apps/web — единственное место, читающее окружение (тот же контракт, что у api/cli/worker).
 *
 * Особенность браузерного слоя: значение подставляется СБОРКОЙ (`next.config.ts` кладёт его в
 * `env`), а не читается в рантайме браузером — у страницы нет доступа к окружению процесса.
 * Правило `apps/*` из `eslint.config.mjs` от этого не смягчается: allowlist и валидация обязаны
 * быть, иначе «переменная, которую забыли задать» превращается в экран, молча стучащийся не туда.
 *
 * Allowlist исчерпывающий: `ZONA_API_BASE_URL`. Ни строк подключения, ни секретов здесь быть не
 * может по построению — экран ходит только в публичный read-only API.
 */

const DEFAULT_API_BASE_URL = 'http://localhost:3001';

export function parseWebConfig(env: Record<string, string | undefined>): {
  readonly apiBaseUrl: string;
} {
  const raw = env['ZONA_API_BASE_URL'];
  if (raw === undefined || raw.trim().length === 0) {
    return { apiBaseUrl: DEFAULT_API_BASE_URL };
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('схема');
    }
  } catch {
    throw new Error(
      `Invalid config: ZONA_API_BASE_URL должен быть http(s)-адресом, получено ${JSON.stringify(raw)}.`,
    );
  }
  return { apiBaseUrl: raw.replace(/\/+$/, '') };
}

/** Адрес observer API. Значение подставлено сборкой; см. `next.config.ts`. */
export const API_BASE_URL = parseWebConfig(process.env).apiBaseUrl;
