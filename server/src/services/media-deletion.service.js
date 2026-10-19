/**
 * Durable deletion outbox for private local media. Callers enqueue keys inside
 * the same DB transaction that removes their owning row; the worker can then
 * retry transient storage failures without keeping the content readable.
 */
import { execute, query, withTransaction } from '../db/pool.js';
import { storage } from './storage.service.js';
import { logger } from '../utils/logger.js';

const log = logger.child('media-delete');

export const MEDIA_DELETE_REASON = Object.freeze({
  accountDeleted: 'account_deleted',
  verificationReviewed: 'verification_reviewed',
  contentRemoved: 'content_removed',
  profilePhotoRemoved: 'profile_photo_removed',
  orphanedUpload: 'orphaned_upload'
});

const VALID_REASONS = new Set(Object.values(MEDIA_DELETE_REASON));

export function normalizeMediaKeys(values) {
  const keys = [...new Set((Array.isArray(values) ? values : [values])
    .filter((value) => value !== null && value !== undefined && String(value).length)
    .map((value) => String(value)))];
  for (const key of keys) {
    if (key.length > 255 || key.startsWith('/') || key.includes('\\') ||
        key.split('/').some((part) => !part || part === '.' || part === '..') ||
        !/^[A-Za-z0-9._/-]+$/.test(key)) {
      throw new TypeError('Refusing to enqueue an unsafe media storage key.');
    }
  }
  return keys;
}

/** Must be called using the caller's transaction connection before unlinking DB ownership. */
export async function enqueueMediaDeletion(conn, values, reason) {
  if (!VALID_REASONS.has(reason)) throw new TypeError('Unknown media deletion reason.');
  const keys = normalizeMediaKeys(values);
  for (const key of keys) {
    await conn.execute(
      'INSERT IGNORE INTO media_deletion_queue (file_key, reason) VALUES (?, ?)',
      [key, reason]
    );
  }
  return keys;
}

async function removeOne(key, reason, queueId = null) {
  try {
    const removed = await storage.remove(key);
    if (queueId === null) {
      await execute('DELETE FROM media_deletion_queue WHERE file_key = ? AND reason = ?', [key, reason]);
    } else {
      await execute('DELETE FROM media_deletion_queue WHERE id = ?', [queueId]);
    }
    return { removed: Boolean(removed), failed: false };
  } catch (err) {
    const update = queueId === null
      ? 'UPDATE media_deletion_queue SET attempts = attempts + 1, last_attempt_at = NOW() WHERE file_key = ? AND reason = ?'
      : 'UPDATE media_deletion_queue SET attempts = attempts + 1, last_attempt_at = NOW() WHERE id = ?';
    const params = queueId === null ? [key, reason] : [queueId];
    await execute(update, params).catch(() => {});
    log.warn('queued media unlink will retry', { code: err.code || 'STORAGE_ERROR' });
    return { removed: false, failed: true };
  }
}

/** Try newly queued keys immediately; a failed unlink stays durable for the worker. */
export async function removeQueuedMedia(values, reason) {
  if (!VALID_REASONS.has(reason)) throw new TypeError('Unknown media deletion reason.');
  const keys = normalizeMediaKeys(values);
  const stats = { deletedFiles: 0, missingFiles: 0, failedFiles: 0 };
  for (const key of keys) {
    const result = await removeOne(key, reason);
    if (result.failed) stats.failedFiles += 1;
    else if (result.removed) stats.deletedFiles += 1;
    else stats.missingFiles += 1;
  }
  return stats;
}

/** Best-effort cleanup for a file that never became an owned media row. */
export async function discardUnownedMedia(values, reason = MEDIA_DELETE_REASON.orphanedUpload) {
  const keys = normalizeMediaKeys(values);
  if (!keys.length) return { deletedFiles: 0, missingFiles: 0, failedFiles: 0 };
  await withTransaction((conn) => enqueueMediaDeletion(conn, keys, reason));
  return removeQueuedMedia(keys, reason);
}

/** Bounded worker pass, safe to run concurrently because storage deletion is idempotent. */
export async function processMediaDeletionQueue(limit = 200) {
  const max = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 200));
  const items = await query('SELECT id, file_key, reason FROM media_deletion_queue ORDER BY id LIMIT ?', [max]);
  const stats = { deletedFiles: 0, missingFiles: 0, failedFiles: 0 };
  for (const item of items) {
    const result = await removeOne(String(item.file_key), String(item.reason), Number(item.id));
    if (result.failed) stats.failedFiles += 1;
    else if (result.removed) stats.deletedFiles += 1;
    else stats.missingFiles += 1;
  }
  return stats;
}
