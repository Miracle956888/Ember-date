import { query, queryOne, execute } from '../db/pool.js';
import logger from '../utils/logger.js';

/**
 * notification.service — one funnel for every in-app notification.
 *
 * Two rules make this anti-spam by construction:
 *
 * 1. **Coalescing.** A `group_key` is UNIQUE per user, so repeated events of
 *    the same kind about the same object bump a counter and refresh the
 *    timestamp instead of stacking rows. Five people liking one post is one
 *    "5 people liked your post", never five notifications.
 * 2. **Preference gating.** Every kind maps to a column in
 *    `notification_prefs`; a disabled category is dropped before insert, so a
 *    muted category cannot even accumulate an unread count.
 *
 * Notifications are never fatal: a failure here must not roll back the action
 * that triggered it, so everything is wrapped and logged rather than thrown.
 */

/**
 * Emitter hook, injected by the socket layer (same pattern as the cleanup job).
 * Importing sockets/index.js here would create a cycle -- sockets import
 * services -- so delivery is pushed in from the outside instead.
 */
let broadcast = null;
export function setNotificationBroadcaster(fn) {
  broadcast = typeof fn === 'function' ? fn : null;
}

/** Which preference column gates which notification kind. */
const PREF_FOR_KIND = {
  match: 'matches',
  message: 'messages',
  profile_like: 'likes',
  photo_like: 'likes',
  post_like: 'likes',
  post_comment: 'comments',
  comment_reply: 'comments',
  moment_reaction: 'moments',
  moment_reply: 'moments',
  verification: null, // account-critical: always delivered
  safety: null, // safety: always delivered
  system: null
};

/** Preference row, created on demand with everything enabled. */
export async function getPrefs(userId) {
  let row = await queryOne('SELECT * FROM notification_prefs WHERE user_id = ? LIMIT 1', [userId]);
  if (!row) {
    await execute('INSERT IGNORE INTO notification_prefs (user_id) VALUES (?)', [userId]);
    row = await queryOne('SELECT * FROM notification_prefs WHERE user_id = ? LIMIT 1', [userId]);
  }
  return {
    matches: Boolean(row?.matches ?? 1),
    messages: Boolean(row?.messages ?? 1),
    likes: Boolean(row?.likes ?? 1),
    comments: Boolean(row?.comments ?? 1),
    moments: Boolean(row?.moments ?? 1),
    posts: Boolean(row?.posts ?? 1),
    safety: Boolean(row?.safety ?? 1)
  };
}

const PREF_KEYS = ['matches', 'messages', 'likes', 'comments', 'moments', 'posts', 'safety'];

export async function updatePrefs(userId, patch) {
  const keys = Object.keys(patch).filter((k) => PREF_KEYS.includes(k));
  if (!keys.length) return getPrefs(userId);
  await execute('INSERT IGNORE INTO notification_prefs (user_id) VALUES (?)', [userId]);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await execute(`UPDATE notification_prefs SET ${sets} WHERE user_id = ?`, [
    ...keys.map((k) => (patch[k] ? 1 : 0)),
    userId
  ]);
  return getPrefs(userId);
}

async function allowed(userId, kind) {
  const prefCol = PREF_FOR_KIND[kind];
  if (!prefCol) return true; // ungated kinds
  const prefs = await getPrefs(userId);
  return prefs[prefCol] !== false;
}

/**
 * Create or coalesce a notification.
 *
 * Never notifies you about your own action, never throws into the caller's
 * transaction, and respects the recipient's preferences.
 */
export async function notify({
  userId,
  actorId = null,
  kind,
  targetType = null,
  targetId = null,
  href = null,
  body = null,
  groupKey = null
}) {
  try {
    if (!userId || Number(userId) === Number(actorId)) return null;
    if (!(await allowed(userId, kind))) return null;

    const key = groupKey || `${kind}:${targetType || 'none'}:${targetId || 0}`;

    // The UNIQUE (user_id, group_key) turns a repeat into a counter bump.
    // Marking it unread again is deliberate: new activity deserves attention,
    // but it stays a single row.
    await execute(
      `INSERT INTO notifications (user_id, actor_id, kind, target_type, target_id, href, body, group_key)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         count = count + 1,
         unseen_count = unseen_count + 1,
         actor_id = VALUES(actor_id),
         href = VALUES(href),
         body = VALUES(body),
         read_at = NULL,
         created_at = CURRENT_TIMESTAMP`,
      [userId, actorId, kind, targetType, targetId, href, body, key]
    );

    // Push the fresh unread count to the recipient so the bell badge moves
    // without waiting for a poll or a page load. Best-effort by design: a
    // socket failure must never surface as a failed like/comment/match.
    if (broadcast) {
      try {
        broadcast(userId, {
          kind,
          unread: await unreadCount(userId)
        });
      } catch (err) {
        logger.error('[notify] broadcast failed', { kind, userId, error: err.message });
      }
    }

    return key;
  } catch (err) {
    // A notification must never break the action that caused it.
    logger.error('[notify] failed', { kind, userId, error: err.message });
    return null;
  }
}

/**
 * Withdraw a coalesced notification when the underlying event is undone
 * (unlike, deleted comment). Decrements, and removes the row at zero, so an
 * unread badge never points at something that no longer happened.
 */
export async function unnotify(groupKey) {
  try {
    // Match on the group key alone. A coalesced row stores only the *latest*
    // actor, so keying the decrement on actor_id would silently no-op for
    // everyone else who contributed to the count.
    // CAST to SIGNED before subtracting: on an UNSIGNED column `count - 1`
    // underflows and raises "value is out of range" *before* GREATEST can
    // clamp it, so a zero-count row would make every later unnotify throw.
    await execute(
      `UPDATE notifications
          SET count = GREATEST(CAST(count AS SIGNED) - 1, 0),
              unseen_count = GREATEST(CAST(unseen_count AS SIGNED) - 1, 0)
        WHERE group_key = ?`,
      [groupKey]
    );
    await execute('DELETE FROM notifications WHERE group_key = ? AND count = 0', [groupKey]);
  } catch (err) {
    logger.error('[unnotify] failed', { groupKey, error: err.message });
  }
}

/** Notification centre feed, newest first, with the actor hydrated. */
export async function list(userId, { limit = 30, before = null } = {}) {
  const params = [userId];
  let cursor = '';
  if (before) {
    cursor = 'AND n.id < ?';
    params.push(Number(before));
  }
  params.push(String(limit));

  const rows = await query(
    `SELECT n.id, n.kind, n.target_type, n.target_id, n.href, n.body, n.count, n.unseen_count,
            n.read_at, n.created_at,
            u.id AS actor_id, u.username AS actor_username,
            u.display_name AS actor_name, u.avatar_url AS actor_avatar
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ? ${cursor}
        AND (u.id IS NULL OR u.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.blocker_id = n.user_id AND b.blocked_id = n.actor_id)
                            OR (b.blocker_id = n.actor_id AND b.blocked_id = n.user_id))
      ORDER BY n.id DESC
      LIMIT ?`,
    params
  );

  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    targetType: r.target_type,
    targetId: r.target_id ? Number(r.target_id) : null,
    href: r.href,
    body: r.body,
    // An unread row answers "what happened since I last looked"; a read row
    // has nothing new, so it falls back to the standing total.
    count: Math.max(1, Number(r.read_at ? r.count : r.unseen_count)),
    read: Boolean(r.read_at),
    createdAt: new Date(r.created_at).toISOString(),
    actor: r.actor_id
      ? {
          id: Number(r.actor_id),
          username: r.actor_username,
          displayName: r.actor_name,
          avatarUrl: r.actor_avatar
        }
      : null
  }));
}

export async function unreadCount(userId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM notifications n
      WHERE n.user_id = ? AND n.read_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE (b.blocker_id = n.user_id AND b.blocked_id = n.actor_id)
                            OR (b.blocker_id = n.actor_id AND b.blocked_id = n.user_id))`,
    [userId]
  );
  return Number(row?.n || 0);
}

/**
 * Marking read resets `unseen_count` -- and only that.
 *
 * `count` is how many events stand behind the row and is owned by
 * notify/unnotify (a withdrawn like must decrement it, and the row dies at
 * zero). `unseen_count` is how many arrived since the user last looked, so it
 * is the one that resets here. Resetting `count` instead made "mark all read"
 * behave like withdrawing every like. Zero (not one) is the reset value so the
 * next bump lands on exactly 1.
 */
export async function markRead(userId, ids = null) {
  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    await execute(
      `UPDATE notifications SET read_at = NOW(), unseen_count = 0
        WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
      [userId, ...ids.map(Number)]
    );
  } else {
    await execute(
      'UPDATE notifications SET read_at = NOW(), unseen_count = 0 WHERE user_id = ? AND read_at IS NULL',
      [userId]
    );
  }
  return unreadCount(userId);
}
