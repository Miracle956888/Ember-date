/**
 * LAYER 3 of the ephemerality rule: the destructive cleanup worker.
 *
 * Every 5 minutes (and once on boot) this job:
 *   1. selects expired attachment rows and unlinks each file from disk (ENOENT ignored)
 *   2. deletes the expired attachment rows
 *   3. deletes the expired message rows
 *   4. deletes orphaned/empty conversations older than 30 days
 *   5. logs { deletedMessages, deletedFiles, durationMs }
 *
 * Every run is wrapped in try/catch: a cleanup failure must never crash the server.
 */
import cron from 'node-cron';
import { query, execute } from '../db/pool.js';
import { storage } from '../services/storage.service.js';
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
    missingFiles: 0,
    durationMs: 0
  };

  try {
    // ---- 1. expired attachments: which messages/conversations are affected?
    const expiredAttachments = await query(
      `SELECT a.id, a.file_path, a.thumb_path, a.message_id, msg.conversation_id
         FROM attachments a
    LEFT JOIN messages msg ON msg.id = a.message_id
        WHERE a.expires_at <= NOW()`
    );

    for (const att of expiredAttachments) {
      for (const key of [att.file_path, att.thumb_path]) {
        if (!key) continue;
        try {
          const removed = await storage.remove(key);
          if (removed) stats.deletedFiles += 1;
          else stats.missingFiles += 1; // ENOENT - already gone, fine
        } catch (err) {
          log.warn('failed to unlink file', { key, error: err.message });
        }
      }
    }

    // ---- 2. delete expired attachment rows
    if (expiredAttachments.length) {
      const res = await execute('DELETE FROM attachments WHERE expires_at <= NOW()');
      stats.deletedAttachments = res.affectedRows;
    }

    // ---- also drop orphan uploads never attached to a message (abandoned composer)
    const orphanUploads = await query(
      `SELECT id, file_path, thumb_path FROM attachments
        WHERE message_id IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)`
    );
    for (const att of orphanUploads) {
      for (const key of [att.file_path, att.thumb_path]) {
        if (!key) continue;
        try {
          if (await storage.remove(key)) stats.deletedFiles += 1;
        } catch (err) {
          log.warn('failed to unlink orphan upload', { key, error: err.message });
        }
      }
    }
    if (orphanUploads.length) {
      const ids = orphanUploads.map((a) => a.id);
      const ph = ids.map(() => '?').join(',');
      const res = await execute(`DELETE FROM attachments WHERE id IN (${ph})`, ids);
      stats.deletedAttachments += res.affectedRows;
    }

    // ---- 3. expired messages (collect ids first so clients can be notified)
    const expiredMessages = await query(
      'SELECT id, conversation_id FROM messages WHERE expires_at <= NOW() LIMIT 5000'
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
            log.warn('broadcast failed', { conversationId, error: err.message });
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
    // Both purges own their media unlinking, because only they know which
    // storage keys belong to which row. Each is capped per run so a backlog
    // drains over several passes instead of holding a long transaction — the
    // job runs every 5 minutes, so a cap of 2000 clears 24k rows an hour.
    const moments = await momentService.purgeExpired({ limit: 2000 });
    stats.deletedMoments = moments.moments;
    stats.deletedFiles += moments.files;

    const posts = await postService.purgeExpired({ limit: 2000 });
    stats.deletedPosts = posts.posts;
    stats.deletedFiles += posts.files;

    // Comments normally die with their post via ON DELETE CASCADE; this sweeps
    // the stragglers (soft-deleted, or expired while the post lives on).
    const comments = await postService.purgeExpiredComments({ limit: 5000 });
    stats.deletedComments = comments.comments;

    // ---- 7. housekeeping: dead refresh tokens
    stats.deletedTokens = await purgeExpiredRefreshTokens();

    stats.durationMs = Date.now() - startedAt;
    if (!silent || stats.deletedMessages || stats.deletedFiles || stats.deletedMoments || stats.deletedPosts) {
      log.info('run complete', {
        deletedMessages: stats.deletedMessages,
        deletedMoments: stats.deletedMoments,
        deletedPosts: stats.deletedPosts,
        deletedComments: stats.deletedComments,
        deletedFiles: stats.deletedFiles,
        durationMs: stats.durationMs
      });
    }
    return stats;
  } catch (err) {
    stats.durationMs = Date.now() - startedAt;
    log.error('run failed - server continues', { error: err.message, durationMs: stats.durationMs });
    return { ...stats, error: err.message };
  } finally {
    running = false;
  }
}

/** Immediately delete specific files (used by unmatch / clear-chat). */
export async function purgeFiles(files = []) {
  let deleted = 0;
  for (const f of files) {
    for (const key of [f.filePath, f.thumbPath]) {
      if (!key) continue;
      try {
        if (await storage.remove(key)) deleted += 1;
      } catch (err) {
        log.warn('purgeFiles failed', { key, error: err.message });
      }
    }
  }
  return deleted;
}

export function startCleanupJob() {
  if (task) return task;
  if (!cron.validate(env.CLEANUP_CRON)) {
    log.error('invalid CLEANUP_CRON, falling back to */5 * * * *', { value: env.CLEANUP_CRON });
  }
  const expression = cron.validate(env.CLEANUP_CRON) ? env.CLEANUP_CRON : '*/5 * * * *';

  task = cron.schedule(expression, () => {
    runCleanup({ silent: true }).catch((err) => log.error('unhandled cleanup error', { error: err.message }));
  });

  log.info('scheduled', { cron: expression, ttlHours: env.MESSAGE_TTL_HOURS });

  // Run once on boot so a restart immediately reaps anything that lapsed while down.
  runCleanup({ silent: false }).catch((err) => log.error('boot cleanup failed', { error: err.message }));

  return task;
}

export function stopCleanupJob() {
  if (task) {
    task.stop();
    task = null;
    log.info('stopped');
  }
}
