import { describe, expect, it } from 'vitest';
import { SHA256_MAX_INPUT_BYTES, messageLengthBitWords, sha256Hex } from './sha256.ts';

/**
 * Векторы FIPS 180-4 плюс границы длины блока и многобайтовый UTF-8.
 *
 * Границы 55/56/57 и 63/64/65 выбраны не для полноты: именно там padding переходит через
 * конец 64-байтового блока (длина сообщения не помещается в текущий блок и требуется
 * дополнительный). Реализация, которая ошибается только в этом месте, проходит "abc".
 */
describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ])('совпадает с эталоном FIPS 180-4 для %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it.each([
    [55, '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
    [56, 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
    [57, 'f13b2d724659eb3bf47f2dd6af1accc87b81f09f59f2b75e5c0bed6589dfe8c6'],
    [63, '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34'],
    [64, 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
    [65, '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0'],
    [119, '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb'],
    [120, '2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c'],
  ])('корректно дополняет сообщение длиной %i байт', (length, expected) => {
    expect(sha256Hex('a'.repeat(length))).toBe(expected);
  });

  it('хеширует UTF-8 байты, а не UTF-16 code units (кириллица)', () => {
    expect(sha256Hex('привет')).toBe(
      'e58f1e8c55fa105bdd3f40e5037eb0b039b5998d52c05e6cd98878dd2da5cab2',
    );
  });

  it('хеширует суррогатную пару как четыре UTF-8 байта', () => {
    expect(sha256Hex('\u{1F600}')).toBe(
      'f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9',
    );
  });

  it('обрабатывает сообщение в миллион байт (переполнение счётчика блоков)', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('возвращает ровно 64 hex-символа в нижнем регистре', () => {
    expect(sha256Hex('zona')).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * 64-битная длина сообщения в padding-блоке недостижима обычным тестом: старшее слово
 * становится ненулевым только начиная с 512 МиБ входа, а хешировать столько в gate нельзя.
 * Поэтому вычисление длины вынесено в отдельную чистую функцию и проверяется на границе
 * напрямую — иначе эта ветка осталась бы контролем без единого теста (урок I00-F5).
 */
describe('messageLengthBitWords — граница 2^32 бит', () => {
  it.each([
    [0, [0, 0]],
    [1, [0, 8]],
    [536_870_911, [0, 4_294_967_288]],
    [536_870_912, [1, 0]],
    [536_870_913, [1, 8]],
  ])('для %i байт даёт слова %j', (byteLength, expected) => {
    expect(messageLengthBitWords(byteLength)).toEqual(expected);
  });

  it('документированный предел — наибольшая длина, чья длина в битах ещё точна', () => {
    expect(SHA256_MAX_INPUT_BYTES).toBe(2 ** 50 - 1);
    expect(Number.isSafeInteger(SHA256_MAX_INPUT_BYTES * 8)).toBe(true);
    expect(Number.isSafeInteger((SHA256_MAX_INPUT_BYTES + 1) * 8)).toBe(false);
  });

  it('принимает граничную длину', () => {
    expect(messageLengthBitWords(SHA256_MAX_INPUT_BYTES)).toEqual([2_097_151, 4_294_967_288]);
  });

  it.each([
    ['ровно на единицу выше предела', 2 ** 50],
    ['заметно выше предела', 2 ** 53],
  ])('отвергает длину %s, а не считает неверный хеш молча', (_label, byteLength) => {
    // За этим пределом `byteLength * 8` перестаёт быть точным, и padding получил бы
    // неверную длину сообщения. Тихий неверный хеш хуже отказа: он выглядит как
    // расхождение состояния мира.
    expect(() => messageLengthBitWords(byteLength)).toThrow(/предел|длин/i);
  });
});
