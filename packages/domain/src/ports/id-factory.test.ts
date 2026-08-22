import { RUNTIME_ID_PREFIXES, isRuntimeId } from '@zona/contracts';
import { describe, expect, it } from 'vitest';
import { DerivedIdFactory, SequentialIdFactory } from './id-factory.ts';

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

  /**
   * Golden-значения (I02A).
   *
   * С I02A `event_id` попадает в НЕВОСПОЛНИМЫЙ журнал и обязан воспроизводиться при
   * пересимуляции того же seed (SIM-01). Пока id жили только в памяти, «тот же seed даёт те же
   * id» проверялось сравнением двух инстансов — такая проверка остаётся зелёной, даже если
   * алгоритм изменился целиком, потому что сравнивает его сам с собой. Литералы ниже привязывают
   * выход к КОНКРЕТНЫМ значениям: их изменение — это изменение формата уже записанной истории,
   * то есть migration, а не рефакторинг. Обновлять их без такого объяснения запрещено.
   *
   * Значения сняты с реализации на коммите 7ca3800 и совпадают с реализацией до введения
   * `DerivedIdFactory` (проба lead-а: 1000 id × 5 seed, расхождений нет).
   */
  it('golden: выданные id не менялись между версиями реализации', () => {
    const ids = new SequentialIdFactory(42);
    expect([
      ids.next(RUNTIME_ID_PREFIXES.event),
      ids.next(RUNTIME_ID_PREFIXES.command),
      ids.next(RUNTIME_ID_PREFIXES.correlation),
    ]).toStrictEqual([
      'evt_EXFA9RBPBTHMWXAYM6XQ8QN051',
      'cmd_E43Y8PVG0ZHCGWR7WY0Q41Z5XS',
      'corr_JAHVJVMKMEXG3453PS4938XQVE',
    ]);
  });
});

describe('DerivedIdFactory', () => {
  it('строковый ключ происхождения даёт воспроизводимые id', () => {
    const a = new DerivedIdFactory('world:prototype:1');
    const b = new DerivedIdFactory('world:prototype:1');
    expect(a.next(RUNTIME_ID_PREFIXES.event)).toBe(b.next(RUNTIME_ID_PREFIXES.event));
  });

  it('разные ключи дают разные id на той же позиции счётчика', () => {
    const a = new DerivedIdFactory('world:prototype:1').next(RUNTIME_ID_PREFIXES.event);
    const b = new DerivedIdFactory('world:prototype:2').next(RUNTIME_ID_PREFIXES.event);
    expect(a).not.toBe(b);
  });

  it('совпадает с SequentialIdFactory на числовом ключе — один алгоритм, не два', () => {
    const derived = new DerivedIdFactory('42').next(RUNTIME_ID_PREFIXES.event);
    const sequential = new SequentialIdFactory(42).next(RUNTIME_ID_PREFIXES.event);
    expect(derived).toBe(sequential);
  });

  /** Тот же довод, что у golden выше: ключ `<world_id>:<sequence>` — формат журнала I02A. */
  it('golden: id команды журнала не менялись', () => {
    const ids = new DerivedIdFactory('world:prototype:1');
    expect([
      ids.next(RUNTIME_ID_PREFIXES.event),
      ids.next(RUNTIME_ID_PREFIXES.correlation),
    ]).toStrictEqual(['evt_D2ETY739KPRAYTMXP916Q7DKTN', 'corr_BSSE7Q2ZEBJPYR3JWW162WQ8JN']);
  });

  it('пустой ключ отвергается на границе конструктора', () => {
    expect(() => new DerivedIdFactory('')).toThrow(/ключ/);
  });
});
