/**
 * moment.service — ephemeral Stories ("Moments").
 *
 * A Moment is a photo, a video or a text card that lives for 24 hours and then
 * stops existing. It is deliberately NOT an Instagram clone: there is no
 * permanent grid, no follower graph and no archive. Moments exist to give a
 * dating profile a *current* signal — "here is what I am doing today" — which
 * is the thing a static profile can never show.
 *
 * Three rules hold everything together:
 *
 * 1. **Expiry is a read-time contract, not a cron promise.** Every read filters
 *    `expires_at > NOW()`. A Moment is unreachable the instant it expires even
 *    though the row is still on disk waiting for the cleanup sweep, so a slow
 *    or failed cron can never leak content past its lifetime.
 * 2. **Deletion is soft then hard.** `deleted_at` makes it instantly
 *    unreachable; the cleanup job unlinks the bytes. The owner never waits for
 *    the sweep to see it gone.
 * 3. **Blocks are enforced in SQL, both directions.** A blocked user does not
 *    appear in the feed, cannot view, cannot react and cannot reply — and the
 *    responses are 404, never 403, so a block is never confirmable.
 *
 * Visibility model (a stated choice, see AUDIT-V1.md): Moments are visible to
 * every active, non-blocked user rather than to matches only. On a dating
 * product the social layer's job is discovery — a Moment is how someone who has
 * not matched you yet notices you exist. Reply, by contrast, is match-gated,
 * because replying opens a private conversation.
 */
import { query, queryOne, execute, withTransaction } from '../db/pool.js';
import { badRequest, notFound, forbidden, conflict } from '../utils/errors.js';
import { storage } from './storage.service.js';
import * as notificationService from './notification.service.js';
import { sanitizeText } from '../utils/validators.js';
import logger from '../utils/logger.js';

const log = logger.child('moments');

/** Moments always live exactly 24 hours. This is the product promise. */
export const MOMENT_TTL_HOURS = 24;

/** Reactions are a closed set: a free-text emoji field is an abuse vector. */
export const MOMENT_REACTIONS = ['❤️', '🔥', '😂', '😮', '😍', '👏'];

/** Text-moment backgrounds, resolved to real CSS by the client. */
export const MOMENT_BACKGROUNDS = ['ember', 'dusk', 'ocean', 'forest', 'mono'];

const MAX_PER_DAY = 20;

/**
 * The one place a moment row becomes an API object.
 *
 * `viewerId` decides what is included: only the owner ever learns who viewed,
 * and only the owner sees the view count on their own rail.
 */
function shapeMoment(row, viewerId, { reactions = null } = {}) {
  const isOwn = Number(row.user_id) === Number(viewerId);
  const shaped = {
    id: Number(row.id),
    kind: row.kind,
    body: row.body,
    mediaUrl: row.media_url,
    thumbUrl: row.thumb_url,
    background: row.background,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    // Everything ephemeral reports its own remaining life so the UI never has
    // to guess, and so an expired object is obvious even if it is cached.
    secondsLeft: Math.max(0, Math.round((new Date(row.expires_at) - Date.now()) / 1000)),
    isOwn,
    reactionCount: Number(row.reaction_count || 0),
    myReaction: row.my_reaction || null,
    seen: Boolean(row.seen),
    author: {
      id: Number(row.user_id),
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      isVerified: Boolean(row.is_verified)
    }
  };

  // View counts are the author's private analytics, never public pressure.
  // The key is omitted rather than nulled: an absent field cannot be rendered
  // by accident, and it keeps the privacy contract visible in the payload.
  if (isOwn) shaped.viewCount = Number(row.view_count || 0);

  // The per-emoji breakdown is only hydrated for a single moment (the detail
  // view). A feed of 50 moments gets `reactionCount` instead, because a
  // grouped subquery per row is exactly the N+1 this codebase avoids.
  if (reactions) shaped.reactions = reactions;

  return shaped;
}

/** Shared block predicate. Written once so no query can forget it. */
const NOT_BLOCKED = `
  NOT EXISTS (
    SELECT 1 FROM blocks b
     WHERE (b.blocker_id = ? AND b.blocked_id = m.user_id)
        OR (b.blocker_id = m.user_id AND b.blocked_id = ?)
  )`;

const SELECT_MOMENT = `
  SELECT m.id, m.user_id, m.kind, m.body, m.media_url, m.thumb_url, m.background,
         m.view_count, m.created_at, m.expires_at,
         u.username, u.display_name, u.avatar_url,
         u.is_verified,
         (SELECT COUNT(*) FROM moment_reactions r WHERE r.moment_id = m.id) AS reaction_count,
         (SELECT r2.emoji FROM moment_reactions r2 WHERE r2.moment_id = m.id AND r2.user_id = ? LIMIT 1) AS my_reaction,
         (SELECT 1 FROM moment_views v WHERE v.moment_id = m.id AND v.viewer_id = ? LIMIT 1) AS seen
    FROM moments m
    JOIN users u ON u.id = m.user_id`;

const LIVE = "m.deleted_at IS NULL AND m.expires_at > NOW() AND u.status = 'active'";

/**
 * Create a Moment.
 *
 * Media is uploaded first through the normal validated pipeline, so this only
 * ever receives a storage key that has already been magic-byte checked and
 * re-encoded. `expires_at` is computed by the database clock, never the
 * client's, so a wrong device time cannot buy extra lifetime.
 */
export async function createMoment(userId, { kind, body, media, background }) {
  if (!['photo', 'video', 'text'].includes(kind)) throw badRequest('Unknown moment type.');

  const clean = body ? sanitizeText(body).slice(0, 500) : null;

  if (kind === 'text') {
    if (!clean) throw badRequest('Write something for your moment.');
    if (background && !MOMENT_BACKGROUNDS.includes(background)) {
      throw badRequest('Unknown background.');
    }
  } else if (!media?.fileKey) {
    throw badRequest('Attach a photo or video.');
  }

  // Volume cap: cheap, and the only thing standing between us and a feed
  // flooded by one account.
  const recent = await queryOne(
    'SELECT COUNT(*) AS n FROM moments WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)',
    [userId]
  );
  if (Number(recent?.n || 0) >= MAX_PER_DAY) {
    throw conflict(`You can share up to ${MAX_PER_DAY} moments a day. Try again a little later.`);
  }

  const res = await execute(
    `INSERT INTO moments (user_id, kind, body, media_url, thumb_url, media_key, thumb_key, background, expires_at)
     VALUES (?,?,?,?,?,?,?,?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [
      userId,
      kind,
      clean,
      media?.url || null,
      media?.thumbUrl || null,
      media?.fileKey || null,
      media?.thumbKey || null,
      kind === 'text' ? background || 'ember' : null,
      MOMENT_TTL_HOURS
    ]
  );

  return getMoment(Number(res.insertId), userId);
}

/** A single Moment, expiry- and block-checked. */
export async function getMoment(momentId, viewerId) {
  const row = await queryOne(
    `${SELECT_MOMENT} WHERE m.id = ? AND ${LIVE} AND ${NOT_BLOCKED} LIMIT 1`,
    [viewerId, viewerId, momentId, viewerId, viewerId]
  );
  if (!row) throw notFound('That moment is no longer available.');

  // Detail view: hydrate the per-emoji breakdown so the UI can show which
  // reactions a moment actually got, not just how many.
  const grouped = await query(
    'SELECT emoji, COUNT(*) AS n FROM moment_reactions WHERE moment_id = ? GROUP BY emoji ORDER BY n DESC, emoji',
    [momentId]
  );
  const reactions = grouped.map((g) => ({ emoji: g.emoji, count: Number(g.n) }));

  return shapeMoment(row, viewerId, { reactions });
}

/**
 * The Moments feed, grouped into per-author rails the way a stories tray works.
 *
 * Ordering is deliberate and is the whole UX: your own rail first, then rails
 * with something you have not seen, then most recent. Nothing is algorithmic —
 * there is no engagement ranking to game.
 */
export async function feed(viewerId, { limit = 100 } = {}) {
  // Select the NEWEST rows, not the oldest. `ORDER BY created_at ASC LIMIT n`
  // silently truncated the tray from the wrong end: past ~100 live moments the
  // most recent ones fell outside the window and never reached the feed at all.
  // Playback still needs oldest-first within each rail, so the page is flipped
  // back to ascending once it has been chosen.
  const newestFirst = await query(
    `${SELECT_MOMENT}
      WHERE ${LIVE} AND ${NOT_BLOCKED}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`,
    [viewerId, viewerId, viewerId, viewerId, limit]
  );
  const rows = newestFirst.reverse();

  const rails = new Map();
  for (const row of rows) {
    const authorId = Number(row.user_id);
    if (!rails.has(authorId)) {
      rails.set(authorId, {
        author: shapeMoment(row, viewerId).author,
        isOwn: authorId === Number(viewerId),
        moments: []
      });
    }
    rails.get(authorId).moments.push(shapeMoment(row, viewerId));
  }

  const list = [...rails.values()].map((rail) => ({
    ...rail,
    count: rail.moments.length,
    hasUnseen: rail.moments.some((m) => !m.seen),
    latestAt: rail.moments[rail.moments.length - 1].createdAt
  }));

  list.sort((a, b) => {
    if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
    if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
    return new Date(b.latestAt) - new Date(a.latestAt);
  });

  return { rails: list, total: rows.length };
}

/** One author's live moments — used by the profile page and `/@username`. */
export async function byUser(authorId, viewerId) {
  const rows = await query(
    `${SELECT_MOMENT}
      WHERE m.user_id = ? AND ${LIVE} AND ${NOT_BLOCKED}
      ORDER BY m.created_at ASC`,
    [viewerId, viewerId, authorId, viewerId, viewerId]
  );
  return rows.map((r) => shapeMoment(r, viewerId));
}

/**
 * Record a view.
 *
 * `INSERT IGNORE` against the UNIQUE (moment_id, viewer_id) makes this
 * idempotent, so re-opening a moment cannot inflate the count — and the
 * denormalised `view_count` is only bumped when the insert actually happened.
 * (MariaDB reports affectedRows: 1 for a no-op ON DUPLICATE KEY UPDATE, which
 * is exactly why this is INSERT IGNORE and not an upsert.)
 */
export async function recordView(momentId, viewerId) {
  const moment = await getMoment(momentId, viewerId); // authorises + checks expiry
  if (moment.isOwn) return { viewed: false, reason: 'own' };

  const res = await execute('INSERT IGNORE INTO moment_views (moment_id, viewer_id) VALUES (?,?)', [
    momentId,
    viewerId
  ]);
  const isNew = res.affectedRows > 0;
  if (isNew) {
    await execute('UPDATE moments SET view_count = view_count + 1 WHERE id = ?', [momentId]);
  }
  return { viewed: true, firstView: isNew };
}

/** Who saw it. Owner-only: viewer lists are private analytics. */
export async function viewers(momentId, ownerId, { limit = 50 } = {}) {
  const own = await queryOne(
    'SELECT id FROM moments WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1',
    [momentId, ownerId]
  );
  if (!own) throw notFound('That moment is no longer available.');

  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, v.created_at,
            r.emoji AS reaction
       FROM moment_views v
       JOIN users u ON u.id = v.viewer_id
  LEFT JOIN moment_reactions r ON r.moment_id = v.moment_id AND r.user_id = v.viewer_id
      WHERE v.moment_id = ? AND u.status = 'active'
      ORDER BY v.created_at DESC
      LIMIT ?`,
    [momentId, limit]
  );

  return rows.map((r) => ({
    id: Number(r.id),
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    reaction: r.reaction || null,
    viewedAt: new Date(r.created_at).toISOString()
  }));
}

/**
 * React. One reaction per person per moment — sending a different emoji
 * replaces it rather than stacking, so a reaction can never be used to spam a
 * notification feed.
 */
export async function react(momentId, userId, emoji) {
  if (!MOMENT_REACTIONS.includes(emoji)) throw badRequest('Unknown reaction.');
  const moment = await getMoment(momentId, userId);
  if (moment.isOwn) throw badRequest('You cannot react to your own moment.');

  await execute(
    `INSERT INTO moment_reactions (moment_id, user_id, emoji) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), created_at = CURRENT_TIMESTAMP`,
    [momentId, userId, emoji]
  );
  // Reacting implies viewing.
  await execute('INSERT IGNORE INTO moment_views (moment_id, viewer_id) VALUES (?,?)', [momentId, userId]);

  await notificationService.notify({
    userId: moment.author.id,
    actorId: userId,
    kind: 'moment_reaction',
    targetType: 'moment',
    targetId: momentId,
    href: `/moments#moment-${momentId}`,
    body: `reacted ${emoji} to your moment`,
    groupKey: `moment_reaction:moment:${momentId}`
  });

  return getMoment(momentId, userId);
}

export async function unreact(momentId, userId) {
  await execute('DELETE FROM moment_reactions WHERE moment_id = ? AND user_id = ?', [momentId, userId]);
  await notificationService.unnotify(`moment_reaction:moment:${momentId}`);
  return getMoment(momentId, userId);
}

/**
 * Reply to a moment — which means "start or continue a DM about it".
 *
 * Match-gated on purpose. A Moment is public-ish, but a private message is not:
 * letting any stranger open a DM off the back of a story would turn the social
 * layer into an unsolicited-message firehose, which is the single most common
 * complaint about dating products. If there is no match we say so plainly
 * rather than silently dropping the reply.
 */
export async function replyToMoment(momentId, senderId, text) {
  const moment = await getMoment(momentId, senderId);
  if (moment.isOwn) throw badRequest('You cannot reply to your own moment.');

  const clean = sanitizeText(text || '');
  if (!clean) throw badRequest('Write a reply first.');

  const conv = await queryOne(
    `SELECT c.id
       FROM conversations c
       JOIN matches mt ON mt.id = c.match_id
      WHERE (mt.user_a_id = ? AND mt.user_b_id = ?) OR (mt.user_a_id = ? AND mt.user_b_id = ?)
      LIMIT 1`,
    [senderId, moment.author.id, moment.author.id, senderId]
  );
  if (!conv) {
    // 403, not 409: this is "you are not allowed to do this yet", and the
    // viewer can already see the moment, so the reason leaks nothing.
    throw forbidden('You can reply once you match with each other.');
  }

  // A moment reply lands in the DM thread, but it is a *moment* event: gate it
  // on the moments preference and deep-link to the conversation. Coalesced per
  // moment so a chatty replier cannot stack rows.
  await notificationService.notify({
    userId: moment.author.id,
    actorId: senderId,
    kind: 'moment_reply',
    targetType: 'moment',
    targetId: momentId,
    href: `/chat?c=${Number(conv.id)}`,
    body: 'replied to your moment',
    groupKey: `moment_reply:moment:${momentId}`
  });

  return {
    conversationId: Number(conv.id),
    moment,
    // The moment's author is by definition the other side of this
    // conversation, so the caller can address the notify fan-out without a
    // second lookup.
    otherUserId: Number(moment.author.id),
    text: clean.slice(0, 2000)
  };
}

/**
 * Delete. Soft-deletes immediately so it vanishes from every read path, and
 * returns the storage keys so the caller can unlink the bytes right away
 * instead of waiting for the sweep. `deletedBy` records moderator deletions.
 */
export async function deleteMoment(momentId, userId, { asModerator = false } = {}) {
  const row = await queryOne(
    'SELECT id, user_id, media_key, thumb_key FROM moments WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [momentId]
  );
  if (!row) throw notFound('That moment is no longer available.');
  if (!asModerator && Number(row.user_id) !== Number(userId)) {
    throw forbidden('That moment is not yours.');
  }

  await execute('UPDATE moments SET deleted_at = NOW(), deleted_by = ? WHERE id = ?', [userId, momentId]);
  await notificationService.unnotify(`moment_reaction:moment:${momentId}`);

  const keys = [row.media_key, row.thumb_key].filter(Boolean);
  for (const key of keys) {
    try {
      await storage.remove(key);
    } catch (err) {
      // The row is already unreachable; a missing file is not an error worth
      // failing the request over. The sweep will retry.
      log.warn('media unlink failed', { key, error: err.message });
    }
  }

  return { deleted: true, id: momentId, filesRemoved: keys.length };
}

/**
 * Hard-delete every expired moment and unlink its media. Called by the cleanup
 * job — LAYER 3 of the ephemerality rule for the social layer.
 */
export async function purgeExpired({ limit = 2000 } = {}) {
  const rows = await query(
    `SELECT id, media_key, thumb_key FROM moments
      WHERE expires_at <= NOW() OR deleted_at IS NOT NULL
      LIMIT ?`,
    [limit]
  );
  if (!rows.length) return { moments: 0, files: 0 };

  let files = 0;
  for (const row of rows) {
    for (const key of [row.media_key, row.thumb_key].filter(Boolean)) {
      try {
        if (await storage.remove(key)) files += 1;
      } catch {
        /* already gone */
      }
    }
  }

  const ids = rows.map((r) => Number(r.id));
  const placeholders = ids.map(() => '?').join(',');
  // views + reactions cascade with the row.
  const res = await withTransaction(async (conn) => {
    const [out] = await conn.execute(`DELETE FROM moments WHERE id IN (${placeholders})`, ids);
    return out;
  });

  return { moments: res.affectedRows, files };
}

/**
 * Resolve a media basename back to the moment that owns it, for the authorised
 * media route. Returns null when the moment is gone, expired, or the viewer is
 * blocked — so an old URL stops working the moment the content does.
 */
export async function ownerOfMedia(basename, viewerId) {
  const row = await queryOne(
    `SELECT m.id, m.user_id, m.media_key, m.thumb_key
       FROM moments m
       JOIN users u ON u.id = m.user_id
      WHERE (m.media_key LIKE ? OR m.thumb_key LIKE ?)
        AND ${LIVE} AND ${NOT_BLOCKED}
      LIMIT 1`,
    [`%${basename}`, `%${basename}`, viewerId, viewerId]
  );
  return row ? { momentId: Number(row.id), ownerId: Number(row.user_id) } : null;
}
