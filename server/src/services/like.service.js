import { query, queryOne, execute, withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../utils/errors.js';
import { isBlockedEitherWay } from './user.service.js';
import { notify, unnotify } from './notification.service.js';

/**
 * like.service — one idempotent like primitive for every likeable object.
 *
 * Everything routes through `content_likes`, whose UNIQUE (user_id,
 * target_type, target_id) makes double-liking a no-op at the database level.
 * That is the whole anti-inflation strategy: even if the client fires three
 * taps, a retry storm hits the API, or two requests race, the row can only
 * exist once. Counts are therefore always derivable and never drift.
 *
 * Adding a new likeable type means adding one resolver below — nothing else.
 */

/** Types that can be liked. Mirrors the ENUM in `content_likes`. */
export const LIKE_TARGETS = ['profile', 'photo', 'post', 'moment', 'comment'];

/** Notification kind per target type. `profile` and `photo` are Phase 4. */
const NOTIFY_KIND = {
  profile: 'profile_like',
  photo: 'photo_like',
  post: 'post_like',
  moment: 'moment_reaction',
  comment: 'post_like'
};

/** Where a like should take you when tapped in the notification centre. */
function deepLink(type, id, actorUsername) {
  switch (type) {
    case 'profile':
    case 'photo':
      return actorUsername ? `/@${actorUsername}` : '/likes';
    // Posts and comments live on /moments (the single social surface), not on
    // a /posts route -- there isn't one. Linking to /posts produced a 404 for
    // every post/comment notification.
    case 'post':
      return `/moments#post-${id}`;
    case 'moment':
      return `/moments#moment-${id}`;
    case 'comment':
      return `/moments#comment-${id}`;
    default:
      return null;
  }
}

/**
 * Resolve a like target to its owner, or null when it is gone.
 *
 * "Gone" deliberately covers three different states that must be
 * indistinguishable to a caller: never existed, soft-deleted by its owner or a
 * moderator, and expired. Ephemeral content that has passed `expires_at` is
 * unreachable here even though the row is still on disk awaiting cleanup —
 * the expiry contract is enforced at read time, not just by the cron.
 */
async function resolveTarget(type, id) {
  switch (type) {
    case 'profile': {
      const row = await queryOne("SELECT id FROM users WHERE id = ? AND status = 'active' LIMIT 1", [id]);
      return row ? { ownerId: Number(row.id) } : null;
    }
    case 'photo': {
      const row = await queryOne('SELECT user_id FROM user_photos WHERE id = ? LIMIT 1', [id]);
      return row ? { ownerId: Number(row.user_id) } : null;
    }
    case 'post': {
      const row = await queryOne(
        'SELECT user_id FROM posts WHERE id = ? AND deleted_at IS NULL AND expires_at > NOW() LIMIT 1',
        [id]
      );
      return row ? { ownerId: Number(row.user_id), counter: { table: 'posts', column: 'like_count' } } : null;
    }
    case 'moment': {
      const row = await queryOne(
        'SELECT user_id FROM moments WHERE id = ? AND deleted_at IS NULL AND expires_at > NOW() LIMIT 1',
        [id]
      );
      return row ? { ownerId: Number(row.user_id) } : null;
    }
    case 'comment': {
      const row = await queryOne(
        'SELECT user_id FROM comments WHERE id = ? AND deleted_at IS NULL AND expires_at > NOW() LIMIT 1',
        [id]
      );
      return row ? { ownerId: Number(row.user_id), counter: { table: 'comments', column: 'like_count' } } : null;
    }
    default:
      return null;
  }
}

function assertType(type) {
  if (!LIKE_TARGETS.includes(type)) throw badRequest('Unknown like target.');
}

/** Live count straight from the source of truth. */
export async function likeCount(type, id) {
  const row = await queryOne(
    'SELECT COUNT(*) AS n FROM content_likes WHERE target_type = ? AND target_id = ?',
    [type, id]
  );
  return Number(row?.n || 0);
}

/** Has this viewer already liked it? */
export async function hasLiked(userId, type, id) {
  if (!userId) return false;
  const row = await queryOne(
    'SELECT 1 AS x FROM content_likes WHERE user_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
    [userId, type, id]
  );
  return Boolean(row);
}

/**
 * Like something. Idempotent: liking twice returns the same state as liking
 * once, with `alreadyLiked: true` so the caller can tell a fresh like from a
 * repeat without the count ever moving twice.
 */
export async function like(userId, type, targetId, { actorUsername = null } = {}) {
  assertType(type);
  const id = Number(targetId);

  const target = await resolveTarget(type, id);
  // Deleted and expired targets are reported exactly like missing ones.
  if (!target) throw notFound('That content is no longer available.');
  if (type === 'profile' && target.ownerId === Number(userId)) {
    throw badRequest('You cannot like your own profile.');
  }

  // Blocking is bidirectional and silent: neither party can like the other,
  // and the error reveals nothing about who blocked whom.
  if (target.ownerId !== Number(userId) && (await isBlockedEitherWay(userId, target.ownerId))) {
    throw notFound('That content is no longer available.');
  }

  const inserted = await withTransaction(async (conn) => {
    // INSERT IGNORE, not ON DUPLICATE KEY UPDATE. MariaDB reports
    // affectedRows: 1 for a no-op `ODKU id = id`, which makes a repeat
    // indistinguishable from a fresh like and double-increments the counter.
    // INSERT IGNORE reports a clean 1 = inserted / 0 = already there.
    const [res] = await conn.execute(
      `INSERT IGNORE INTO content_likes (user_id, target_type, target_id, owner_id)
       VALUES (?,?,?,?)`,
      [userId, type, id, target.ownerId]
    );
    const isNew = res.affectedRows === 1;
    if (isNew && target.counter) {
      await conn.execute(
        `UPDATE ${target.counter.table} SET ${target.counter.column} = ${target.counter.column} + 1 WHERE id = ?`,
        [id]
      );
    }
    return isNew;
  });

  // Only a genuinely new like notifies, so a double-tap cannot spam anyone.
  if (inserted && target.ownerId !== Number(userId)) {
    // The deep link points at the liker's public profile, so resolve their
    // handle here rather than trusting the caller to supply it.
    const handle =
      actorUsername || (await queryOne('SELECT username FROM users WHERE id = ? LIMIT 1', [userId]))?.username;
    await notify({
      userId: target.ownerId,
      actorId: userId,
      kind: NOTIFY_KIND[type],
      targetType: type,
      targetId: id,
      href: deepLink(type, id, handle),
      groupKey: `${NOTIFY_KIND[type]}:${type}:${id}`
    });
  }

  return { liked: true, alreadyLiked: !inserted, count: await likeCount(type, id) };
}

/** Remove a like. Also idempotent — unliking something you never liked is fine. */
export async function unlike(userId, type, targetId) {
  assertType(type);
  const id = Number(targetId);

  const removed = await withTransaction(async (conn) => {
    const [res] = await conn.execute(
      'DELETE FROM content_likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
      [userId, type, id]
    );
    if (res.affectedRows > 0) {
      // Counters live on posts/comments only; resolve lazily so unliking an
      // already-deleted parent still clears the like row.
      if (type === 'post') {
        await conn.execute('UPDATE posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = ?', [id]);
      } else if (type === 'comment') {
        await conn.execute('UPDATE comments SET like_count = GREATEST(like_count - 1, 0) WHERE id = ?', [id]);
      }
    }
    return res.affectedRows > 0;
  });

  // Withdrawing a like withdraws its notification, so an unread badge cannot
  // point at something that no longer happened.
  if (removed) await unnotify(`${NOTIFY_KIND[type]}:${type}:${id}`);

  return { liked: false, removed, count: await likeCount(type, id) };
}

/** Toggle helper for a single button in the UI. */
export async function toggleLike(userId, type, targetId, opts) {
  return (await hasLiked(userId, type, targetId))
    ? unlike(userId, type, targetId)
    : like(userId, type, targetId, opts);
}

/**
 * Batch hydration: counts + whether the viewer liked each item, in two queries
 * regardless of page size. Feeds must never issue a query per row.
 */
export async function hydrateLikes(userId, type, ids) {
  const list = [...new Set(ids.map(Number))].filter(Boolean);
  if (!list.length) return new Map();

  const placeholders = list.map(() => '?').join(',');
  const [counts, mine] = await Promise.all([
    query(
      `SELECT target_id, COUNT(*) AS n FROM content_likes
        WHERE target_type = ? AND target_id IN (${placeholders})
        GROUP BY target_id`,
      [type, ...list]
    ),
    userId
      ? query(
          `SELECT target_id FROM content_likes
            WHERE user_id = ? AND target_type = ? AND target_id IN (${placeholders})`,
          [userId, type, ...list]
        )
      : Promise.resolve([])
  ]);

  const out = new Map(list.map((id) => [id, { count: 0, liked: false }]));
  for (const r of counts) out.get(Number(r.target_id)).count = Number(r.n);
  for (const r of mine) out.get(Number(r.target_id)).liked = true;
  return out;
}

/**
 * Who liked a thing. Blocked users are filtered out so a block really does
 * remove someone from your view of the app, not just from discovery.
 */
export async function likers(viewerId, type, targetId, { limit = 30 } = {}) {
  assertType(type);
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified, cl.created_at
       FROM content_likes cl
       JOIN users u ON u.id = cl.user_id
      WHERE cl.target_type = ? AND cl.target_id = ?
        AND u.status = 'active'
        -- Two indexed lookups, not one OR. The OR form made MariaDB scan the
        -- whole uniq_block index once per candidate; splitting it lets each
        -- half seek. Identical results, ~4x faster on a 50k fixture.
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE b.blocker_id = ? AND b.blocked_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM blocks b2
                         WHERE b2.blocker_id = u.id AND b2.blocked_id = ?)
      ORDER BY cl.created_at DESC
      LIMIT ?`,
    [type, Number(targetId), viewerId, viewerId, String(limit)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    isVerified: Boolean(r.is_verified),
    likedAt: new Date(r.created_at).toISOString()
  }));
}

/** Count of profile likes received — the "N people like you" figure. */
export async function profileLikesReceived(userId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM content_likes cl
       JOIN users u ON u.id = cl.user_id
      WHERE cl.owner_id = ? AND cl.target_type = 'profile' AND u.status = 'active'`,
    [userId]
  );
  return Number(row?.n || 0);
}

/** Remove every like exchanged between two users (used when a block lands). */
export async function purgeLikesBetween(a, b) {
  await execute(
    `DELETE FROM content_likes
      WHERE (user_id = ? AND owner_id = ?) OR (user_id = ? AND owner_id = ?)`,
    [a, b, b, a]
  );
}
