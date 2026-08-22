import { describe, expect, it } from 'vitest';
import { canonicalChecksum, requireChecksum } from './checksum.ts';
import { CommandSchema } from './command.ts';
import { ENVELOPE_SCHEMA_VERSION } from './command.ts';
import {
  PUBLIC_SCHEMA_IDS,
  SCHEMA_BUNDLE_VERSION,
  schemaBundleContent,
  schemaBundleRef,
} from './schema-bundle.ts';
import { SnapshotSchema, bundleRefFor, verifyBundleRef } from './snapshot.ts';
import { isValidationFailure } from './validation.ts';
import { WorldEventSchema } from './world-event.ts';

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schemaBundleContent())) as Record<string, unknown>;
}

function checksumOf(content: unknown): string {
  return requireChecksum(content, 'schema bundle probe');
}

describe('M3: schema bundle адресуется по содержимому схем, а не по их $id (A9, §7)', () => {
  it('содержимое bundle — сами JSON Schema документы, со структурой внутри', () => {
    const content = schemaBundleContent();
    const snapshot = content[SnapshotSchema.$id!] as Record<string, unknown>;
    expect(snapshot['additionalProperties']).toBe(false);
    expect(Object.keys(snapshot['properties'] as object)).toContain('canonical_state');
  });

  it('перечисляет ровно публичные схемы контракта', () => {
    expect(Object.keys(schemaBundleContent()).sort()).toEqual([...PUBLIC_SCHEMA_IDS].sort());
    expect([...PUBLIC_SCHEMA_IDS].sort()).toEqual(
      [CommandSchema.$id, WorldEventSchema.$id, SnapshotSchema.$id].sort(),
    );
  });

  it('checksum НЕ равен checksum от одних $id: прежняя редакция не видела изменения схем', () => {
    // Ровно то, что считал apps/cli до M3: три строки $id. Изменение любой схемы при той же
    // версии оставляло это значение неизменным.
    const idsOnly = {
      command: CommandSchema.$id,
      world_event: WorldEventSchema.$id,
      snapshot: SnapshotSchema.$id,
    };
    expect(checksumOf(idsOnly)).toBe(
      'sha256:de92dd4564e825e0a9eaf3b35c5078166880bf92a75aad6baa9fdd7eeaa77124',
    );
    expect(checksumOf(schemaBundleContent())).not.toBe(checksumOf(idsOnly));
  });

  it('снятие additionalProperties: false у snapshot меняет checksum', () => {
    const mutated = clone();
    const snapshot = mutated[SnapshotSchema.$id!] as Record<string, unknown>;
    expect(snapshot['additionalProperties']).toBe(false);
    delete snapshot['additionalProperties'];
    expect(checksumOf(mutated)).not.toBe(checksumOf(schemaBundleContent()));
  });

  it('добавление поля в схему команды меняет checksum', () => {
    // С I02B `CommandSchema` — дискриминированный union, поэтому поля живут в вариантах, а не
    // на верхнем уровне. Правка идёт в первый вариант: свойство «изменение схемы меняет
    // checksum» обязано держаться и для union, иначе bundle перестал бы адресовать содержимое.
    const mutated = clone();
    const command = mutated[CommandSchema.$id!] as Record<string, unknown>;
    const variants = command['anyOf'] as Record<string, unknown>[];
    expect(variants.length).toBeGreaterThan(1);
    const properties = variants[0]!['properties'] as Record<string, unknown>;
    expect(Object.keys(properties)).toContain('command_id');
    properties['lease_owner'] = { type: 'string' };
    expect(checksumOf(mutated)).not.toBe(checksumOf(schemaBundleContent()));
  });

  it('смена pattern внутри вложенной схемы меняет checksum', () => {
    const before = JSON.stringify(schemaBundleContent());
    const patched = JSON.parse(
      before.replace('^cmd_[0-9A-HJKMNP-TV-Z]{26}$', '^cmd_[0-9A-Z]{26}$'),
    ) as unknown;
    expect(JSON.stringify(patched)).not.toBe(before);
    expect(checksumOf(patched)).not.toBe(checksumOf(schemaBundleContent()));
  });

  it('checksum стабилен между вызовами: содержимое не зависит от порядка обхода', () => {
    expect(checksumOf(schemaBundleContent())).toBe(checksumOf(schemaBundleContent()));
  });

  it('verifyBundleRef принимает настоящее содержимое и отвергает мутированное (A9)', () => {
    const ref = schemaBundleRef();
    expect(ref.version).toBe(SCHEMA_BUNDLE_VERSION);
    expect(isValidationFailure(verifyBundleRef(schemaBundleContent(), ref))).toBe(false);

    const mutated = clone();
    const snapshot = mutated[SnapshotSchema.$id!] as Record<string, unknown>;
    delete snapshot['additionalProperties'];
    // Версия та же — именно эта ловушка и есть смысл A9.
    const result = verifyBundleRef(mutated, ref);
    expect(isValidationFailure(result)).toBe(true);
    if (isValidationFailure(result)) {
      expect(result.errors[0]?.message).toMatch(/checksum/i);
    }
  });

  it('содержимое канонически сериализуемо: bundle, который нельзя адресовать, не bundle', () => {
    const result = canonicalChecksum(schemaBundleContent());
    expect('checksum' in result).toBe(true);
    expect(() => bundleRefFor(SCHEMA_BUNDLE_VERSION, schemaBundleContent())).not.toThrow();
  });

  it('мажор версии bundle совпадает с ENVELOPE_SCHEMA_VERSION', () => {
    expect(SCHEMA_BUNDLE_VERSION.split('.')[0]).toBe(String(ENVELOPE_SCHEMA_VERSION));
  });
});
