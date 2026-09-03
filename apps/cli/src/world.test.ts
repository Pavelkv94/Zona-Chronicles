import {
  decodeSnapshot,
  isValidationFailure,
  schemaBundleContent,
  schemaBundleRef,
  verifyBundleRef,
  verifyRuntimeProfileCompatibility,
} from '@zona/contracts';
import { PROTOTYPE_WORLD } from '@zona/content';
import { describe, expect, it } from 'vitest';
import { prototypeRuleset, rulesBundleContent, seedWorld } from './world.ts';

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

  it('prng_stream_positions содержит ровно два draw на агента', () => {
    // Два, а не один: с I06 генезис разыгрывает не только стартовую локацию, но и осторожность.
    // Число точное, а не «не меньше»: позиция потока — это то, с чего продолжится случайность
    // после восстановления снимка, и незамеченный третий розыгрыш сдвинул бы весь мир.
    const { snapshot } = seedWorld(42);
    const positions = snapshot.prng_stream_positions;
    expect(Object.keys(positions).sort()).toEqual(PROTOTYPE_WORLD.agents.map((a) => a.id).sort());
    for (const value of Object.values(positions)) {
      expect(value).toBe(2);
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

  it('cross-host (B2): профиль хоста не входит в checksum, поэтому его равенство остаётся сигналом', () => {
    // Пока профиль был внутри checksum, расхождение между macOS и Linux объяснялось "другая
    // node/ICU" — и настоящая регрессия детерминизма закрылась бы этим же объяснением.
    const macos = seedWorld(42, { nodeVersion: '24.14.0', icuVersion: '77.1' });
    const linux = seedWorld(42, { nodeVersion: '26.3.9', icuVersion: '80.4' });

    expect(linux.snapshot.deterministic_runtime_profile).not.toEqual(
      macos.snapshot.deterministic_runtime_profile,
    );
    expect(linux.snapshot.checksum).toBe(macos.snapshot.checksum);

    // При этом сам профиль не "прощён": несовместимость объявлена отдельно и названа.
    const compatibility = verifyRuntimeProfileCompatibility(
      macos.snapshot.deterministic_runtime_profile,
      linux.snapshot.deterministic_runtime_profile,
    );
    expect(isValidationFailure(compatibility)).toBe(true);
    if (isValidationFailure(compatibility)) {
      expect(compatibility.errors.map((issue) => issue.path).sort()).toEqual([
        '/icu_version',
        '/node_version',
      ]);
    }
  });

  it('cross-host: разное каноническое состояние при разных seed видно и на разных хостах', () => {
    const macos = seedWorld(42, { nodeVersion: '24.14.0', icuVersion: '77.1' });
    const linux = seedWorld(43, { nodeVersion: '26.3.9', icuVersion: '80.4' });
    expect(linux.snapshot.checksum).not.toBe(macos.snapshot.checksum);
  });

  it('M3: checksum rules bundle считается от содержимого ruleset, а не от пустого объекта', () => {
    const { snapshot } = seedWorld(42);
    // Прежнее значение: sha256("{}") — изменение любого коэффициента при той же версии было
    // необнаружимо, потому что содержимым считался пустой объект.
    expect(snapshot.bundles.rules.checksum).not.toBe(
      'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    // Версии — ТЕ ЖЕ, что использует `seedWorld`. Умолчание `rulesBundleContent()` больше не
    // совпадает с ними: версия контента живёт в `@zona/content`, а не в тестовых умолчаниях
    // домена (I03). Проверка от этого стала строже — она сверяет фактические версии мира.
    expect(
      isValidationFailure(
        verifyBundleRef(rulesBundleContent(prototypeRuleset()), snapshot.bundles.rules),
      ),
    ).toBe(false);

    const tampered = JSON.parse(JSON.stringify(rulesBundleContent(prototypeRuleset()))) as Record<
      string,
      unknown
    >;
    (tampered['versions'] as Record<string, unknown>)['contentVersion'] = '0.1.1';
    expect(isValidationFailure(verifyBundleRef(tampered, snapshot.bundles.rules))).toBe(true);
  });

  it('M3: checksum schema bundle считается от самих схем, а не от трёх строк $id', () => {
    const { snapshot } = seedWorld(42);
    expect(snapshot.bundles.schema.checksum).not.toBe(
      'sha256:de92dd4564e825e0a9eaf3b35c5078166880bf92a75aad6baa9fdd7eeaa77124',
    );
    expect(snapshot.bundles.schema).toEqual(schemaBundleRef());
    expect(
      isValidationFailure(verifyBundleRef(schemaBundleContent(), snapshot.bundles.schema)),
    ).toBe(false);

    const tampered = JSON.parse(JSON.stringify(schemaBundleContent())) as Record<string, unknown>;
    delete (tampered['zona:snapshot/1'] as Record<string, unknown>)['additionalProperties'];
    expect(isValidationFailure(verifyBundleRef(tampered, snapshot.bundles.schema))).toBe(true);
  });

  it('отвергает небезопасный (нецелый) seed', () => {
    expect(() => seedWorld(1.5)).toThrow(/seed/);
    expect(() => seedWorld(Number.NaN)).toThrow(/seed/);
  });
});
