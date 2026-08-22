/**
 * N-4 — состав отпечатка команды задан контрактом и не может разойтись с envelope.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMAND_ENVELOPE_KEYS,
  COMMAND_FINGERPRINT_EXCLUDED_KEYS,
  COMMAND_FINGERPRINT_KEYS,
  commandFingerprintSource,
  type Command,
} from './command.ts';

const command = (overrides: Partial<Command> = {}): Command => ({
  command_id: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  world_id: 'world:prototype',
  type: 'journey.start',
  schema_version: 1,
  actor_id: 'agent:rook',
  issued_at_world_time: '2028-04-26T06:00:00.000Z',
  expected_world_version: 0,
  correlation_id: 'corr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  payload: { route_id: 'route:yard-to-bridge' },
  ...overrides,
});

describe('состав отпечатка команды', () => {
  it('включённые и исключённые поля в сумме дают весь envelope', () => {
    // Добавленное в команду поле обязано заставить принять решение явно: попадает оно в
    // сравнение «та же команда» или нет. Тот же приём, что у области checksum снимка в I01.
    const covered = [...COMMAND_FINGERPRINT_KEYS, ...COMMAND_FINGERPRINT_EXCLUDED_KEYS].sort();
    expect(covered).toEqual([...COMMAND_ENVELOPE_KEYS].sort());
  });

  it('списки не пересекаются', () => {
    const included = new Set<string>(COMMAND_FINGERPRINT_KEYS);
    for (const key of COMMAND_FINGERPRINT_EXCLUDED_KEYS) {
      expect(included.has(key)).toBe(false);
    }
  });

  it('трассировочные поля не влияют на отпечаток', () => {
    const base = commandFingerprintSource(command());
    expect(
      commandFingerprintSource(
        command({
          command_id: 'cmd_01BX5ZZKBKACTAV9WEVGEMMVRZ',
          correlation_id: 'corr_01BX5ZZKBKACTAV9WEVGEMMVRZ',
          issued_at_world_time: '2028-05-01T12:00:00.000Z',
        }),
      ),
    ).toEqual(base);
  });

  it.each([
    ['actor_id', { actor_id: 'agent:kite' }],
    ['payload', { payload: { route_id: 'route:other' } }],
    ['expected_world_version', { expected_world_version: 7 }],
    ['caused_by_event_id', { caused_by_event_id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
  ])('семантическое поле %s влияет на отпечаток', (_label, overrides) => {
    expect(commandFingerprintSource(command(overrides as Partial<Command>))).not.toEqual(
      commandFingerprintSource(command()),
    );
  });
});
