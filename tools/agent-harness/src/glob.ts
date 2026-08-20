/**
 * Минимальный детерминированный glob-матчер для путей репозитория.
 *
 * Собственная реализация выбрана сознательно: контроль границ не должен зависеть
 * от поведения внешней библиотеки, а его семантика обязана быть покрыта тестами.
 *
 * Поддерживается:
 *   `**`  — любое количество сегментов пути, включая ноль;
 *   `*`   — любые символы внутри одного сегмента;
 *   `?`   — один символ внутри сегмента.
 *
 * Паттерн вида `dir/**` совпадает и с самим `dir`.
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
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(REGEX_SPECIALS, '\\$&');
    }
    index += 1;
  }
  return source;
};

/** Приводит путь к сравнимому виду: прямые слэши, без ведущего `./`. */
export const normalizePath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

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
