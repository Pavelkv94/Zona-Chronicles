import { describe, expect, it } from 'vitest';
import { matchesAnyGlob, matchesGlob, normalizePath } from './glob.ts';

describe('normalizePath', () => {
  it('убирает ведущий ./ и завершающий слэш', () => {
    expect(normalizePath('./packages/domain/')).toBe('packages/domain');
  });

  it('приводит обратные слэши к прямым', () => {
    expect(normalizePath('packages\\domain\\src')).toBe('packages/domain/src');
  });
});

describe('matchesGlob', () => {
  it('совпадает по точному пути', () => {
    expect(matchesGlob('pnpm-lock.yaml', 'pnpm-lock.yaml')).toBe(true);
    expect(matchesGlob('pnpm-lock.yml', 'pnpm-lock.yaml')).toBe(false);
  });

  it('`**` покрывает вложенные сегменты', () => {
    expect(matchesGlob('packages/domain/src/a/b/c.ts', 'packages/domain/**')).toBe(true);
  });

  it('`dir/**` совпадает с самим каталогом', () => {
    expect(matchesGlob('packages/domain', 'packages/domain/**')).toBe(true);
  });

  it('`*` не пересекает границу сегмента', () => {
    expect(matchesGlob('packages/domain/src/index.ts', 'packages/*/index.ts')).toBe(false);
    expect(matchesGlob('packages/domain/index.ts', 'packages/*/index.ts')).toBe(true);
  });

  it('`**/` совпадает с нулём сегментов', () => {
    expect(matchesGlob('a.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesGlob('x/y/a.test.ts', '**/*.test.ts')).toBe(true);
  });

  it('точка в паттерне не превращается в любой символ', () => {
    expect(matchesGlob('pnpmXlock.yaml', 'pnpm-lock.yaml')).toBe(false);
    expect(matchesGlob('.claudeXsettings.json', '.claude/settings.json')).toBe(false);
  });

  it('`?` совпадает ровно с одним символом внутри сегмента', () => {
    expect(matchesGlob('a1.ts', 'a?.ts')).toBe(true);
    expect(matchesGlob('a12.ts', 'a?.ts')).toBe(false);
    expect(matchesGlob('a/1.ts', 'a?1.ts')).toBe(false);
  });
});

describe('matchesAnyGlob', () => {
  it('истинно, если совпал хотя бы один паттерн', () => {
    expect(matchesAnyGlob('tools/x/a.ts', ['packages/**', 'tools/**'])).toBe(true);
  });

  it('ложно на пустом списке', () => {
    expect(matchesAnyGlob('tools/x/a.ts', [])).toBe(false);
  });
});
