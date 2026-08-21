import { RUNTIME_ID_PREFIXES, isRuntimeId } from '@zona/contracts';
import { describe, expect, it } from 'vitest';
import { SequentialIdFactory } from './id-factory.ts';

describe('SequentialIdFactory', () => {
  it('выдаёт id в формате ULID с верным префиксом', () => {
    const ids = new SequentialIdFactory(1);
    const eventId = ids.next(RUNTIME_ID_PREFIXES.event);
    const commandId = ids.next(RUNTIME_ID_PREFIXES.command);
    const correlationId = ids.next(RUNTIME_ID_PREFIXES.correlation);

    expect(isRuntimeId(eventId, RUNTIME_ID_PREFIXES.event)).toBe(true);
    expect(isRuntimeId(commandId, RUNTIME_ID_PREFIXES.command)).toBe(true);
    expect(isRuntimeId(correlationId, RUNTIME_ID_PREFIXES.correlation)).toBe(true);
  });

  it('нижний регистр не принимается — id всегда в верхнем регистре', () => {
    const ids = new SequentialIdFactory(1);
    const id = ids.next(RUNTIME_ID_PREFIXES.event);
    const body = id.slice(id.indexOf('_') + 1);
    expect(body).toBe(body.toUpperCase());
    expect(isRuntimeId(body.toLowerCase(), RUNTIME_ID_PREFIXES.event)).toBe(false);
  });

  it('одинаковый seed и одинаковая последовательность вызовов дают одинаковые id', () => {
    const a = new SequentialIdFactory(42);
    const b = new SequentialIdFactory(42);
    const sequenceA = [
      a.next(RUNTIME_ID_PREFIXES.event),
      a.next(RUNTIME_ID_PREFIXES.command),
      a.next(RUNTIME_ID_PREFIXES.event),
    ];
    const sequenceB = [
      b.next(RUNTIME_ID_PREFIXES.event),
      b.next(RUNTIME_ID_PREFIXES.command),
      b.next(RUNTIME_ID_PREFIXES.event),
    ];
    expect(sequenceA).toStrictEqual(sequenceB);
  });

  it('последовательные вызовы одного инстанса не повторяются', () => {
    const ids = new SequentialIdFactory(7);
    const generated = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      generated.add(ids.next(RUNTIME_ID_PREFIXES.event));
    }
    expect(generated.size).toBe(200);
  });

  it('разный seed даёт другой id на той же позиции счётчика', () => {
    const a = new SequentialIdFactory(1).next(RUNTIME_ID_PREFIXES.event);
    const b = new SequentialIdFactory(2).next(RUNTIME_ID_PREFIXES.event);
    expect(a).not.toBe(b);
  });

  it('отвергает небезопасный целочисленный seed на границе конструктора', () => {
    expect(() => new SequentialIdFactory(1.5)).toThrow(/seed/);
  });
});
