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

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { env } from '../config/env.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { hasPermission, rankOf } from '../middleware/auth.js';
import { refreshCompletion } from './profile.service.js';
import { notify } from './notification.service.js';
import { deliveryHealth } from './delivery.service.js';
import { checkFfmpeg } from './upload.service.js';

const REPORT_STATUSES = ['open', 'reviewing', 'actioned', 'dismissed'];
const CONTENT_TYPES = ['post', 'moment', 'comment'];

/** Actions that only an admin may perform, regardless of route wiring. */
const ADMIN_ONLY = new Set(['user.role', 'user.ban', 'user.restore_banned', 'audit.read']);

function assertPermission(role, permission) {
  if (!hasPermission(role, permission)) throw forbidden('That action is not permitted for your staff role.');
}

// ------------------------------------------------------------- audit trail

/**
 * Insert the durable audit row and privacy-filtered activity event on the same
 * connection as the moderation mutation. If either insert fails, the mutation
 * rolls back rather than succeeding without its audit trail.
 */
async function writeAuditAction(conn, actorId, action, { targetType = null, targetId = null, detail = null, ip = null } = {}) {
  const [actors] = await conn.execute('SELECT username, role FROM users WHERE id = ? LIMIT 1', [Number(actorId)]);
  const actor = actors[0];
  if (!actor) throw notFound('Your staff account could not be found.');

  await conn.execute(
    `INSERT INTO admin_audit_log
       (actor_id, actor_username, action, target_type, target_id, detail, ip)
     VALUES (?,?,?,?,?,?,?)`,
    [Number(actorId), actor.username, action, targetType, targetId ?? null,
      detail ? String(detail).slice(0, 500) : null, ip ? String(ip).slice(0, 64) : null]
  );
  await conn.execute(
    `INSERT INTO activity_events
       (event_type, outcome, actor_id, actor_username, actor_role,
        subject_user_id, resource_type, resource_id, source)
     VALUES (?, 'success', ?, ?, ?, ?, ?, ?, 'web')`,
    [action, Number(actorId), actor.username, actor.role,
      targetType === 'user' ? targetId ?? null : null, targetType, targetId ?? null]
  );
}

/** Standalone audit append for trusted internal jobs; moderation mutations use writeAuditAction transactionally. */
export async function logAction(actorId, action, options = {}) {
  return withTransaction((conn) => writeAuditAction(conn, actorId, action, options));
}

/** Read the audit trail. Admin-only; moderators cannot audit themselves. */
export async function listAuditLog({ limit = 50, before = null, actorId = null, action = null, includeSensitive = false, actorRole = 'user' } = {}) {
  assertPermission(actorRole, 'audit:read');
  if (includeSensitive) assertPermission(actorRole, 'audit:read_sensitive');
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
            COALESCE(a.actor_username, u.username) AS actor_username, u.display_name AS actor_name
       FROM admin_audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
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
      ip: includeSensitive ? r.ip : null,
      createdAt: r.created_at,
      actor: {
        id: r.actor_id === null ? null : Number(r.actor_id),
        username: r.actor_username || r.actor_name || 'Deleted staff account',
        displayName: r.actor_name || r.actor_username || 'Deleted staff account'
      }
    })),
    nextCursor: rows.length === lim ? Number(rows[rows.length - 1].id) : null
  };
}

/** Privacy-filtered activity events: categories and identifiers only. */
export async function listActivityEvents({ limit = 50, before = null, eventType = null, subjectUserId = null, actorRole = 'user' } = {}) {
  assertPermission(actorRole, 'activity:read');
  const lim = clampLimit(limit);
  const where = [];
  const params = [];
  if (before) {
    where.push('e.id < ?');
    params.push(Number(before));
  }
  if (eventType) {
    where.push('e.event_type = ?');
    params.push(String(eventType).slice(0, 80));
  }
  if (subjectUserId) {
    where.push('e.subject_user_id = ?');
    params.push(Number(subjectUserId));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await query(
    `SELECT e.id, e.event_type, e.outcome, e.actor_id,
            COALESCE(e.actor_username, u.username) AS actor_username,
            e.actor_role, e.subject_user_id, e.resource_type, e.resource_id,
            e.source, e.created_at
       FROM activity_events e
       LEFT JOIN users u ON u.id = e.actor_id
       ${clause}
      ORDER BY e.id DESC
      LIMIT ${lim}`,
    params
  );
  return {
    entries: rows.map((row) => ({
      id: Number(row.id),
      eventType: row.event_type,
      outcome: row.outcome,
      actor: row.actor_username ? { id: row.actor_id === null ? null : Number(row.actor_id), username: row.actor_username, role: row.actor_role } : null,
      subjectUserId: row.subject_user_id === null ? null : Number(row.subject_user_id),
      resourceType: row.resource_type,
      resourceId: row.resource_id === null ? null : Number(row.resource_id),
      source: row.source,
      createdAt: row.created_at
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
export async function listReports({ status = 'open', limit = 25, cursor = null, targetType = null, reason = null, actorRole = 'user' } = {}) {
  assertPermission(actorRole, 'reports:read');
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
            r.snapshot, r.created_at, r.handled_at, r.resolution, r.assigned_to, r.assigned_at,
            rep.id AS reporter_id, rep.username AS reporter_username, rep.display_name AS reporter_name,
            ru.id AS reported_id, ru.username AS reported_username, ru.display_name AS reported_name,
            ru.status AS reported_status, ru.role AS reported_role,
            h.username AS handler_username, assignee.username AS assigned_username
       FROM content_reports r
       JOIN users rep ON rep.id = r.reporter_id
       LEFT JOIN users ru ON ru.id = r.reported_user_id
       LEFT JOIN users h ON h.id = r.handled_by
       LEFT JOIN users assignee ON assignee.id = r.assigned_to
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
export async function getReport(id, { actorRole = 'user' } = {}) {
  assertPermission(actorRole, 'reports:read');
  const r = await queryOne(
    `SELECT r.*, rep.username AS reporter_username, rep.display_name AS reporter_name,
            ru.username AS reported_username, ru.display_name AS reported_name,
            ru.status AS reported_status, ru.role AS reported_role,
            h.username AS handler_username, assignee.username AS assigned_username
       FROM content_reports r
       JOIN users rep ON rep.id = r.reporter_id
       LEFT JOIN users ru ON ru.id = r.reported_user_id
       LEFT JOIN users h ON h.id = r.handled_by
       LEFT JOIN users assignee ON assignee.id = r.assigned_to
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
  // Report snapshots may contain private chat text. The admin UI needs the
  // report category and lifecycle, not message bodies or reporter-supplied
  // copies of private conversations.
  if (r.target_type === 'message') snapshot = { note: 'Message content is hidden to protect private conversations.' };

  return {
    id: Number(r.id),
    targetType: r.target_type,
    targetId: Number(r.target_id),
    reason: r.reason,
    details: r.target_type === 'message' ? null : r.details,
    status: r.status,
    priority: Number(r.priority),
    snapshot,
    createdAt: r.created_at,
    handledAt: r.handled_at,
    // A moderator may quote private message text in a resolution field; never return
    // that field for message reports, even if it predates the current UI.
    resolution: r.target_type === 'message' ? null : r.resolution,
    handledBy: r.handler_username || null,
    assignedTo: r.assigned_username || null,
    assignedAt: r.assigned_at || null,
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

/** Move a report through the queue. The state change and audit rows are atomic. */
export async function resolveReport(actor, reportId, { status, resolution = null, ip = null }) {
  assertPermission(actor.role, 'reports:manage');
  if (!REPORT_STATUSES.includes(status)) throw badRequest('Unknown report status.');

  await withTransaction(async (conn) => {
    const currentActor = await loadActor(conn, actor.id);
    assertPermission(currentActor.role, 'reports:manage');
    const [rows] = await conn.execute(
      'SELECT id, status, target_type FROM content_reports WHERE id = ? LIMIT 1 FOR UPDATE',
      [Number(reportId)]
    );
    const existing = rows[0];
    if (!existing) throw notFound('That report no longer exists.');
    if (['actioned', 'dismissed'].includes(existing.status)) {
      throw badRequest('That report has already been closed.');
    }
    if (status === 'open') throw badRequest('A report cannot be reopened from this action.');
    if (existing.status === status) throw badRequest('That report already has this status.');

    // Message bodies are private and must never be copied into a resolution field.
    const safeResolution = existing.target_type === 'message' || typeof resolution !== 'string'
      ? null
      : resolution.trim().slice(0, 255) || null;
    await conn.execute(
      `UPDATE content_reports
          SET status = ?, resolution = ?, handled_by = ?, handled_at = NOW()
        WHERE id = ?`,
      [status, safeResolution, currentActor.id, Number(reportId)]
    );
    await writeAuditAction(conn, currentActor.id, `report.${status}`, {
      targetType: 'report',
      targetId: Number(reportId),
      detail: `${existing.status} → ${status}`,
      ip
    });
  });

  return getReport(reportId, { actorRole: actor.role });
}

export async function assignReport(actor, reportId, assigneeId, { ip = null } = {}) {
  assertPermission(actor.role, 'reports:manage');
  const clear = assigneeId === null || assigneeId === undefined || assigneeId === '';
  if (!clear && (!Number.isSafeInteger(Number(assigneeId)) || Number(assigneeId) < 1)) {
    throw badRequest('Choose a valid staff account.');
  }

  await withTransaction(async (conn) => {
    const currentActor = await loadActor(conn, actor.id);
    assertPermission(currentActor.role, 'reports:manage');
    const [reports] = await conn.execute('SELECT id FROM content_reports WHERE id = ? LIMIT 1 FOR UPDATE', [Number(reportId)]);
    if (!reports[0]) throw notFound('That report no longer exists.');

    let assignee = null;
    if (!clear) {
      const [rows] = await conn.execute(
        'SELECT id, role, status FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [Number(assigneeId)]
      );
      assignee = rows[0];
      if (!assignee) throw notFound('That staff account no longer exists.');
      if (assignee.status !== 'active' || !hasPermission(assignee.role, 'reports:manage')) {
        throw badRequest('Reports can only be assigned to an active moderator or administrator.');
      }
    }

    await conn.execute(
      'UPDATE content_reports SET assigned_to = ?, assigned_at = IF(? IS NULL, NULL, NOW()) WHERE id = ?',
      [assignee ? Number(assignee.id) : null, assignee ? Number(assignee.id) : null, Number(reportId)]
    );
    await writeAuditAction(conn, currentActor.id, 'report.assign', {
      targetType: 'report', targetId: Number(reportId),
      detail: assignee ? 'Report assigned' : 'Report assignment cleared', ip
    });
  });
  return getReport(reportId, { actorRole: actor.role });
}

export async function listReportNotes(reportId, actorRole = 'user') {
  assertPermission(actorRole, 'reports:notes');
  const report = await queryOne('SELECT id FROM content_reports WHERE id = ? LIMIT 1', [Number(reportId)]);
  if (!report) throw notFound('That report no longer exists.');
  const rows = await query(
    `SELECT id, author_username, note, created_at
       FROM admin_report_notes WHERE report_id = ? ORDER BY id ASC LIMIT 100`,
    [Number(reportId)]
  );
  return { notes: rows.map((row) => ({ id: Number(row.id), author: row.author_username, note: row.note, createdAt: row.created_at })) };
}

export async function addReportNote(actor, reportId, note, { ip = null } = {}) {
  assertPermission(actor.role, 'reports:notes');
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text || text.length > 1000) throw badRequest('Internal notes must contain 1 to 1000 characters.');

  await withTransaction(async (conn) => {
    const currentActor = await loadActor(conn, actor.id);
    assertPermission(currentActor.role, 'reports:notes');
    const [reports] = await conn.execute('SELECT id FROM content_reports WHERE id = ? LIMIT 1 FOR UPDATE', [Number(reportId)]);
    if (!reports[0]) throw notFound('That report no longer exists.');
    await conn.execute(
      'INSERT INTO admin_report_notes (report_id, author_id, author_username, note) VALUES (?, ?, ?, ?)',
      [Number(reportId), currentActor.id, currentActor.username, text]
    );
    await writeAuditAction(conn, currentActor.id, 'report.note', {
      targetType: 'report', targetId: Number(reportId), detail: 'Internal report note added', ip
    });
  });
  return listReportNotes(reportId, actor.role);
}

// -------------------------------------------------------------- user admin

/**
 * User search for the dashboard.
 *
 * Exact username/email matches are checked first and separately from the
 * prefix scan so that looking up a known handle stays on the unique index
 * instead of degrading into the `LIKE` path.
 */
export async function searchUsers({ q = '', status = null, role = null, limit = 25, offset = 0, actorRole = 'user' } = {}) {
  assertPermission(actorRole, 'users:read_basic');
  const lim = clampLimit(limit);
  const requestedOffset = Number(offset) || 0;
  const off = Math.min(10_000, Math.max(0, Math.trunc(requestedOffset)));
  const where = [];
  const params = [];

  const term = String(q || '').trim();
  if (term.length > 100) throw badRequest('Search terms must be 100 characters or fewer.');
  const includePii = hasPermission(actorRole, 'users:read_sensitive');
  if (status && !['active', 'suspended', 'banned'].includes(status)) throw badRequest('Unknown account status.');
  if (role && !['user', 'support_agent', 'analyst', 'moderator', 'auditor', 'admin', 'super_admin'].includes(role)) {
    throw badRequest('Unknown staff role.');
  }
  if (term) {
    // Email lookups are PII-bearing and are available only to admin roles.
    // Username prefix remains anchored so its index can serve the common case.
    if (includePii) {
      where.push('(u.username = ? OR u.email = ? OR u.username LIKE ? OR u.display_name LIKE ?)');
      params.push(term.toLowerCase(), term.toLowerCase(), `${term}%`, `${term}%`);
    } else {
      where.push('(u.username = ? OR u.username LIKE ? OR u.display_name LIKE ?)');
      params.push(term.toLowerCase(), `${term}%`, `${term}%`);
    }
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
    users: rows.map((row) => shapeAdminUser(row, { includePii })),
    canViewSensitive: includePii,
    total: Number(totalRow?.n || 0),
    limit: lim,
    offset: off
  };
}

function shapeAdminUser(u, { includePii = false } = {}) {
  return {
    id: Number(u.id),
    username: u.username,
    displayName: u.display_name,
    ...(includePii ? { email: u.email } : {}),
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

/** Full moderation view of one user, with PII derived from the caller's staff role. */
export async function getUserDetail(userId, { actorRole = 'user' } = {}) {
  assertPermission(actorRole, 'users:read_detail');
  const includePii = hasPermission(actorRole, 'users:read_sensitive');
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
      `SELECT a.action, a.detail, a.created_at,
              COALESCE(a.actor_username, u2.username) AS actor_username
         FROM admin_audit_log a LEFT JOIN users u2 ON u2.id = a.actor_id
        WHERE a.target_type = 'user' AND a.target_id = ?
        ORDER BY a.id DESC LIMIT 10`,
      [userId]
    )
  ]);

  return {
    user: shapeAdminUser(u, { includePii }),
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
  const permission = {
    'user.suspend': 'users:suspend',
    'user.restore': 'users:restore',
    'user.restore_banned': 'users:ban',
    'user.ban': 'users:ban',
    'user.role': 'roles:manage'
  }[action];
  if (permission) assertPermission(actor.role, permission);
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

async function loadActor(conn, actorId) {
  const [rows] = await conn.execute(
    'SELECT id, username, role, status FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [Number(actorId)]
  );
  const actor = rows[0];
  if (!actor || actor.status !== 'active') throw forbidden('Your staff access is no longer active.');
  return { id: Number(actor.id), username: actor.username, role: actor.role, status: actor.status };
}

async function loadTarget(conn, userId) {
  const [rows] = await conn.execute(
    'SELECT id, username, role, status FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [Number(userId)]
  );
  if (!rows[0]) throw notFound('No such user.');
  return rows[0];
}

/** Temporarily suspend an account. Moderators may do this. */
export async function suspendUser(actor, userId, { days = 7, reason = null, ip = null } = {}) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw badRequest('Suspension length must be 1 to 365 days.');
  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 255) || null : null;

  await withTransaction(async (conn) => {
    const currentActor = await loadActor(conn, actor.id);
    const target = await loadTarget(conn, userId);
    assertMayTarget(currentActor, target, 'user.suspend');
    await conn.execute(
      `UPDATE users SET status = 'suspended', suspended_until = DATE_ADD(NOW(), INTERVAL ? DAY), status_reason = ?
        WHERE id = ?`,
      [n, safeReason, target.id]
    );
    await writeAuditAction(conn, actor.id, 'user.suspend', {
      targetType: 'user', targetId: Number(target.id), detail: `Temporary suspension (${n} days)`, ip
    });
  });
  return getUserDetail(userId, { actorRole: actor.role });
}

/** Permanent ban. Admin-only. */
export async function banUser(actor, userId, { reason = null, ip = null } = {}) {
  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 255) || null : null;
  await withTransaction(async (conn) => {
    const currentActor = await loadActor(conn, actor.id);
    const target = await loadTarget(conn, userId);
    assertMayTarget(currentActor, target, 'user.ban');
    await conn.execute(
      "UPDATE users SET status = 'banned', suspended_until = NULL, status_reason = ? WHERE id = ?",
      [safeReason, target.id]
    );
    await writeAuditAction(conn, actor.id, 'user.ban', {
      targetType: 'user', targetId: Number(target.id), detail: 'Permanent ban', ip
    });
  });
  return getUserDetail(userId, { actorRole: actor.role });
}

/**
 * Lift a sanction. Restoring a *banned* account is admin-only — a moderator
 * can undo their own suspension but cannot quietly reverse an admin's ban.
 */
export async function restoreUser(actor, userId, { ip = null } = {}) {
  await withTransaction(async (conn) => {
    const currentActor = await loadActor(conn, actor.id);
    const target = await loadTarget(conn, userId);
    const action = target.status === 'banned' ? 'user.restore_banned' : 'user.restore';
    assertMayTarget(currentActor, target, action);
    if (target.status === 'active') throw badRequest('That account is already active.');

    await conn.execute(
      "UPDATE users SET status = 'active', suspended_until = NULL, status_reason = NULL WHERE id = ?",
      [target.id]
    );
    await writeAuditAction(conn, actor.id, 'user.restore', {
      targetType: 'user', targetId: Number(target.id), detail: `Sanction lifted (${target.status})`, ip
    });
  });
  return getUserDetail(userId, { actorRole: actor.role });
}

/** Change a user's role. Admin-only, and never to a rank at/above your own. */
export async function setUserRole(actor, userId, { role, ip = null }) {
  if (!['user', 'support_agent', 'analyst', 'moderator', 'auditor', 'admin', 'super_admin'].includes(role)) {
    throw badRequest('Unknown role.');
  }
  assertPermission(actor.role, 'roles:manage');
  await withTransaction(async (conn) => {
    const currentActor = await loadActor(conn, actor.id);
    const target = await loadTarget(conn, userId);
    assertMayTarget(currentActor, target, 'user.role');
    if (rankOf(role) >= rankOf(currentActor.role)) {
      throw forbidden('You cannot grant a role at or above your own permission level.');
    }
    await conn.execute('UPDATE users SET role = ? WHERE id = ?', [role, target.id]);
    await writeAuditAction(conn, actor.id, 'user.role', {
      targetType: 'user', targetId: Number(target.id), detail: `${target.role} → ${role}`, ip
    });
  });
  return getUserDetail(userId, { actorRole: actor.role });
}

// ------------------------------------------------------- verification review

export async function listPendingVerifications({ limit = 25, before = null, actorRole = 'user' } = {}) {
  assertPermission(actorRole, 'verification:read');
  const lim = clampLimit(limit);
  const params = [];
  const where = ["v.status = 'pending'"];
  if (before) {
    where.push('v.id < ?');
    params.push(Number(before));
  }
  const rows = await query(
    `SELECT v.id, v.user_id, v.gesture, v.status, v.created_at,
            u.username, u.display_name, u.avatar_url
       FROM verifications v
       JOIN users u ON u.id = v.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY v.id DESC
      LIMIT ${lim}`,
    params
  );
  return {
    verifications: rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      gesture: row.gesture,
      status: row.status,
      submittedAt: row.created_at
    })),
    nextCursor: rows.length === lim ? Number(rows[rows.length - 1].id) : null
  };
}

export async function getVerificationEvidence(verificationId, actorRole = 'user') {
  assertPermission(actorRole, 'verification:review');
  const row = await queryOne(
    `SELECT id, file_path FROM verifications
      WHERE id = ? AND status = 'pending' LIMIT 1`,
    [Number(verificationId)]
  );
  if (!row?.file_path || !/^verification\/[a-f0-9-]{36}\.(?:jpe?g|webp)$/i.test(row.file_path)) {
    throw notFound('Private verification evidence is no longer available.');
  }
  return { id: Number(row.id), filePath: row.file_path };
}

export async function reviewVerification(actor, verificationId, { decision, note = null, ip = null } = {}) {
  assertPermission(actor.role, 'verification:review');
  if (!['approved', 'rejected'].includes(decision)) throw badRequest('Choose approve or reject.');
  if (note !== null && note !== undefined && typeof note !== 'string') throw badRequest('Review note must be plain text.');
  const reviewNote = typeof note === 'string' ? note.trim().slice(0, 255) || null : null;

  const result = await withTransaction(async (conn) => {
    const currentActor = await loadActor(conn, actor.id);
    assertPermission(currentActor.role, 'verification:review');
    const [rows] = await conn.execute(
      `SELECT v.id, v.user_id, v.file_path, v.status, u.is_verified
         FROM verifications v
         JOIN users u ON u.id = v.user_id
        WHERE v.id = ?
        LIMIT 1 FOR UPDATE`,
      [Number(verificationId)]
    );
    const row = rows[0];
    if (!row) throw notFound('That verification request no longer exists.');
    if (Number(row.user_id) === currentActor.id) throw forbidden('You cannot review your own verification request.');
    if (row.status !== 'pending') throw badRequest('That verification request has already been reviewed.');

    await conn.execute(
      'UPDATE verifications SET status = ?, reviewed_at = NOW(), note = ? WHERE id = ?',
      [decision, reviewNote, Number(verificationId)]
    );
    const verified = decision === 'approved' ? 1 : 0;
    await conn.execute(
      'UPDATE users SET is_verified = ?, verified_at = IF(? = 1, NOW(), NULL) WHERE id = ?',
      [verified, verified, row.user_id]
    );
    if (row.file_path) {
      await conn.execute(
        `INSERT IGNORE INTO media_deletion_queue (file_key, reason)
         VALUES (?, 'verification_reviewed')`,
        [row.file_path]
      );
      await conn.execute('UPDATE verifications SET file_path = NULL WHERE id = ?', [Number(verificationId)]);
    }
    await writeAuditAction(conn, currentActor.id, `verification.${decision}`, {
      targetType: 'user', targetId: Number(row.user_id), detail: `Photo verification ${decision}`, ip
    });
    return { userId: Number(row.user_id) };
  });

  await refreshCompletion(result.userId).catch(() => {});
  await notify({
    userId: result.userId,
    kind: 'verification',
    targetType: 'profile',
    targetId: result.userId,
    href: '/settings',
    body: decision === 'approved'
      ? 'Your photo verification was approved by a moderator.'
      : 'Your photo verification was not approved. Review the note and submit a new photo if you wish.',
    groupKey: `verification:profile:${result.userId}`
  }).catch(() => {});
  return { id: Number(verificationId), status: decision, userId: result.userId };
}

// ----------------------------------------------------------- content admin

/**
 * Take content down. Soft delete, because the row is evidence: a hard delete
 * would destroy the context behind any report that references it.
 */
export async function removeContent(actor, { targetType, targetId, ip = null }) {
  assertPermission(actor.role, 'content:remove');
  if (!CONTENT_TYPES.includes(targetType)) throw badRequest('That content type cannot be moderated.');
  const table = { post: 'posts', moment: 'moments', comment: 'comments' }[targetType];
  let ownerId;

  await withTransaction(async (conn) => {
    const currentActor = await loadActor(conn, actor.id);
    assertPermission(currentActor.role, 'content:remove');
    const [rows] = await conn.execute(
      `SELECT id, user_id, deleted_at FROM ${table} WHERE id = ? LIMIT 1 FOR UPDATE`, [Number(targetId)]
    );
    const row = rows[0];
    if (!row) throw notFound('That content no longer exists.');
    if (row.deleted_at) throw badRequest('That content has already been removed.');
    ownerId = Number(row.user_id);

    await conn.execute(`UPDATE ${table} SET deleted_at = NOW(), deleted_by = ? WHERE id = ?`, [currentActor.id, Number(targetId)]);
    await writeAuditAction(conn, currentActor.id, 'content.remove', {
      targetType, targetId: Number(targetId), detail: `${targetType} removed`, ip
    });
  });

  return { removed: true, targetType, targetId: Number(targetId), ownerId };
}

// ------------------------------------------------------------- analytics

/**
 * Dashboard analytics.
 *
 * All windows are computed from the DB clock (`NOW()`), not the Node clock,
 * for the same reason the TTL work does it: the two can drift, and a metric
 * that disagrees with the data it summarises is worse than no metric.
 */
export async function analytics(actorRole = 'user') {
  assertPermission(actorRole, 'analytics:read');
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
              SUM(status IN ('open','reviewing') AND priority >= 2) AS urgent,
              SUM(target_type = 'message' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) AS message_reports_24h
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

  // Compare message reports and messages created in the same 24-hour window.
  // This is a volume ratio, not a safety score, and is undefined when there are
  // no messages in the interval.

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
      messagesTotal: Number(engagement?.messages_total || 0),
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
      messageReports24h: Number(reports?.message_reports_24h || 0),
      messageReportsPer1kMessages24h: Number(engagement?.messages_24h || 0)
        ? Math.round((Number(reports?.message_reports_24h || 0) / Number(engagement.messages_24h)) * 1000 * 10) / 10
        : null
    },
    verification: {
      photoRate: pct(verification?.photo_verified),
      emailRate: pct(verification?.email_verified),
      phoneRate: pct(verification?.phone_verified)
    },
    generatedAt: new Date().toISOString()
  };
}

/** Live operational checks; provider configuration is distinguished from reachability. */
export async function health(actorRole = 'user') {
  assertPermission(actorRole, 'system:health');
  const checks = {
    database: { ok: false, latencyMs: null, code: null },
    storage: { ok: false },
    deliveryQueue: { ok: false, pending: null, failed: null },
    email: { configured: Boolean(env.SMTP.configured), reachability: 'not-probed' },
    sms: { configured: Boolean(env.TWILIO.configured), reachability: 'not-probed' },
    videoProcessing: { available: false, fallbackSupported: true }
  };

  const started = Date.now();
  try {
    await queryOne('SELECT 1 AS ok');
    checks.database = { ok: true, latencyMs: Date.now() - started, code: null };
  } catch (error) {
    checks.database = {
      ok: false,
      latencyMs: Date.now() - started,
      code: String(error.code || 'DB_ERROR').slice(0, 32)
    };
  }

  try {
    await fs.access(env.UPLOAD_DIR, fsConstants.R_OK | fsConstants.W_OK);
    checks.storage.ok = true;
  } catch {
    checks.storage.ok = false;
  }

  if (checks.database.ok) {
    try {
      const delivery = await deliveryHealth();
      checks.deliveryQueue = {
        ok: true,
        pending: delivery.pending,
        failed: delivery.failed
      };
    } catch (error) {
      checks.deliveryQueue = {
        ok: false,
        pending: null,
        failed: null,
        code: String(error.code || 'QUEUE_ERROR').slice(0, 32)
      };
    }
  }

  try {
    checks.videoProcessing.available = await checkFfmpeg();
  } catch {
    checks.videoProcessing.available = false;
  }

  const hardFailure = !checks.database.ok || !checks.storage.ok;
  const degraded = !checks.deliveryQueue.ok || !checks.email.configured || !checks.sms.configured;
  return {
    status: hardFailure ? 'unhealthy' : degraded ? 'degraded' : 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    checks,
    checkedAt: new Date().toISOString()
  };
}

/** Read-only runtime configuration; secret values and infrastructure addresses are never returned. */
export async function settings(actorRole = 'user') {
  assertPermission(actorRole, 'system:read');
  return {
    source: 'environment',
    environment: env.NODE_ENV,
    retention: {
      messageHours: env.MESSAGE_TTL_HOURS,
      momentsAndPostsHours: 24,
      profilePhotos: 'Retained until removed or account deletion',
      verificationEvidence: 'Private while pending; queued for deletion after review'
    },
    uploads: {
      maxImageMb: env.MAX_IMAGE_MB,
      maxVideoMb: env.MAX_VIDEO_MB
    },
    delivery: {
      queued: true,
      emailConfigured: Boolean(env.SMTP.configured),
      smsConfigured: Boolean(env.TWILIO.configured)
    },
    realtime: {
      turnConfigured: Boolean(env.TURN.url && env.TURN.username && env.TURN.credential)
    },
    operations: {
      databaseTls: Boolean(env.DB.ssl),
      forceHttps: Boolean(env.FORCE_HTTPS),
      trustProxy: Boolean(env.TRUST_PROXY || env.isProd),
      cleanupSchedule: env.CLEANUP_CRON
    },
    editableInDashboard: false
  };
}

function clampLimit(limit) {
  const n = Number(limit) || 25;
  return Math.min(100, Math.max(1, Math.trunc(n)));
}
