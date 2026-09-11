/**
 * report.service — one reporting funnel for every surface.
 *
 * The audit flagged the old reporting as write-only: rows went in and nothing
 * could come out. This is the replacement primitive. Phase 6 wires the content
 * surfaces (posts, moments, comments) into it; Phase 7 builds the moderator
 * queue on top of the same table, and Phase 8 the dashboard. Getting the
 * write side right now means those phases add reads, not a rewrite.
 *
 * Two properties matter most:
 *
 * 1. **A snapshot is taken at report time.** Reported content is ephemeral —
 *    a moment reported at 23:59 is gone by morning. Without a copy, every
 *    report of expired content would reach a moderator as an empty row, which
 *    is precisely how ephemeral products end up unmoderatable. The snapshot is
 *    the evidence and it deliberately outlives the content.
 * 2. **Reporting is idempotent per reporter.** UNIQUE (reporter_id,
 *    target_type, target_id) means a double tap does not create a second
 *    report or a second queue entry; it just confirms.
 */
import { queryOne, execute } from '../db/pool.js';
import { badRequest, notFound } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { notify } from './notification.service.js';

const log = logger.child('reports');

export const REPORT_REASONS = [
  'scam',
  'fake',
  'impersonation',
  'harassment',
  'spam',
  'threats',
  'inappropriate',
  'ncii',
  'other'
];

export const REPORT_TARGETS = ['profile', 'message', 'photo', 'post', 'moment', 'comment'];

/**
 * Reports that describe an ongoing danger jump the queue. NCII and credible
 * threats are time-critical in a way that spam simply is not, and a flat queue
 * would bury them behind a hundred "this is an advert" reports.
 */
const PRIORITY = {
  ncii: 3,
  threats: 3,
  harassment: 2,
  impersonation: 2,
  scam: 1,
  fake: 1,
  inappropriate: 1,
  spam: 0,
  other: 0
};

/**
 * Resolve what is being reported: who owns it and what it said.
 *
 * Deliberately ignores `deleted_at` and `expires_at`. You must be able to
 * report something that has just expired or that the author deleted the second
 * they saw you screenshot it — that is the most likely moment for a report,
 * not the least.
 */
async function resolveTarget(type, id) {
  switch (type) {
    case 'profile': {
      const row = await queryOne(
        'SELECT id, display_name, username, bio FROM users WHERE id = ? LIMIT 1',
        [id]
      );
      return row
        ? { ownerId: Number(row.id), snapshot: { username: row.username, displayName: row.display_name, bio: row.bio } }
        : null;
    }
    case 'message': {
      const row = await queryOne(
        'SELECT id, sender_id, body, is_encrypted FROM messages WHERE id = ? LIMIT 1',
        [id]
      );
      if (!row) return null;
      return {
        ownerId: Number(row.sender_id),
        // An E2EE message has no server-readable body, and we do not pretend
        // otherwise. The moderator sees that it existed and who sent it; the
        // reporter is asked to describe it in `details`.
        snapshot: row.is_encrypted
          ? { encrypted: true, note: 'End-to-end encrypted; content not readable by the server.' }
          : { body: row.body }
      };
    }
    case 'photo': {
      const row = await queryOne('SELECT id, user_id, url FROM user_photos WHERE id = ? LIMIT 1', [id]);
      return row ? { ownerId: Number(row.user_id), snapshot: { url: row.url } } : null;
    }
    case 'post': {
      const row = await queryOne('SELECT id, user_id, body, created_at FROM posts WHERE id = ? LIMIT 1', [id]);
      return row
        ? { ownerId: Number(row.user_id), snapshot: { body: row.body, createdAt: row.created_at } }
        : null;
    }
    case 'moment': {
      const row = await queryOne(
        'SELECT id, user_id, kind, body, media_url, created_at FROM moments WHERE id = ? LIMIT 1',
        [id]
      );
      return row
        ? {
            ownerId: Number(row.user_id),
            snapshot: { kind: row.kind, body: row.body, mediaUrl: row.media_url, createdAt: row.created_at }
          }
        : null;
    }
    case 'comment': {
      const row = await queryOne(
        'SELECT id, user_id, post_id, body, created_at FROM comments WHERE id = ? LIMIT 1',
        [id]
      );
      return row
        ? {
            ownerId: Number(row.user_id),
            snapshot: { body: row.body, postId: Number(row.post_id), createdAt: row.created_at }
          }
        : null;
    }
    default:
      return null;
  }
}

/**
 * File a report.
 *
 * Returns the same success shape whether the report is new or a repeat, so the
 * UI can always say "thanks, we're on it" — a reporter should never be told
 * their report "already exists", which reads as a brush-off.
 */
export async function report(reporterId, { targetType, targetId, reason, details = null }) {
  if (!REPORT_TARGETS.includes(targetType)) throw badRequest('Unknown report target.');
  if (!REPORT_REASONS.includes(reason)) throw badRequest('Choose a reason for the report.');

  const target = await resolveTarget(targetType, targetId);
  if (!target) throw notFound('That content is no longer available.');

  if (Number(target.ownerId) === Number(reporterId)) {
    throw badRequest('You cannot report your own content.');
  }

  // Whether this is a repeat is decided by an explicit read, not by inspecting
  // the write. `insertId` is set to the *existing* row on the duplicate-key
  // path, and `affectedRows` is 1 for a fresh insert but also 1 for a no-op
  // update in MariaDB — neither can distinguish the two cases reliably.
  const already = await hasReported(reporterId, targetType, targetId);

  await execute(
    `INSERT INTO content_reports
       (reporter_id, target_type, target_id, reported_user_id, reason, details, priority, snapshot)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       reason = VALUES(reason),
       details = VALUES(details),
       priority = VALUES(priority)`,
    [
      reporterId,
      targetType,
      targetId,
      target.ownerId,
      reason,
      details ? String(details).slice(0, 1000) : null,
      PRIORITY[reason] ?? 0,
      JSON.stringify(target.snapshot).slice(0, 60_000)
    ]
  );

  log.info('report filed', { targetType, targetId, reason, priority: PRIORITY[reason] ?? 0 });

  // Close the loop with the reporter. Safety notifications are never gated on
  // preferences, and this one goes to the REPORTER, never the reported user --
  // telling someone they have been reported would endanger the reporter.
  await notify({
    userId: reporterId,
    kind: 'safety',
    targetType,
    targetId: Number(targetId),
    href: '/settings',
    body: 'Thanks for the report. Our team is reviewing it.',
    groupKey: `safety:${targetType}:${targetId}:${reporterId}`
  });

  return {
    reported: true,
    targetType,
    targetId: Number(targetId),
    reason,
    isNew: !already,
    message: 'Thanks for letting us know. Our team will review this.'
  };
}

/** Has this viewer already reported this object? Drives the UI state. */
export async function hasReported(reporterId, targetType, targetId) {
  const row = await queryOne(
    'SELECT 1 AS x FROM content_reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
    [reporterId, targetType, targetId]
  );
  return Boolean(row);
}

/** Open-report count against a user. Phase 8 surfaces this on the dashboard. */
export async function openReportsAgainst(userId) {
  const row = await queryOne(
    "SELECT COUNT(*) AS n FROM content_reports WHERE reported_user_id = ? AND status IN ('open','reviewing')",
    [userId]
  );
  return Number(row?.n || 0);
}
