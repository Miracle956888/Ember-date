/**
 * admin.service — the moderation read/write side.
 *
 * Phase 6 built the reporting funnel as write-only on purpose and left the
 * read side to this phase. This module is that read side plus the enforcement
 * actions, and it holds three properties that the rest of the app depends on:
 *
 * 1. **Every state-changing action is audited.** `logAction` is called inside
 *    the same code path as the mutation, never by the caller as an afterthought,
 *    so it is not possible to suspend someone without leaving a record. The
 *    audit row captures actor, action, target, a human reason and the IP.
 *
 * 2. **Moderators and admins are different.** Moderators handle the queue and
 *    take content down. Only admins touch roles, issue permanent bans or read
 *    the audit log. Enforcement lives in the route layer (`requireRole`), but
 *    the service also refuses privilege escalation independently so a wiring
 *    mistake upstream cannot become an escalation bug.
 *
 * 3. **Reported content outlives itself.** Reports carry a snapshot taken at
 *    report time (see report.service). The queue reads that snapshot, so a
 *    moment reported at 23:59 is still reviewable at 09:00 even though the
 *    content itself expired hours earlier.
 */

import { query, queryOne, execute } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { logger as log } from '../utils/logger.js';
import { rankOf } from '../middleware/auth.js';

const REPORT_STATUSES = ['open', 'reviewing', 'actioned', 'dismissed'];
const CONTENT_TYPES = ['post', 'moment', 'comment'];

/** Actions that only an admin may perform, regardless of route wiring. */
const ADMIN_ONLY = new Set(['user.role', 'user.ban', 'user.restore_banned', 'audit.read']);

// ------------------------------------------------------------- audit trail

/**
 * Append to the audit log.
 *
 * Deliberately awaited by its callers rather than fire-and-forget: if we
 * cannot record *that* a moderator acted, we do not want the action to look
 * like it silently succeeded. The one thing we never do is let a logging
 * failure roll back an enforcement action that already landed, so writes that
 * happen after the mutation swallow their error and shout in the log instead.
 */
export async function logAction(actorId, action, { targetType = null, targetId = null, detail = null, ip = null } = {}) {
  try {
    await execute(
      'INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, detail, ip) VALUES (?,?,?,?,?,?)',
      [actorId, action, targetType, targetId ?? null, detail ? String(detail).slice(0, 500) : null, ip ? String(ip).slice(0, 64) : null]
    );
  } catch (err) {
    log.error('audit write failed', { action, targetType, targetId, err: err.message });
  }
}

/** Read the audit trail. Admin-only; moderators cannot audit themselves. */
export async function listAuditLog({ limit = 50, before = null, actorId = null, action = null } = {}) {
  const lim = clampLimit(limit);
  const where = [];
  const params = [];
  if (before) {
    where.push('a.id < ?');
    params.push(Number(before));
  }
  if (actorId) {
    where.push('a.actor_id = ?');
    params.push(Number(actorId));
  }
  if (action) {
    where.push('a.action = ?');
    params.push(String(action));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await query(
    `SELECT a.id, a.actor_id, a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at,
            u.username AS actor_username, u.display_name AS actor_name
       FROM admin_audit_log a
       JOIN users u ON u.id = a.actor_id
       ${clause}
      ORDER BY a.id DESC
      LIMIT ${lim}`,
    params
  );

  return {
    entries: rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id === null ? null : Number(r.target_id),
      detail: r.detail,
      ip: r.ip,
      createdAt: r.created_at,
      actor: { id: Number(r.actor_id), username: r.actor_username, displayName: r.actor_name }
    })),
    nextCursor: rows.length === lim ? Number(rows[rows.length - 1].id) : null
  };
}

// ------------------------------------------------------------ report queue

/**
 * The moderator queue.
 *
 * Ordered by priority then age so threats and NCII surface above spam, and
 * within a priority band the oldest report is handled first. Keyset paginated
 * on (priority, id) rather than OFFSET: the queue mutates while it is being
 * worked, and OFFSET would skip rows as items are actioned out from under it.
 */
export async function listReports({ status = 'open', limit = 25, cursor = null, targetType = null, reason = null } = {}) {
  const lim = clampLimit(limit);
  const where = [];
  const params = [];

  if (status && status !== 'all') {
    if (!REPORT_STATUSES.includes(status)) throw badRequest('Unknown report status.');
    where.push('r.status = ?');
    params.push(status);
  }
  if (targetType) {
    where.push('r.target_type = ?');
    params.push(targetType);
  }
  if (reason) {
    where.push('r.reason = ?');
    params.push(reason);
  }
  if (cursor && cursor.priority !== undefined && cursor.id !== undefined) {
    // Matches ORDER BY priority DESC, id ASC.
    where.push('(r.priority < ? OR (r.priority = ? AND r.id > ?))');
    params.push(Number(cursor.priority), Number(cursor.priority), Number(cursor.id));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await query(
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.priority,
            r.snapshot, r.created_at, r.handled_at, r.resolution,
            rep.id AS reporter_id, rep.username AS reporter_username, rep.display_name AS reporter_name,
            ru.id AS reported_id, ru.username AS reported_username, ru.display_name AS reported_name,
            ru.status AS reported_status, ru.role AS reported_role,
            h.username AS handler_username
       FROM content_reports r
       JOIN users rep ON rep.id = r.reporter_id
       LEFT JOIN users ru ON ru.id = r.reported_user_id
       LEFT JOIN users h ON h.id = r.handled_by
       ${clause}
      ORDER BY r.priority DESC, r.id ASC
      LIMIT ${lim}`,
    params
  );

  const last = rows[rows.length - 1];
  return {
    reports: rows.map(shapeReport),
    nextCursor: rows.length === lim && last ? { priority: Number(last.priority), id: Number(last.id) } : null
  };
}

/** One report with its evidence snapshot and the reported user's history. */
export async function getReport(id) {
  const r = await queryOne(
    `SELECT r.*, rep.username AS reporter_username, rep.display_name AS reporter_name,
            ru.username AS reported_username, ru.display_name AS reported_name,
            ru.status AS reported_status, ru.role AS reported_role,
            h.username AS handler_username
       FROM content_reports r
       JOIN users rep ON rep.id = r.reporter_id
       LEFT JOIN users ru ON ru.id = r.reported_user_id
       LEFT JOIN users h ON h.id = r.handled_by
      WHERE r.id = ? LIMIT 1`,
    [Number(id)]
  );
  if (!r) throw notFound('That report no longer exists.');

  const shaped = shapeReport(r);
  shaped.reporterId = Number(r.reporter_id);

  // Prior reports against the same user are the single most useful signal a
  // moderator has: one report is noise, five is a pattern.
  if (r.reported_user_id) {
    const hist = await queryOne(
      `SELECT COUNT(*) AS total,
              SUM(status = 'actioned') AS actioned,
              SUM(status IN ('open','reviewing')) AS pending
         FROM content_reports WHERE reported_user_id = ?`,
      [r.reported_user_id]
    );
    shaped.history = {
      total: Number(hist?.total || 0),
      actioned: Number(hist?.actioned || 0),
      pending: Number(hist?.pending || 0)
    };
  }
  return shaped;
}

function shapeReport(r) {
  let snapshot = null;
  if (r.snapshot) {
    try {
      snapshot = JSON.parse(r.snapshot);
    } catch {
      snapshot = { note: 'Snapshot could not be read.' };
    }
  }
  return {
    id: Number(r.id),
    targetType: r.target_type,
    targetId: Number(r.target_id),
    reason: r.reason,
    details: r.details,
    status: r.status,
    priority: Number(r.priority),
    snapshot,
    createdAt: r.created_at,
    handledAt: r.handled_at,
    resolution: r.resolution,
    handledBy: r.handler_username || null,
    reporter: { username: r.reporter_username, displayName: r.reporter_name },
    reportedUser: r.reported_username
      ? {
          id: Number(r.reported_id ?? r.reported_user_id),
          username: r.reported_username,
          displayName: r.reported_name,
          status: r.reported_status,
          role: r.reported_role
        }
      : null
  };
}

/** Move a report through the queue. Always audited. */
export async function resolveReport(actor, reportId, { status, resolution = null, ip = null }) {
  if (!REPORT_STATUSES.includes(status)) throw badRequest('Unknown report status.');

  const existing = await queryOne('SELECT id, status FROM content_reports WHERE id = ? LIMIT 1', [Number(reportId)]);
  if (!existing) throw notFound('That report no longer exists.');

  await execute(
    `UPDATE content_reports
        SET status = ?, resolution = ?, handled_by = ?, handled_at = NOW()
      WHERE id = ?`,
    [status, resolution ? String(resolution).slice(0, 255) : null, actor.id, Number(reportId)]
  );

  await logAction(actor.id, `report.${status}`, {
    targetType: 'report',
    targetId: Number(reportId),
    detail: resolution || `${existing.status} → ${status}`,
    ip
  });

  return getReport(reportId);
}

// -------------------------------------------------------------- user admin

/**
 * User search for the dashboard.
 *
 * Exact username/email matches are checked first and separately from the
 * prefix scan so that looking up a known handle stays on the unique index
 * instead of degrading into the `LIKE` path.
 */
export async function searchUsers({ q = '', status = null, role = null, limit = 25, offset = 0 } = {}) {
  const lim = clampLimit(limit);
  const off = Math.max(0, Number(offset) || 0);
  const where = [];
  const params = [];

  const term = String(q || '').trim();
  if (term) {
    // Anchored LIKE so the index on username is usable for the common case.
    where.push('(u.username = ? OR u.email = ? OR u.username LIKE ? OR u.display_name LIKE ?)');
    params.push(term.toLowerCase(), term.toLowerCase(), `${term}%`, `${term}%`);
  }
  if (status) {
    where.push('u.status = ?');
    params.push(status);
  }
  if (role) {
    where.push('u.role = ?');
    params.push(role);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.email, u.avatar_url, u.status, u.role,
            u.is_verified, u.email_verified_at, u.phone_verified_at, u.suspended_until,
            u.status_reason, u.created_at, u.last_seen_at, u.is_online, u.profile_completion,
            (SELECT COUNT(*) FROM content_reports cr
              WHERE cr.reported_user_id = u.id AND cr.status IN ('open','reviewing')) AS open_reports
       FROM users u
       ${clause}
      ORDER BY u.created_at DESC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );

  const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM users u ${clause}`, params);

  return {
    users: rows.map(shapeAdminUser),
    total: Number(totalRow?.n || 0),
    limit: lim,
    offset: off
  };
}

function shapeAdminUser(u) {
  return {
    id: Number(u.id),
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    avatarUrl: u.avatar_url,
    status: u.status,
    role: u.role,
    verified: Boolean(u.is_verified),
    emailVerified: Boolean(u.email_verified_at),
    phoneVerified: Boolean(u.phone_verified_at),
    suspendedUntil: u.suspended_until,
    statusReason: u.status_reason,
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
    isOnline: Boolean(u.is_online),
    profileCompletion: Number(u.profile_completion || 0),
    openReports: Number(u.open_reports || 0)
  };
}

/** Full moderation view of one user. */
export async function getUserDetail(userId) {
  const u = await queryOne(
    `SELECT u.*, (SELECT COUNT(*) FROM content_reports cr
                   WHERE cr.reported_user_id = u.id AND cr.status IN ('open','reviewing')) AS open_reports
       FROM users u WHERE u.id = ? LIMIT 1`,
    [Number(userId)]
  );
  if (!u) throw notFound('No such user.');

  const [counts, reportsAgainst, recentActions] = await Promise.all([
    queryOne(
      `SELECT
         (SELECT COUNT(*) FROM posts WHERE user_id = ? AND deleted_at IS NULL) AS posts,
         (SELECT COUNT(*) FROM moments WHERE user_id = ? AND deleted_at IS NULL) AS moments,
         (SELECT COUNT(*) FROM matches WHERE user_a_id = ? OR user_b_id = ?) AS matches,
         (SELECT COUNT(*) FROM messages WHERE sender_id = ?) AS messages,
         (SELECT COUNT(*) FROM content_reports WHERE reporter_id = ?) AS reports_filed`,
      [userId, userId, userId, userId, userId, userId]
    ),
    query(
      `SELECT id, target_type, reason, status, created_at
         FROM content_reports WHERE reported_user_id = ?
        ORDER BY id DESC LIMIT 10`,
      [userId]
    ),
    query(
      `SELECT a.action, a.detail, a.created_at, u2.username AS actor_username
         FROM admin_audit_log a JOIN users u2 ON u2.id = a.actor_id
        WHERE a.target_type = 'user' AND a.target_id = ?
        ORDER BY a.id DESC LIMIT 10`,
      [userId]
    )
  ]);

  return {
    user: shapeAdminUser(u),
    stats: {
      posts: Number(counts?.posts || 0),
      moments: Number(counts?.moments || 0),
      matches: Number(counts?.matches || 0),
      messages: Number(counts?.messages || 0),
      reportsFiled: Number(counts?.reports_filed || 0),
      openReports: Number(u.open_reports || 0)
    },
    reportsAgainst: reportsAgainst.map((r) => ({
      id: Number(r.id),
      targetType: r.target_type,
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at
    })),
    moderationHistory: recentActions.map((a) => ({
      action: a.action,
      detail: a.detail,
      createdAt: a.created_at,
      actor: a.actor_username
    }))
  };
}

/**
 * Guard every action that targets another account.
 *
 * Two rules, both enforced here rather than only at the route so that a wiring
 * mistake cannot turn into an escalation:
 *   - nobody may action an account of equal or higher rank than their own;
 *   - nobody may action themselves (a self-ban would lock the last admin out).
 */
function assertMayTarget(actor, target, action) {
  if (ADMIN_ONLY.has(action) && rankOf(actor.role) < rankOf('admin')) {
    throw forbidden('That action requires an administrator.');
  }
  if (Number(actor.id) === Number(target.id)) {
    throw badRequest('You cannot apply moderation actions to your own account.');
  }
  if (rankOf(target.role) >= rankOf(actor.role)) {
    throw forbidden('You cannot action an account at or above your own permission level.');
  }
}

async function loadTarget(userId) {
  const u = await queryOne('SELECT id, username, role, status FROM users WHERE id = ? LIMIT 1', [Number(userId)]);
  if (!u) throw notFound('No such user.');
  return u;
}

/** Temporarily suspend an account. Moderators may do this. */
export async function suspendUser(actor, userId, { days = 7, reason = null, ip = null } = {}) {
  const target = await loadTarget(userId);
  assertMayTarget(actor, target, 'user.suspend');

  const d = Math.min(365, Math.max(1, Number(days) || 7));
  await execute(
    `UPDATE users SET status = 'suspended', suspended_until = DATE_ADD(NOW(), INTERVAL ? DAY), status_reason = ?
      WHERE id = ?`,
    [d, reason ? String(reason).slice(0, 255) : null, target.id]
  );
  await logAction(actor.id, 'user.suspend', {
    targetType: 'user',
    targetId: target.id,
    detail: `${d}d — ${reason || 'no reason given'}`,
    ip
  });
  return getUserDetail(target.id);
}

/** Permanent ban. Admin-only. */
export async function banUser(actor, userId, { reason = null, ip = null } = {}) {
  const target = await loadTarget(userId);
  assertMayTarget(actor, target, 'user.ban');

  await execute("UPDATE users SET status = 'banned', suspended_until = NULL, status_reason = ? WHERE id = ?", [
    reason ? String(reason).slice(0, 255) : null,
    target.id
  ]);
  await logAction(actor.id, 'user.ban', {
    targetType: 'user',
    targetId: target.id,
    detail: reason || 'no reason given',
    ip
  });
  return getUserDetail(target.id);
}

/**
 * Lift a sanction. Restoring a *banned* account is admin-only — a moderator
 * can undo their own suspension but cannot quietly reverse an admin's ban.
 */
export async function restoreUser(actor, userId, { reason = null, ip = null } = {}) {
  const target = await loadTarget(userId);
  const action = target.status === 'banned' ? 'user.restore_banned' : 'user.restore';
  assertMayTarget(actor, target, action);

  if (target.status === 'active') throw badRequest('That account is already active.');

  await execute("UPDATE users SET status = 'active', suspended_until = NULL, status_reason = NULL WHERE id = ?", [
    target.id
  ]);
  await logAction(actor.id, 'user.restore', {
    targetType: 'user',
    targetId: target.id,
    detail: `${target.status} → active — ${reason || 'no reason given'}`,
    ip
  });
  return getUserDetail(target.id);
}

/** Change a user's role. Admin-only, and never to a rank at/above your own. */
export async function setUserRole(actor, userId, { role, ip = null }) {
  if (!['user', 'moderator', 'admin'].includes(role)) throw badRequest('Unknown role.');
  const target = await loadTarget(userId);
  assertMayTarget(actor, target, 'user.role');

  if (rankOf(role) >= rankOf(actor.role)) {
    throw forbidden('You cannot grant a role at or above your own permission level.');
  }

  await execute('UPDATE users SET role = ? WHERE id = ?', [role, target.id]);
  await logAction(actor.id, 'user.role', {
    targetType: 'user',
    targetId: target.id,
    detail: `${target.role} → ${role}`,
    ip
  });
  return getUserDetail(target.id);
}

// ----------------------------------------------------------- content admin

/**
 * Take content down. Soft delete, because the row is evidence: a hard delete
 * would destroy the context behind any report that references it.
 */
export async function removeContent(actor, { targetType, targetId, reason = null, ip = null }) {
  if (!CONTENT_TYPES.includes(targetType)) throw badRequest('That content type cannot be moderated.');
  const table = { post: 'posts', moment: 'moments', comment: 'comments' }[targetType];

  const row = await queryOne(`SELECT id, user_id, deleted_at FROM ${table} WHERE id = ? LIMIT 1`, [Number(targetId)]);
  if (!row) throw notFound('That content no longer exists.');
  if (row.deleted_at) throw badRequest('That content has already been removed.');

  await execute(`UPDATE ${table} SET deleted_at = NOW(), deleted_by = ? WHERE id = ?`, [actor.id, Number(targetId)]);
  await logAction(actor.id, 'content.remove', {
    targetType,
    targetId: Number(targetId),
    detail: reason || 'no reason given',
    ip
  });

  return { removed: true, targetType, targetId: Number(targetId), ownerId: Number(row.user_id) };
}

// ------------------------------------------------------------- analytics

/**
 * Dashboard analytics.
 *
 * All windows are computed from the DB clock (`NOW()`), not the Node clock,
 * for the same reason the TTL work does it: the two can drift, and a metric
 * that disagrees with the data it summarises is worse than no metric.
 */
export async function analytics() {
  const [users, engagement, content, reports, verification] = await Promise.all([
    queryOne(
      `SELECT COUNT(*) AS total,
              SUM(created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS new_24h,
              SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS new_7d,
              SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS active_24h,
              SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS active_7d,
              SUM(is_online = 1) AS online_now,
              SUM(status = 'suspended') AS suspended,
              SUM(status = 'banned') AS banned
         FROM users`
    ),
    queryOne(
      `SELECT
         (SELECT COUNT(*) FROM matches) AS matches_total,
         (SELECT COUNT(*) FROM matches WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS matches_24h,
         (SELECT COUNT(*) FROM messages) AS messages_total,
         (SELECT COUNT(*) FROM messages WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS messages_24h,
         (SELECT COUNT(*) FROM swipes) AS swipes_total`
    ),
    queryOne(
      `SELECT
         (SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL) AS posts_live,
         (SELECT COUNT(*) FROM posts WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS posts_24h,
         (SELECT COUNT(*) FROM moments WHERE deleted_at IS NULL) AS moments_live,
         (SELECT COUNT(*) FROM moments WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS moments_24h,
         (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL) AS comments_live`
    ),
    queryOne(
      `SELECT COUNT(*) AS total,
              SUM(status = 'open') AS open,
              SUM(status = 'reviewing') AS reviewing,
              SUM(status = 'actioned') AS actioned,
              SUM(status = 'dismissed') AS dismissed,
              SUM(created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS new_24h,
              SUM(status IN ('open','reviewing') AND priority >= 2) AS urgent
         FROM content_reports`
    ),
    queryOne(
      `SELECT COUNT(*) AS total,
              SUM(is_verified = 1) AS photo_verified,
              SUM(email_verified_at IS NOT NULL) AS email_verified,
              SUM(phone_verified_at IS NOT NULL) AS phone_verified
         FROM users`
    )
  ]);

  const totalUsers = Number(users?.total || 0);
  const pct = (n) => (totalUsers ? Math.round((Number(n || 0) / totalUsers) * 1000) / 10 : 0);

  // Reports per 1k messages: a raw report count rises with traffic, so on its
  // own it cannot tell a moderator whether things are getting worse.
  const msgs = Number(engagement?.messages_total || 0);

  return {
    users: {
      total: totalUsers,
      new24h: Number(users?.new_24h || 0),
      new7d: Number(users?.new_7d || 0),
      active24h: Number(users?.active_24h || 0),
      active7d: Number(users?.active_7d || 0),
      onlineNow: Number(users?.online_now || 0),
      suspended: Number(users?.suspended || 0),
      banned: Number(users?.banned || 0)
    },
    engagement: {
      matchesTotal: Number(engagement?.matches_total || 0),
      matches24h: Number(engagement?.matches_24h || 0),
      messagesTotal: msgs,
      messages24h: Number(engagement?.messages_24h || 0),
      swipesTotal: Number(engagement?.swipes_total || 0)
    },
    content: {
      postsLive: Number(content?.posts_live || 0),
      posts24h: Number(content?.posts_24h || 0),
      momentsLive: Number(content?.moments_live || 0),
      moments24h: Number(content?.moments_24h || 0),
      commentsLive: Number(content?.comments_live || 0)
    },
    reports: {
      total: Number(reports?.total || 0),
      open: Number(reports?.open || 0),
      reviewing: Number(reports?.reviewing || 0),
      actioned: Number(reports?.actioned || 0),
      dismissed: Number(reports?.dismissed || 0),
      new24h: Number(reports?.new_24h || 0),
      urgent: Number(reports?.urgent || 0),
      per1kMessages: msgs ? Math.round((Number(reports?.total || 0) / msgs) * 1000 * 10) / 10 : 0
    },
    verification: {
      photoRate: pct(verification?.photo_verified),
      emailRate: pct(verification?.email_verified),
      phoneRate: pct(verification?.phone_verified)
    },
    generatedAt: new Date().toISOString()
  };
}

function clampLimit(limit) {
  const n = Number(limit) || 25;
  return Math.min(100, Math.max(1, Math.trunc(n)));
}
