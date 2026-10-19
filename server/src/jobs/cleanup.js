/**
 * LAYER 3 of the ephemerality rule: the destructive cleanup worker.
 *
 * Every 5 minutes (and once on boot) this job:
 *   1. retries the durable media-deletion outbox
 *   2. expires abandoned uploads and attachment rows, enqueueing keys transactionally
 *   3. deletes expired messages and social content after media ownership is queued
 *   4. removes orphaned/empty conversations and stale location/auth records
 *   5. logs aggregate deletion counts without file paths or message bodies
 *
 * Every run is wrapped in try/catch: a cleanup failure must never crash the server.
 */
import cron from 'node-cron';
import { query, execute, withTransaction } from '../db/pool.js';
import {
  MEDIA_DELETE_REASON,
  discardUnownedMedia,
  enqueueMediaDeletion,
  processMediaDeletionQueue,
  removeQueuedMedia
} from '../services/media-deletion.service.js';
import { purgeExpiredRefreshTokens } from '../services/auth.service.js';
import * as momentService from '../services/moment.service.js';
import * as postService from '../services/post.service.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('cleanup');

let task = null;
let running = false;

/** Emitter hook so the socket layer can tell clients a message just died. */
let broadcast = null;
export function setCleanupBroadcaster(fn) {
  broadcast = typeof fn === 'function' ? fn : null;
}

export async function runCleanup({ silent = false } = {}) {
  if (running) {
    log.debug('skipped - previous run still in progress');
    return { skipped: true };
  }
  running = true;
  const startedAt = Date.now();

  const stats = {
    deletedMessages: 0,
    deletedMoments: 0,
    deletedPosts: 0,
    deletedComments: 0,
    deletedLocations: 0,
    deletedEncounters: 0,
    deletedFiles: 0,
    deletedAttachments: 0,
    deletedConversations: 0,
    deletedTokens: 0,
    deletedVerificationTokens: 0,
    deletedPendingUploads: 0,
    failedMediaDeletions: 0,
    missingFiles: 0,
    durationMs: 0
  };

  try {
    // Durable outbox covers account deletion, reviewed evidence, ordinary
    // content retention and explicit profile-photo removal.
    const queuedMedia = await processMediaDeletionQueue(200);
    stats.deletedFiles += queuedMedia.deletedFiles;
    stats.missingFiles += queuedMedia.missingFiles;
    stats.failedMediaDeletions += queuedMedia.failedFiles;

    // Social media is first uploaded into a short-lived, owner-bound reservation.
    // If the composer is abandoned, queue its files before dropping the reservation.
    const pendingSocial = await query(
      `SELECT upload_id FROM pending_social_uploads
        WHERE expires_at <= NOW() ORDER BY expires_at LIMIT 200`
    );
    if (pendingSocial.length) {
      const candidateIds = pendingSocial.map((row) => String(row.upload_id));
      const placeholders = candidateIds.map(() => '?').join(',');
      const result = await withTransaction(async (conn) => {
        const [rows] = await conn.execute(
          `SELECT upload_id, file_key, thumb_key FROM pending_social_uploads
            WHERE upload_id IN (${placeholders}) AND expires_at <= NOW() FOR UPDATE`,
          candidateIds
        );
        if (!rows.length) return { uploads: 0, keys: [] };
        const keys = rows.flatMap((row) => [row.file_key, row.thumb_key].filter(Boolean));
        await enqueueMediaDeletion(conn, keys, MEDIA_DELETE_REASON.orphanedUpload);
        const ids = rows.map((row) => String(row.upload_id));
        const rowPlaceholders = ids.map(() => '?').join(',');
        const [deleted] = await conn.execute(
          `DELETE FROM pending_social_uploads WHERE upload_id IN (${rowPlaceholders})`, ids
        );
        return { uploads: deleted.affectedRows, keys };
      });
      stats.deletedPendingUploads = result.uploads;
      if (result.keys.length) {
        const removed = await removeQueuedMedia(result.keys, MEDIA_DELETE_REASON.orphanedUpload);
        stats.deletedFiles += removed.deletedFiles;
        stats.missingFiles += removed.missingFiles;
        stats.failedMediaDeletions += removed.failedFiles;
      }
    }

    // ---- 1. expired attachment rows and media belonging to expired messages
    const expiredAttachments = await query(
      `SELECT a.id FROM attachments a
        LEFT JOIN messages msg ON msg.id = a.message_id
       WHERE a.expires_at <= NOW() OR msg.expires_at <= NOW()
       ORDER BY a.id LIMIT 500`
    );
    if (expiredAttachments.length) {
      const candidateIds = expiredAttachments.map((row) => Number(row.id));
      const placeholders = candidateIds.map(() => '?').join(',');
      const result = await withTransaction(async (conn) => {
        const [rows] = await conn.execute(
          `SELECT a.id, a.file_path, a.thumb_path
             FROM attachments a LEFT JOIN messages msg ON msg.id = a.message_id
            WHERE a.id IN (${placeholders})
              AND (a.expires_at <= NOW() OR msg.expires_at <= NOW())
            FOR UPDATE`,
          candidateIds
        );
        if (!rows.length) return { deleted: 0, keys: [] };
        const keys = rows.flatMap((row) => [row.file_path, row.thumb_path].filter(Boolean));
        await enqueueMediaDeletion(conn, keys, MEDIA_DELETE_REASON.contentRemoved);
        const ids = rows.map((row) => Number(row.id));
        const rowPlaceholders = ids.map(() => '?').join(',');
        const [deleted] = await conn.execute(
          `DELETE FROM attachments WHERE id IN (${rowPlaceholders})`, ids
        );
        return { deleted: deleted.affectedRows, keys };
      });
      stats.deletedAttachments += result.deleted;
      if (result.keys.length) {
        const removed = await removeQueuedMedia(result.keys, MEDIA_DELETE_REASON.contentRemoved);
        stats.deletedFiles += removed.deletedFiles;
        stats.missingFiles += removed.missingFiles;
        stats.failedMediaDeletions += removed.failedFiles;
      }
    }

    // ---- 2. upload-only chat attachments abandoned before a message is sent
    const orphanUploads = await query(
      `SELECT id FROM attachments WHERE message_id IS NULL
        AND created_at < DATE_SUB(NOW(), INTERVAL 2 HOUR) ORDER BY id LIMIT 500`
    );
    if (orphanUploads.length) {
      const candidateIds = orphanUploads.map((row) => Number(row.id));
      const placeholders = candidateIds.map(() => '?').join(',');
      const result = await withTransaction(async (conn) => {
        const [rows] = await conn.execute(
          `SELECT id, file_path, thumb_path FROM attachments
            WHERE id IN (${placeholders}) AND message_id IS NULL
              AND created_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)
            FOR UPDATE`,
          candidateIds
        );
        if (!rows.length) return { deleted: 0, keys: [] };
        const keys = rows.flatMap((row) => [row.file_path, row.thumb_path].filter(Boolean));
        await enqueueMediaDeletion(conn, keys, MEDIA_DELETE_REASON.contentRemoved);
        const ids = rows.map((row) => Number(row.id));
        const rowPlaceholders = ids.map(() => '?').join(',');
        const [deleted] = await conn.execute(
          `DELETE FROM attachments WHERE id IN (${rowPlaceholders})`, ids
        );
        return { deleted: deleted.affectedRows, keys };
      });
      stats.deletedAttachments += result.deleted;
      if (result.keys.length) {
        const removed = await removeQueuedMedia(result.keys, MEDIA_DELETE_REASON.contentRemoved);
        stats.deletedFiles += removed.deletedFiles;
        stats.missingFiles += removed.missingFiles;
        stats.failedMediaDeletions += removed.failedFiles;
      }
    }

    // ---- 3. expired messages (collect ids first so clients can be notified)
    const expiredMessages = await query(
      `SELECT msg.id, msg.conversation_id FROM messages msg
        WHERE msg.expires_at <= NOW()
          AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = msg.id)
        ORDER BY msg.id LIMIT 5000`
    );
    if (expiredMessages.length) {
      const ids = expiredMessages.map((m) => Number(m.id));
      const ph = ids.map(() => '?').join(',');
      const res = await execute(`DELETE FROM messages WHERE id IN (${ph})`, ids);
      stats.deletedMessages = res.affectedRows;

      if (broadcast) {
        const byConv = new Map();
        for (const m of expiredMessages) {
          const cid = Number(m.conversation_id);
          if (!byConv.has(cid)) byConv.set(cid, []);
          byConv.get(cid).push(Number(m.id));
        }
        for (const [conversationId, messageIds] of byConv) {
          try {
            broadcast(conversationId, messageIds);
          } catch (err) {
            log.warn('message-expiry broadcast failed', { code: err.code || 'SOCKET_ERROR' });
          }
        }
      }
    }

    // ---- 4. orphaned / empty conversations older than 30 days
    const convRes = await execute(
      `DELETE c FROM conversations c
        WHERE c.created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`
    );
    stats.deletedConversations = convRes.affectedRows;

    // ---- 5. location hygiene.
    // message_locations cascade with their message, so they need no pass here.
    // Standing position data is different: it is the most sensitive thing we
    // store, so anything nobody could still act on is dropped.
    const staleLoc = await execute(
      'DELETE FROM user_locations WHERE updated_at < DATE_SUB(NOW(), INTERVAL 30 DAY)'
    );
    stats.deletedLocations = staleLoc.affectedRows;

    const oldEncounters = await execute(
      'DELETE FROM encounters WHERE last_met_at < DATE_SUB(NOW(), INTERVAL 30 DAY)'
    );
    stats.deletedEncounters = oldEncounters.affectedRows;

    // Expired boosts are just history; keep 7 days for the stats panel.
    await execute('DELETE FROM boosts WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)');

    // ---- 6. the social layer: 24-hour moments and posts.
    //
    // Each purge owns its media-key lookup and transactionally enqueues keys
    // before hard deletion. The bounded pass keeps lock time short; the queue
    // worker retries any storage unlink that fails.
    const moments = await momentService.purgeExpired({ limit: 2000 });
    stats.deletedMoments = moments.moments;
    stats.deletedFiles += moments.files;
    stats.missingFiles += moments.missingFiles;
    stats.failedMediaDeletions += moments.failedFiles;

    const posts = await postService.purgeExpired({ limit: 2000 });
    stats.deletedPosts = posts.posts;
    stats.deletedFiles += posts.files;
    stats.missingFiles += posts.missingFiles;
    stats.failedMediaDeletions += posts.failedFiles;

    // Comments normally die with their post via ON DELETE CASCADE; this sweeps
    // the stragglers (soft-deleted, or expired while the post lives on).
    const comments = await postService.purgeExpiredComments({ limit: 5000 });
    stats.deletedComments = comments.comments;

    // ---- 7. housekeeping: expired auth and verification tokens
    stats.deletedTokens = await purgeExpiredRefreshTokens();
    // Keep issuance history for the complete 15-minute resend window, then
    // remove expired/used/revoked codes so the token table does not grow forever.
    stats.deletedVerificationTokens = (await execute(
      'DELETE FROM verification_tokens WHERE created_at <= DATE_SUB(NOW(), INTERVAL 15 MINUTE) AND expires_at <= NOW()'
    )).affectedRows;

    stats.durationMs = Date.now() - startedAt;
    if (!silent || stats.deletedMessages || stats.deletedFiles || stats.deletedMoments || stats.deletedPosts || stats.failedMediaDeletions) {
      log.info('run complete', {
        deletedMessages: stats.deletedMessages,
        deletedMoments: stats.deletedMoments,
        deletedPosts: stats.deletedPosts,
        deletedPendingUploads: stats.deletedPendingUploads,
        deletedComments: stats.deletedComments,
        deletedFiles: stats.deletedFiles,
        missingFiles: stats.missingFiles,
        failedMediaDeletions: stats.failedMediaDeletions,
        durationMs: stats.durationMs
      });
    }
    return stats;
  } catch (err) {
    stats.durationMs = Date.now() - startedAt;
    log.error('run failed - server continues', { code: err.code || 'CLEANUP_ERROR', durationMs: stats.durationMs });
    return { ...stats, errorCode: err.code || 'CLEANUP_ERROR' };
  } finally {
    running = false;
  }
}

/** Backward-compatible helper; new ownership-changing paths enqueue in their DB transaction. */
export async function purgeFiles(files = []) {
  const keys = files.flatMap((file) => [file.filePath, file.thumbPath].filter(Boolean));
  const result = await discardUnownedMedia(keys, MEDIA_DELETE_REASON.contentRemoved);
  return result.deletedFiles;
}

export function startCleanupJob() {
  if (task) return task;
  if (!cron.validate(env.CLEANUP_CRON)) {
    log.error('invalid CLEANUP_CRON, falling back to */5 * * * *', { value: env.CLEANUP_CRON });
  }
  const expression = cron.validate(env.CLEANUP_CRON) ? env.CLEANUP_CRON : '*/5 * * * *';

  task = cron.schedule(expression, () => {
    runCleanup({ silent: true }).catch((err) => log.error('unhandled cleanup error', { code: err.code || 'CLEANUP_ERROR' }));
  });

  log.info('scheduled', { cron: expression, ttlHours: env.MESSAGE_TTL_HOURS });

  // Run once on boot so a restart immediately reaps anything that lapsed while down.
  runCleanup({ silent: false }).catch((err) => log.error('boot cleanup failed', { code: err.code || 'CLEANUP_ERROR' }));

  return task;
}

export function stopCleanupJob() {
  if (task) {
    task.stop();
    task = null;
    log.info('stopped');
  }
}
