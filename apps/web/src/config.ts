/**
 * apps/web — единственное место, читающее окружение (тот же контракт, что у api/cli/worker).
 *
 * Значение читается НА СЕРВЕРЕ ПРИ ЗАПРОСЕ и приходит в компонент свойством (`page.tsx`,
 * `force-dynamic`). У страницы в браузере доступа к окружению процесса нет вовсе.
 *
 * Прежняя редакция этого докстринга описывала другой механизм — подстановку сборкой через `env`
 * в `next.config.ts`, — и описывала его уже после того, как он был отменён в этой же итерации.
 * Отменён по делу: Next кладёт такие значения в браузерный бандл НА СБОРКЕ, поэтому собранный
 * экран нельзя направить на другой API. Найдено живым прогоном E2E: сценарий поднимал API на
 * своём порту, а страница стучалась на порт, зашитый при сборке. Докстринг, переживший
 * собственный механизм, — это указатель, ведущий не туда (m3 независимого аудита I03).
 *
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
