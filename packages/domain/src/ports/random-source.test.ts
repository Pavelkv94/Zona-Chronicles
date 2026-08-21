import { describe, expect, it } from 'vitest';
import { DeterministicRandomSource } from './random-source.ts';

describe('DeterministicRandomSource: базовые свойства draw()', () => {
  it('value лежит в [0, 1)', () => {
    const source = new DeterministicRandomSource(1);
    for (let i = 0; i < 500; i += 1) {
      const { value } = source.draw('world:prototype');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('draw() сообщает streamKey и drawIndex, начиная с 0 и возрастая на 1', () => {
    const source = new DeterministicRandomSource(1);
    const first = source.draw('agent:rook');
    const second = source.draw('agent:rook');
    const third = source.draw('agent:rook');
    expect(first.streamKey).toBe('agent:rook');
    expect([first.drawIndex, second.drawIndex, third.drawIndex]).toStrictEqual([0, 1, 2]);
  });

  it('счётчик draw независим по каждому streamKey, даже при чередовании вызовов', () => {
    const source = new DeterministicRandomSource(1);
    const a1 = source.draw('agent:rook');
    const b1 = source.draw('scene:yard');
    const a2 = source.draw('agent:rook');
    const b2 = source.draw('scene:yard');
    expect([a1.drawIndex, a2.drawIndex]).toStrictEqual([0, 1]);
    expect([b1.drawIndex, b2.drawIndex]).toStrictEqual([0, 1]);
  });

  it('одинаковый (seed, streamKey) на двух независимых инстансах даёт одинаковую последовательность', () => {
    const a = new DeterministicRandomSource(42);
    const b = new DeterministicRandomSource(42);
    const sequenceA = Array.from({ length: 20 }, () => a.draw('world:prototype').value);
    const sequenceB = Array.from({ length: 20 }, () => b.draw('world:prototype').value);
    expect(sequenceA).toStrictEqual(sequenceB);
  });

  it('не все значения одной серии равны (ловит мутацию "поток не продвигается")', () => {
    const source = new DeterministicRandomSource(1);
    const values = Array.from({ length: 50 }, () => source.draw('world:prototype').value);
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it('разные streamKey при одном seed дают разное первое значение', () => {
    const source = new DeterministicRandomSource(1);
    const a = source.draw('agent:rook');
    const b = source.draw('agent:doc');
    expect(a.value).not.toBe(b.value);
  });

  it('отвергает небезопасный целочисленный seed на границе конструктора', () => {
    expect(() => new DeterministicRandomSource(Number.NaN)).toThrow(/seed/);
  });
});
