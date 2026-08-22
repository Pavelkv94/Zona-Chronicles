import type { Migration } from './types.ts';
import { bootstrapMigration } from './0001-bootstrap.ts';
import { canonicalCoreMigration } from './0002-canonical-core.ts';
import { revokePublicDefaultsMigration } from './0003-revoke-public-defaults.ts';
import { commandFingerprintMigration } from './0004-command-fingerprint.ts';
import { eventChecksumMigration } from './0005-event-checksum.ts';
import { commandAttemptRejectionsMigration } from './0006-command-attempt-rejections.ts';
import { schedulerAndSnapshotsMigration } from './0007-scheduler-and-snapshots.ts';

export type { Migration } from './types.ts';

/**
 * Реестр миграций — явный упорядоченный массив, а не сканирование каталога:
 * порядок обязан быть детерминированным и ревьюируемым (I00-T04).
 *
 * Новая миграция дописывается в конец с id, большим предыдущего. Уже
 * применённая миграция не редактируется и не переставляется — `runMigrations`
 * фиксирует изменение checksum/name как `MIGRATION_CHECKSUM_MISMATCH` /
 * `MIGRATION_NAME_MISMATCH`.
 */
export const migrations: readonly Migration[] = [
  bootstrapMigration,
  canonicalCoreMigration,
  revokePublicDefaultsMigration,
  commandFingerprintMigration,
  eventChecksumMigration,
  commandAttemptRejectionsMigration,
  schedulerAndSnapshotsMigration,
];
