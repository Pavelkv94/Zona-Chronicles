/**
 * Минимальный детерминированный glob-матчер для security policy (OPS-03).
 *
 * Собственная, независимая от `tools/agent-harness` реализация: `@zona/security-scan`
 * не имеет разрешённых internal-зависимостей в матрице ADR-002
 * (`scripts/boundaries/check-workspace-graph.ts`), поэтому переиспользование чужого
 * модуля означало бы недекларируемую связь. Семантика — подмножество, достаточное
 * для allowlist/exception путей: `**` — любое число сегментов, `*` — символы внутри
 * одного сегмента.
 */
const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

const toRegexSource = (pattern: string): string => {
  let source = '';
  let index = 0;

  while (index < pattern.length) {
    const rest = pattern.slice(index);

    if (rest.startsWith('**/')) {
      source += '(?:[^/]+/)*';
      index += 3;
      continue;
    }
    if (rest.startsWith('**')) {
      source += '.*';
      index += 2;
      continue;
    }
    const character = pattern[index] as string;
    if (character === '*') {
      source += '[^/]*';
    } else {
      source += character.replace(REGEX_SPECIALS, '\\$&');
    }
    index += 1;
  }
  return source;
};

/** Приводит путь к сравнимому виду: прямые слэши, без ведущего `./`. */
export const normalizePath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^\.\//, '');

/** Проверяет соответствие пути одному glob-паттерну. */
export const matchesGlob = (path: string, pattern: string): boolean => {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);

  if (normalizedPattern.endsWith('/**')) {
    const directory = normalizedPattern.slice(0, -3);
    if (normalizedPath === directory) return true;
  }
  return new RegExp(`^${toRegexSource(normalizedPattern)}$`).test(normalizedPath);
};

/** Проверяет соответствие пути хотя бы одному паттерну списка. */
export const matchesAnyGlob = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => matchesGlob(path, pattern));
