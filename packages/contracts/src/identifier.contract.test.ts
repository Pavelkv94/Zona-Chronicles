import { describe, expect, it } from 'vitest';
import {
  NAMESPACED_ID_PATTERN,
  ULID_ALPHABET,
  ULID_BODY_LENGTH,
  RUNTIME_ID_PATTERN,
  RUNTIME_ID_PREFIXES,
  isNamespacedId,
  isRuntimeId,
  namespaceOf,
} from './identifier.ts';

describe('namespaced id — стабильный slug статического контента (§1)', () => {
  it.each([
    'world:prototype',
    'loc:quiet-yard',
    'agent:rook',
    'route:yard-to-bridge',
    'system:world',
    'system:weather',
    'plan:p1',
    'a:b',
  ])('принимает %j', (value) => {
    expect(isNamespacedId(value)).toBe(true);
  });

  it.each([
    ['без namespace', 'quiet-yard'],
    ['пустой namespace', ':quiet-yard'],
    ['пустая локальная часть', 'loc:'],
    ['верхний регистр', 'Loc:quiet-yard'],
    ['подчёркивание', 'loc:quiet_yard'],
    ['пробел', 'loc:quiet yard'],
    ['две двоеточия', 'loc:quiet:yard'],
    ['ведущий дефис', 'loc:-quiet'],
    ['завершающий дефис', 'loc:quiet-'],
    ['двойной дефис', 'loc:quiet--yard'],
    ['namespace начинается с цифры', '1loc:quiet-yard'],
    ['кириллица', 'loc:двор'],
    ['пустая строка', ''],
  ])('отвергает %s (%j)', (_label, value) => {
    expect(isNamespacedId(value)).toBe(false);
  });

  it('шаблон и предикат согласованы', () => {
    expect(NAMESPACED_ID_PATTERN.test('loc:quiet-yard')).toBe(true);
    expect(NAMESPACED_ID_PATTERN.test('loc:quiet_yard')).toBe(false);
  });

  it('шаблон якорится с обеих сторон: перевод строки не проходит', () => {
    expect(isNamespacedId('loc:quiet-yard\nagent:rook')).toBe(false);
  });

  it('namespaceOf возвращает namespace или null', () => {
    expect(namespaceOf('loc:quiet-yard')).toBe('loc');
    expect(namespaceOf('system:world')).toBe('system');
    expect(namespaceOf('не id')).toBe(null);
  });
});

describe('runtime id — сгенерированный IdFactory (§1)', () => {
  it('перечисляет префиксы, используемые первым slice', () => {
    expect(RUNTIME_ID_PREFIXES).toEqual({
      command: 'cmd',
      correlation: 'corr',
      event: 'evt',
    });
  });

  it('тело — ULID: ровно 26 символов Crockford base32', () => {
    expect(ULID_BODY_LENGTH).toBe(26);
    expect(ULID_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    // Crockford исключает I, L, O и U — они путаются с 1, 1, 0 и V при чтении.
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(ULID_ALPHABET).not.toContain(excluded);
    }
  });

  it.each([
    ['evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0', 'evt'],
    ['cmd_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0', 'cmd'],
    ['corr_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0', 'corr'],
    ['evt_00000000000000000000000000', 'evt'],
    ['evt_7ZZZZZZZZZZZZZZZZZZZZZZZZZ', 'evt'],
  ])('принимает %j для префикса %s', (value, prefix) => {
    expect(isRuntimeId(value, prefix)).toBe(true);
  });

  it.each([
    ['чужой префикс', 'cmd_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0', 'evt'],
    ['без префикса', '01J8Z4K7Q2R3S4T5V6W7X8Y9Z0', 'evt'],
    ['пустое тело', 'evt_', 'evt'],
    ['слишком короткое тело', 'evt_01J8', 'evt'],
    ['подчёркивание в теле', 'evt_01J8Z4K7Q2R3S4T5_6W7X8Y9Z0', 'evt'],
    ['пробел', 'evt_01J8Z4K7Q2R3S4T5 6W7X8Y9Z0', 'evt'],
    ['двоеточие', 'evt:01J8Z4K7Q2R3S4T5V6W7X8Y9Z0', 'evt'],
    ['пустая строка', '', 'evt'],
    ['UUIDv7 — решение принято в пользу ULID', 'evt_0189d0ba-7a1e-7c4a-9c1e-1a2b3c4d5e6f', 'evt'],
    ['UUIDv7 без дефисов', 'evt_0189d0ba7a1e7c4a9c1e1a2b3c4d5e6f', 'evt'],
    ['нижний регистр', 'evt_01j8z4k7q2r3s4t5v6w7x8y9z0', 'evt'],
  ])('отвергает %s (%j)', (_label, value, prefix) => {
    expect(isRuntimeId(value, prefix)).toBe(false);
  });

  it.each([25, 27])('отвергает тело длиной %i символов', (length) => {
    expect(isRuntimeId(`evt_${'0'.repeat(length)}`, 'evt')).toBe(false);
  });

  it.each(['I', 'L', 'O', 'U'])('отвергает букву %s, исключённую из Crockford base32', (letter) => {
    // 26 символов ровно: длина верна, недопустима именно буква.
    expect(isRuntimeId(`evt_${letter}${'0'.repeat(25)}`, 'evt')).toBe(false);
  });

  it('шаблон якорится: перевод строки не проходит', () => {
    expect(isRuntimeId('evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0\nevt_x', 'evt')).toBe(false);
  });

  it('RUNTIME_ID_PATTERN строит шаблон для конкретного префикса', () => {
    const pattern = RUNTIME_ID_PATTERN('evt');
    expect(new RegExp(pattern).test('evt_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0')).toBe(true);
    expect(new RegExp(pattern).test('cmd_01J8Z4K7Q2R3S4T5V6W7X8Y9Z0')).toBe(false);
    // Шаблон отдаётся строкой: TypeBox кладёт её в JSON Schema `pattern`, где RegExp
    // недопустим. Якоря обязаны быть в самой строке.
    expect(pattern.startsWith('^')).toBe(true);
    expect(pattern.endsWith('$')).toBe(true);
  });
});
