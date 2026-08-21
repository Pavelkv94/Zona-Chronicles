import { describe, expect, it } from 'vitest';
import {
  BundleRefSchema,
  DeterministicRuntimeProfileSchema,
  EXACT_MATCH_PROFILE_FIELDS,
  MAJOR_MINOR_PROFILE_FIELDS,
  SNAPSHOT_CHECKSUM_EXCLUDED_FIELDS,
  SNAPSHOT_CHECKSUM_FIELDS,
  SNAPSHOT_CHECKSUM_SCOPE_VERSION,
  SNAPSHOT_SEQUENCE_UNIT,
  SnapshotSchema,
  type Snapshot,
  bundleRefFor,
  decodeSnapshot,
  snapshotChecksum,
  verifyBundleRef,
  verifyRuntimeProfileCompatibility,
  verifySnapshotChecksum,
} from './snapshot.ts';
import { isValidationFailure } from './validation.ts';
import { CANONICAL_SERIALIZATION_VERSION } from './canonical-json.ts';

const RULES_BUNDLE = { travel: { base_minutes: 30 }, version: '0.1.0' };
const CONTENT_BUNDLE = { locations: ['loc:quiet-yard', 'loc:bridge'] };
const SCHEMA_BUNDLE = { world_event: 'zona:world-event/1' };

const BASE_SNAPSHOT = {
  world_id: 'world:prototype',
  last_sequence: 0,
  world_time: '2034-05-17T18:20:00.000Z',
  created_at: '2026-08-20T12:01:02.000Z',
  bundles: {
    rules: bundleRefFor('0.1.0', RULES_BUNDLE),
    content: bundleRefFor('0.1.0', CONTENT_BUNDLE),
    schema: bundleRefFor('1.0.0', SCHEMA_BUNDLE),
  },
  deterministic_runtime_profile: {
    canonical_serialization_version: CANONICAL_SERIALIZATION_VERSION,
    snapshot_checksum_scope_version: SNAPSHOT_CHECKSUM_SCOPE_VERSION,
    prng_version: 'xoshiro256++/1',
    numeric_rounding_policy_version: 'numeric-units/1',
    node_version: '24.14.0',
    icu_version: '77.1',
    timezone: 'UTC',
  },
  prng_stream_positions: { 'agent:rook': 12, 'world:prototype': 3 },
  canonical_state: { agents: [{ id: 'agent:rook', location_id: 'loc:quiet-yard' }] },
} as const;

function withChecksum(base: unknown): Record<string, unknown> {
  const checksum = snapshotChecksum(base as Omit<Snapshot, 'checksum'>);
  return { ...(base as Record<string, unknown>), checksum };
}

function decoded(input: unknown): Snapshot {
  const result = decodeSnapshot(input);
  if (isValidationFailure(result)) {
    throw new Error(`ожидался валидный snapshot, получено: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

function issues(input: unknown): string {
  const result = decodeSnapshot(input);
  if (!isValidationFailure(result)) {
    throw new Error('ожидался отказ, snapshot принят');
  }
  return result.errors.map((issue) => `${issue.path} ${issue.message}`).join('\n');
}

describe('snapshot ссылается на bundles по версии И checksum (A9, §9)', () => {
  it('принимает корректный snapshot', () => {
    expect(decoded(withChecksum(BASE_SNAPSHOT)).world_id).toBe('world:prototype');
  });

  it('bundle ref содержит и версию, и checksum: одной semantic version недостаточно (§7)', () => {
    const ref = bundleRefFor('0.1.0', RULES_BUNDLE);
    expect(ref.version).toBe('0.1.0');
    expect(ref.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(ref).sort()).toEqual(['checksum', 'version']);
  });

  it.each([['version'], ['checksum']])('отвергает bundle ref без поля %s', (field) => {
    const ref: Record<string, unknown> = { ...bundleRefFor('0.1.0', RULES_BUNDLE) };
    delete ref[field];
    const broken = { ...BASE_SNAPSHOT, bundles: { ...BASE_SNAPSHOT.bundles, rules: ref } };
    expect(issues(withChecksum(broken))).toMatch(new RegExp(field));
  });

  it.each([['rules'], ['content'], ['schema']])('требует bundle %s', (bundle) => {
    const bundles: Record<string, unknown> = { ...BASE_SNAPSHOT.bundles };
    delete bundles[bundle];
    expect(issues(withChecksum({ ...BASE_SNAPSHOT, bundles }))).toMatch(new RegExp(bundle));
  });

  it('подмена содержимого bundle без изменения версии обнаруживается (A9)', () => {
    const ref = bundleRefFor('0.1.0', RULES_BUNDLE);
    const tampered = { ...RULES_BUNDLE, travel: { base_minutes: 31 } };

    expect(isValidationFailure(verifyBundleRef(RULES_BUNDLE, ref))).toBe(false);

    const result = verifyBundleRef(tampered, ref);
    expect(isValidationFailure(result)).toBe(true);
    if (isValidationFailure(result)) {
      expect(result.errors[0]?.message).toMatch(/checksum/i);
    }
  });

  it('подмена не маскируется совпадающей версией', () => {
    const ref = bundleRefFor('0.1.0', RULES_BUNDLE);
    const tampered = { ...RULES_BUNDLE, travel: { base_minutes: 31 } };
    expect(bundleRefFor('0.1.0', tampered).version).toBe(ref.version);
    expect(bundleRefFor('0.1.0', tampered).checksum).not.toBe(ref.checksum);
  });

  it('checksum bundle не зависит от порядка ключей в его содержимом', () => {
    const reordered = { version: '0.1.0', travel: { base_minutes: 30 } };
    expect(bundleRefFor('0.1.0', reordered).checksum).toBe(
      bundleRefFor('0.1.0', RULES_BUNDLE).checksum,
    );
  });

  it('bundle с неканоничным содержимым отвергается, а не хешируется как есть (A5)', () => {
    expect(() => bundleRefFor('0.1.0', { weight: Number.NaN })).toThrow(/weight|конечн/i);
  });
});

describe('deterministic runtime profile (§9)', () => {
  it.each([
    'canonical_serialization_version',
    'snapshot_checksum_scope_version',
    'prng_version',
    'numeric_rounding_policy_version',
    'node_version',
    'icu_version',
    'timezone',
  ])('требует поле профиля %s', (field) => {
    const profile: Record<string, unknown> = { ...BASE_SNAPSHOT.deterministic_runtime_profile };
    delete profile[field];
    expect(
      issues(withChecksum({ ...BASE_SNAPSHOT, deterministic_runtime_profile: profile })),
    ).toMatch(new RegExp(field));
  });

  it('версия canonical serialization в профиле совпадает с версией алгоритма', () => {
    expect(
      decoded(withChecksum(BASE_SNAPSHOT)).deterministic_runtime_profile
        .canonical_serialization_version,
    ).toBe(CANONICAL_SERIALIZATION_VERSION);
  });

  it('отвергает профиль с чужой версией сериализации: checksum несопоставим', () => {
    const profile = {
      ...BASE_SNAPSHOT.deterministic_runtime_profile,
      canonical_serialization_version: 'canonical-json/2',
    };
    expect(
      issues(withChecksum({ ...BASE_SNAPSHOT, deterministic_runtime_profile: profile })),
    ).toMatch(/canonical_serialization_version/);
  });
});

describe('snapshot checksum (§9)', () => {
  it('не зависит от порядка вставки ключей (A3)', () => {
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(BASE_SNAPSHOT).reverse()) {
      reordered[key] = (BASE_SNAPSHOT as Record<string, unknown>)[key];
    }
    expect(snapshotChecksum(reordered as never)).toBe(snapshotChecksum(BASE_SNAPSHOT as never));
  });

  it('меняется при изменении канонического состояния', () => {
    const changed = { ...BASE_SNAPSHOT, canonical_state: { agents: [] } };
    expect(snapshotChecksum(changed as never)).not.toBe(snapshotChecksum(BASE_SNAPSHOT as never));
  });

  it('меняется при изменении позиции PRNG-потока', () => {
    const changed = { ...BASE_SNAPSHOT, prng_stream_positions: { 'agent:rook': 13 } };
    expect(snapshotChecksum(changed as never)).not.toBe(snapshotChecksum(BASE_SNAPSHOT as never));
  });

  it('не включает собственное поле checksum: иначе значение было бы самоссылочным', () => {
    const snapshot = withChecksum(BASE_SNAPSHOT);
    expect(snapshotChecksum(snapshot as never)).toBe(snapshot['checksum']);
  });

  it('меняется при изменении world_id, last_sequence, world_time и bundles', () => {
    const base = snapshotChecksum(BASE_SNAPSHOT);
    const variants: readonly Record<string, unknown>[] = [
      { ...BASE_SNAPSHOT, world_id: 'world:other' },
      { ...BASE_SNAPSHOT, last_sequence: 1 },
      { ...BASE_SNAPSHOT, world_time: '2034-05-17T18:20:00.001Z' },
      {
        ...BASE_SNAPSHOT,
        bundles: {
          ...BASE_SNAPSHOT.bundles,
          rules: bundleRefFor('0.1.0', { ...RULES_BUNDLE, travel: { base_minutes: 31 } }),
        },
      },
    ];
    for (const variant of variants) {
      expect(snapshotChecksum(variant as never), JSON.stringify(Object.keys(variant))).not.toBe(
        base,
      );
    }
  });
});

describe('B2: область checksum — только то, что воспроизводит replay (§9)', () => {
  it('created_at вне checksum: wall clock — метаданные, иначе критерий валидности снимка невычислим', () => {
    // §9 требует одновременно, чтобы created_at был "wall clock только как metadata" и чтобы
    // replay событий после last_sequence давал ТОТ ЖЕ checksum, что полный replay. Два прогона
    // в разное время неизбежно дают разный created_at; совместимо это только вне checksum.
    const later = { ...BASE_SNAPSHOT, created_at: '2026-09-01T03:04:05.678Z' };
    expect(snapshotChecksum(later as never)).toBe(snapshotChecksum(BASE_SNAPSHOT as never));
  });

  it('профиль хоста вне checksum: равенство checksum между хостами обязано остаться сигналом', () => {
    // Профиль внутри checksum делает НАСТОЯЩУЮ cross-host регрессию детерминизма неотличимой
    // от ожидаемой разницы профиля: расхождение объясняется "другой node/ICU" и дефект
    // закрывается как ожидаемый.
    const otherHost = {
      ...BASE_SNAPSHOT,
      deterministic_runtime_profile: {
        ...BASE_SNAPSHOT.deterministic_runtime_profile,
        node_version: '24.20.1',
        icu_version: '78.2',
      },
    };
    expect(snapshotChecksum(otherHost as never)).toBe(snapshotChecksum(BASE_SNAPSHOT as never));
  });

  it('cross-host: одинаковое содержимое на разных хостах даёт равный checksum, разное — разный', () => {
    const macos = {
      ...BASE_SNAPSHOT,
      created_at: '2026-08-20T12:01:02.000Z',
      deterministic_runtime_profile: {
        ...BASE_SNAPSHOT.deterministic_runtime_profile,
        node_version: '24.14.0',
        icu_version: '77.1',
      },
    };
    const linux = {
      ...BASE_SNAPSHOT,
      created_at: '2026-08-20T19:44:31.005Z',
      deterministic_runtime_profile: {
        ...BASE_SNAPSHOT.deterministic_runtime_profile,
        node_version: '24.14.2',
        icu_version: '78.2',
      },
    };
    expect(snapshotChecksum(linux as never)).toBe(snapshotChecksum(macos as never));

    // И обратное: если на одном из хостов ядро посчитало другое состояние, это видно.
    const linuxDrifted = { ...linux, canonical_state: { agents: [] } };
    expect(snapshotChecksum(linuxDrifted as never)).not.toBe(snapshotChecksum(macos as never));
  });

  it('область checksum объявлена исчерпывающе: новое поле схемы обязано быть классифицировано', () => {
    // Контроль того же класса, что A8: pick-реализация молча оставила бы новое поле снимка вне
    // checksum. Добавление поля в SnapshotSchema обязано ронять этот тест, а не проходить.
    const schemaFields = Object.keys(SnapshotSchema.properties).sort();
    const classified = [...SNAPSHOT_CHECKSUM_FIELDS, ...SNAPSHOT_CHECKSUM_EXCLUDED_FIELDS].sort();
    expect(classified).toEqual(schemaFields);
    expect(SNAPSHOT_CHECKSUM_EXCLUDED_FIELDS).toEqual([
      'checksum',
      'created_at',
      'deterministic_runtime_profile',
    ]);
  });

  it('версия области checksum записана в снимке: смена области — смена алгоритма', () => {
    expect(SNAPSHOT_CHECKSUM_SCOPE_VERSION).toBe('snapshot-checksum/2');
    expect(
      decoded(withChecksum(BASE_SNAPSHOT)).deterministic_runtime_profile
        .snapshot_checksum_scope_version,
    ).toBe(SNAPSHOT_CHECKSUM_SCOPE_VERSION);
  });

  it('снимок прежней области checksum отвергается, а не перепроверяется по новым правилам', () => {
    const profile: Record<string, unknown> = {
      ...BASE_SNAPSHOT.deterministic_runtime_profile,
      snapshot_checksum_scope_version: 'snapshot-checksum/1',
    };
    expect(
      issues(withChecksum({ ...BASE_SNAPSHOT, deterministic_runtime_profile: profile })),
    ).toMatch(/snapshot_checksum_scope_version/);
  });
});

describe('B2: профиль runtime проверяется совместимостью, а не равенством (§7)', () => {
  const PROFILE = BASE_SNAPSHOT.deterministic_runtime_profile;

  function compatibility(overrides: Record<string, unknown>): string {
    const result = verifyRuntimeProfileCompatibility(PROFILE, {
      ...PROFILE,
      ...overrides,
    });
    if (!isValidationFailure(result)) {
      return '';
    }
    return result.errors.map((issue) => `${issue.path} ${issue.message}`).join('\n');
  }

  it('идентичные профили совместимы', () => {
    expect(compatibility({})).toBe('');
  });

  it('другой patch Node.js совместим: §7 квалифицирует major/minor profile', () => {
    expect(compatibility({ node_version: '24.14.99' })).toBe('');
  });

  it.each([
    ['node_version', '25.0.0'],
    ['icu_version', '78.2'],
    ['timezone', 'Europe/Minsk'],
    ['prng_version', 'xoshiro256++/2'],
    ['numeric_rounding_policy_version', 'numeric-units/2'],
    ['canonical_serialization_version', 'canonical-json/2'],
    ['snapshot_checksum_scope_version', 'snapshot-checksum/1'],
  ])('%s = %s несовместим до прогона compatibility suite', (field, value) => {
    expect(compatibility({ [field]: value })).toMatch(new RegExp(field));
  });

  it('политика совместимости исчерпывающа: новое поле профиля обязано быть классифицировано', () => {
    const profileFields = Object.keys(DeterministicRuntimeProfileSchema.properties).sort();
    expect([...EXACT_MATCH_PROFILE_FIELDS, ...MAJOR_MINOR_PROFILE_FIELDS].sort()).toEqual(
      profileFields,
    );
  });

  it('несовместимость профиля — отдельный отказ, а не расхождение checksum', () => {
    const otherHost = {
      ...BASE_SNAPSHOT,
      deterministic_runtime_profile: { ...PROFILE, icu_version: '78.2' },
    };
    expect(snapshotChecksum(otherHost as never)).toBe(snapshotChecksum(BASE_SNAPSHOT as never));
    expect(compatibility({ icu_version: '78.2' })).toMatch(/icu_version/);
  });

  it('verifySnapshotChecksum принимает согласованный snapshot', () => {
    expect(isValidationFailure(verifySnapshotChecksum(decoded(withChecksum(BASE_SNAPSHOT))))).toBe(
      false,
    );
  });

  it('verifySnapshotChecksum отвергает подменённое состояние при прежнем checksum', () => {
    const snapshot = decoded(withChecksum(BASE_SNAPSHOT));
    const tampered = { ...snapshot, canonical_state: { agents: [] } } as Snapshot;
    const result = verifySnapshotChecksum(tampered);
    expect(isValidationFailure(result)).toBe(true);
    if (isValidationFailure(result)) {
      expect(result.errors[0]?.path).toBe('/checksum');
    }
  });

  it('decodeSnapshot отвергает snapshot с несогласованным checksum', () => {
    const snapshot = withChecksum(BASE_SNAPSHOT);
    expect(issues({ ...snapshot, canonical_state: { agents: [{ id: 'agent:kite' }] } })).toMatch(
      /checksum/,
    );
  });

  it('отвергает snapshot с неканоничным состоянием (A5)', () => {
    expect(
      isValidationFailure(
        decodeSnapshot({
          ...BASE_SNAPSHOT,
          canonical_state: { drift: Number.POSITIVE_INFINITY },
          checksum: 'sha256:'.padEnd(71, '0'),
        }),
      ),
    ).toBe(true);
  });
});

describe('snapshot: остальные поля (§9)', () => {
  it('last_sequence начинается с 0: у только что порождённого мира событий нет', () => {
    expect(SNAPSHOT_SEQUENCE_UNIT.min).toBe(0);
    expect(decoded(withChecksum(BASE_SNAPSHOT)).last_sequence).toBe(0);
  });

  it.each([
    ['отрицательное', -1],
    ['дробное', 1.5],
    ['строка', '0'],
  ])('отвергает last_sequence %s', (_label, value) => {
    // Checksum-заглушка правильной формы: отказ обязан произойти на схеме, до сверки
    // checksum, поэтому считать настоящий checksum здесь нечего (и невозможно — 1.5
    // неканонично по построению).
    const placeholder = `sha256:${'0'.repeat(64)}`;
    expect(
      isValidationFailure(
        decodeSnapshot({ ...BASE_SNAPSHOT, last_sequence: value, checksum: placeholder }),
      ),
    ).toBe(true);
  });

  it('нормализует world_time и created_at к канонической форме', () => {
    const snapshot = decoded(
      withChecksum({
        ...BASE_SNAPSHOT,
        world_time: '2034-05-17T20:20:00+02:00',
        created_at: '2026-08-20T07:01:02-05:00',
      }),
    );
    expect(snapshot.world_time).toBe('2034-05-17T18:20:00.000Z');
    expect(snapshot.created_at).toBe('2026-08-20T12:01:02.000Z');
  });

  it('позиции PRNG-потоков индексируются stream key и содержат неотрицательные индексы', () => {
    expect(decoded(withChecksum(BASE_SNAPSHOT)).prng_stream_positions['agent:rook']).toBe(12);
    expect(
      isValidationFailure(
        decodeSnapshot(
          withChecksum({ ...BASE_SNAPSHOT, prng_stream_positions: { 'agent:rook': -1 } }),
        ),
      ),
    ).toBe(true);
  });

  it.each([['NOT A KEY!!'], [''], ['../../etc/passwd'], ['Agent:Rook'], ['agent rook']])(
    'отвергает ключ PRNG-потока %j: объявленный pattern обязан исполняться, а не украшать схему',
    (key) => {
      // `Type.Record` порождает `patternProperties` БЕЗ `additionalProperties: false`, и тогда
      // JSON Schema разрешает любой ключ, не совпавший с шаблоном: объявление ключа как
      // namespaced id было декоративным.
      expect(
        isValidationFailure(
          decodeSnapshot(withChecksum({ ...BASE_SNAPSHOT, prng_stream_positions: { [key]: 1 } })),
        ),
        key,
      ).toBe(true);
    },
  );

  it('принимает корректный stream key рядом с отвергаемым', () => {
    expect(
      isValidationFailure(
        decodeSnapshot(
          withChecksum({ ...BASE_SNAPSHOT, prng_stream_positions: { 'agent:rook-2': 7 } }),
        ),
      ),
    ).toBe(false);
  });

  it('отвергает лишнее поле на верхнем уровне', () => {
    expect(issues({ ...withChecksum(BASE_SNAPSHOT), lease_owner: 'worker-1' })).toMatch(
      /lease_owner/,
    );
  });

  it('SnapshotSchema сериализуется в JSON Schema', () => {
    expect(() => JSON.stringify(SnapshotSchema)).not.toThrow();
    expect(() => JSON.stringify(BundleRefSchema)).not.toThrow();
  });
});
