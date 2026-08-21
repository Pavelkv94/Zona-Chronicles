import { decodeSnapshot, isValidationFailure } from '@zona/contracts';
import { PROTOTYPE_WORLD } from '@zona/content';
import { describe, expect, it } from 'vitest';
import { seedWorld } from './world.ts';

function decodedSnapshot(seed: number) {
  const { snapshot } = seedWorld(seed);
  const result = decodeSnapshot(snapshot);
  if (isValidationFailure(result)) {
    throw new Error(`ожидался валидный snapshot: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

describe('seedWorld', () => {
  it('строит snapshot, проходящий decodeSnapshot/verifySnapshotChecksum', () => {
    expect(() => decodedSnapshot(42)).not.toThrow();
  });

  it('одинаковый seed внутри одного процесса даёт побайтово одинаковый snapshot (базовая проверка; A1 проверяет 100 отдельных процессов)', () => {
    const first = JSON.stringify(seedWorld(42).snapshot);
    const second = JSON.stringify(seedWorld(42).snapshot);
    expect(second).toBe(first);
  });

  it('разный seed даёт разный checksum (A2)', () => {
    const a = seedWorld(42).snapshot;
    const b = seedWorld(43).snapshot;
    expect(a.checksum).not.toBe(b.checksum);
  });

  it('canonical_state содержит ровно агентов и маршрутов из контента', () => {
    const { state } = seedWorld(42);
    expect(Object.keys(state.agents).sort()).toEqual(
      PROTOTYPE_WORLD.agents.map((a) => a.id).sort(),
    );
    expect(Object.keys(state.routes).sort()).toEqual(
      PROTOTYPE_WORLD.routes.map((r) => r.id).sort(),
    );
  });

  it('каждый агент стоит в idle без routeId, в одной из локаций контента', () => {
    const { state } = seedWorld(42);
    const locationIds = new Set(PROTOTYPE_WORLD.locations.map((l) => l.id));
    for (const agent of Object.values(state.agents)) {
      expect(agent.status).toBe('idle');
      expect(agent.routeId).toBeNull();
      expect(locationIds.has(agent.locationId)).toBe(true);
    }
  });

  it('prng_stream_positions содержит ровно один draw на агента', () => {
    const { snapshot } = seedWorld(42);
    const positions = snapshot.prng_stream_positions;
    expect(Object.keys(positions).sort()).toEqual(PROTOTYPE_WORLD.agents.map((a) => a.id).sort());
    for (const value of Object.values(positions)) {
      expect(value).toBe(1);
    }
  });

  it('bundles.content и bundles.schema не зависят от seed: контент — immutable bundle, не пересобирается по seed', () => {
    const a = seedWorld(42).snapshot;
    const b = seedWorld(43).snapshot;
    expect(a.bundles.content).toEqual(b.bundles.content);
    expect(a.bundles.schema).toEqual(b.bundles.schema);
    expect(a.bundles.rules).toEqual(b.bundles.rules);
  });

  it('world_time/created_at одинаковы у разных seed: время генезиса — свойство контента, не seed', () => {
    const a = seedWorld(42).snapshot;
    const b = seedWorld(43).snapshot;
    expect(a.world_time).toBe(b.world_time);
    expect(a.created_at).toBe(b.created_at);
    expect(a.world_time).toBe(a.created_at);
  });

  it('отвергает небезопасный (нецелый) seed', () => {
    expect(() => seedWorld(1.5)).toThrow(/seed/);
    expect(() => seedWorld(Number.NaN)).toThrow(/seed/);
  });
});
