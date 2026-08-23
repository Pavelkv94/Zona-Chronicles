/**
 * Bundles и профиль выполнения для мира прототипа — worker-ская половина того же знания, что у
 * CLI (I03).
 *
 * Не дублирование: сама сборка живёт в `@zona/simulation`, здесь только привязка к контенту и
 * чтение профиля хоста. Ровно эти две вещи принадлежат приложению — пакету запрещён `process`
 * (ADR-003) и не положено знать, какой именно мир он обслуживает.
 *
 * Нужны затем, чтобы прочитать ГЕНЕЗИСНЫЙ СНИМОК: `loadSnapshotAt` сверяет checksum с
 * переданными bundles, и снимок с чужими bundles обязан быть отвергнут (иначе проекция собралась
 * бы из мира, посчитанного по другим правилам).
 */
import { CONTENT_VERSION, PROTOTYPE_WORLD } from '@zona/content';
import type { DeterministicRuntimeProfile, Snapshot } from '@zona/contracts';
import { bundlesFor, deterministicRuntimeProfileFor } from '@zona/simulation';

export const worldBundles = (): Snapshot['bundles'] => bundlesFor(PROTOTYPE_WORLD, CONTENT_VERSION);

export const worldRuntimeProfile = (): DeterministicRuntimeProfile =>
  deterministicRuntimeProfileFor({
    nodeVersion: process.version.replace(/^v/, ''),
    icuVersion: process.versions['icu'] ?? 'unavailable',
  });
