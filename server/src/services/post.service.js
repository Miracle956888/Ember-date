/**
 * post.service — 24-hour posts, polls, comments and threaded replies.
 *
 * A Post is the conversational half of the social layer: text, up to four
 * photos/videos, and optionally a poll. Like Moments it lives 24 hours, so the
 * feed is always *today*. Nothing here accrues into a permanent timeline —
 * there is no profile grid to curate and no old post to be judged by, which is
 * the entire point of an ephemeral social layer on a dating product.
 *
 * Design decisions worth stating:
 *
 * - **Comments inherit the post's expiry, exactly.** A comment cannot outlive
 *   the thing it is about; otherwise a reply would become an orphan quoting
 *   content nobody can see. `expires_at` is copied from the parent post at
 *   write time.
 * - **Threads are one level deep.** Comment → reply, and no further. Deeper
 *   nesting is unreadable on a phone and is a moderation nightmare; replying to
 *   a reply attaches to the same top-level comment, which is what Instagram and
 *   YouTube settled on too.
 * - **Counters are denormalised but never authoritative.** `like_count` and
 *   `comment_count` exist so a feed of 50 posts is 3 queries instead of 150.
 *   The `content_likes` UNIQUE key remains the source of truth, so a double-tap
 *   still cannot inflate anything.
 * - **Polls are one vote per person, changeable.** Changing your vote moves the
 *   counter rather than adding one, enforced by UNIQUE (post_id, user_id).
 */
import { query, queryOne, execute, withTransaction } from '../db/pool.js';
import { badRequest, notFound, forbidden, conflict } from '../utils/errors.js';
import { storage } from './storage.service.js';
import * as notificationService from './notification.service.js';
import * as likeService from './like.service.js';
import { sanitizeText } from '../utils/validators.js';
import logger from '../utils/logger.js';

const log = logger.child('posts');

/** Posts live 24 hours, same promise as Moments. */
export const POST_TTL_HOURS = 24;

export const MAX_MEDIA_PER_POST = 4;
export const MAX_POLL_OPTIONS = 4;
const MIN_POLL_OPTIONS = 2;
const MAX_PER_DAY = 30;

const NOT_BLOCKED = `
  NOT EXISTS (
    SELECT 1 FROM blocks b
     WHERE (b.blocker_id = ? AND b.blocked_id = p.user_id)
        OR (b.blocker_id = p.user_id AND b.blocked_id = ?)
  )`;

const LIVE = "p.deleted_at IS NULL AND p.expires_at > NOW() AND u.status = 'active'";

const SELECT_POST = `
  SELECT p.id, p.user_id, p.body, p.like_count, p.comment_count, p.created_at, p.expires_at,
         u.username, u.display_name, u.avatar_url, u.is_verified,
         (SELECT 1 FROM content_likes cl
           WHERE cl.target_type = 'post' AND cl.target_id = p.id AND cl.user_id = ? LIMIT 1) AS liked
    FROM posts p
    JOIN users u ON u.id = p.user_id`;

function shapePost(row, viewerId, { media = [], poll = null } = {}) {
  return {
    id: Number(row.id),
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    secondsLeft: Math.max(0, Math.round((new Date(row.expires_at) - Date.now()) / 1000)),
    likeCount: Number(row.like_count || 0),
    commentCount: Number(row.comment_count || 0),
    liked: Boolean(row.liked),
    isOwn: Number(row.user_id) === Number(viewerId),
    media,
    poll,
    author: {
      id: Number(row.user_id),
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      isVerified: Boolean(row.is_verified)
    }
  };
}

function shapeComment(row, viewerId) {
  return {
    id: Number(row.id),
    postId: Number(row.post_id),
    parentId: row.parent_id ? Number(row.parent_id) : null,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    likeCount: Number(row.like_count || 0),
    liked: Boolean(row.liked),
    isOwn: Number(row.user_id) === Number(viewerId),
    replies: [],
    author: {
      id: Number(row.user_id),
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      isVerified: Boolean(row.is_verified)
    }
  };
}

/* ------------------------------------------------------------------ *
 * Media + poll hydration
 * ------------------------------------------------------------------ */

async function mediaFor(postIds) {
  if (!postIds.length) return new Map();
  const ph = postIds.map(() => '?').join(',');
  const rows = await query(
    `SELECT post_id, id, kind, url, thumb_url, position
       FROM post_media WHERE post_id IN (${ph}) ORDER BY post_id, position`,
    postIds
  );
  const map = new Map();
  for (const r of rows) {
    const key = Number(r.post_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      id: Number(r.id),
      kind: r.kind,
      url: r.url,
      thumbUrl: r.thumb_url,
      position: Number(r.position)
    });
  }
  return map;
}

/**
 * Poll state for a set of posts.
 *
 * Results are always returned — hiding them until you vote is a dark pattern
 * that exists to coerce engagement, and this product does not need it.
 */
async function pollsFor(postIds, viewerId) {
  if (!postIds.length) return new Map();
  const ph = postIds.map(() => '?').join(',');
  const [options, votes] = await Promise.all([
    query(
      `SELECT id, post_id, label, position, vote_count
         FROM poll_options WHERE post_id IN (${ph}) ORDER BY post_id, position`,
      postIds
    ),
    query(
      `SELECT post_id, option_id FROM poll_votes WHERE post_id IN (${ph}) AND user_id = ?`,
      [...postIds, viewerId]
    )
  ]);

  const myVote = new Map(votes.map((v) => [Number(v.post_id), Number(v.option_id)]));
  const map = new Map();
  for (const o of options) {
    const key = Number(o.post_id);
    if (!map.has(key)) map.set(key, { options: [], totalVotes: 0, myOptionId: myVote.get(key) ?? null });
    const poll = map.get(key);
    poll.options.push({
      id: Number(o.id),
      label: o.label,
      position: Number(o.position),
      votes: Number(o.vote_count || 0)
    });
    poll.totalVotes += Number(o.vote_count || 0);
  }
  // Percentages are computed here so every client renders the same rounding.
  for (const poll of map.values()) {
    for (const opt of poll.options) {
      opt.percent = poll.totalVotes ? Math.round((opt.votes / poll.totalVotes) * 100) : 0;
      opt.isMine = opt.id === poll.myOptionId;
    }
    poll.hasVoted = poll.myOptionId !== null;
  }
  return map;
}

async function hydrate(rows, viewerId) {
  const ids = rows.map((r) => Number(r.id));
  const [media, polls] = await Promise.all([mediaFor(ids), pollsFor(ids, viewerId)]);
  return rows.map((r) =>
    shapePost(r, viewerId, { media: media.get(Number(r.id)) || [], poll: polls.get(Number(r.id)) || null })
  );
}

/* ------------------------------------------------------------------ *
 * Posts
 * ------------------------------------------------------------------ */

export async function createPost(userId, { body, media = [], poll = null }) {
  const clean = body ? sanitizeText(body).slice(0, 1000) : null;

  if (!clean && !media.length) throw badRequest('Write something or add a photo.');
  if (media.length > MAX_MEDIA_PER_POST) {
    throw badRequest(`A post can hold up to ${MAX_MEDIA_PER_POST} photos or videos.`);
  }

  let pollOptions = null;
  if (poll) {
    const labels = (Array.isArray(poll.options) ? poll.options : [])
      .map((l) => sanitizeText(String(l)).slice(0, 80))
      .filter(Boolean);
    if (labels.length < MIN_POLL_OPTIONS) throw badRequest('A poll needs at least two options.');
    if (labels.length > MAX_POLL_OPTIONS) throw badRequest(`A poll can have up to ${MAX_POLL_OPTIONS} options.`);
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
      throw badRequest('Poll options must be different from each other.');
    }
    if (!clean) throw badRequest('Give your poll a question.');
    pollOptions = labels;
  }

  const recent = await queryOne(
    'SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)',
    [userId]
  );
  if (Number(recent?.n || 0) >= MAX_PER_DAY) {
    throw conflict(`You can share up to ${MAX_PER_DAY} posts a day. Try again a little later.`);
  }

  // One transaction: a post with half its media or a poll with no options is
  // not a state the feed should ever have to render.
  const postId = await withTransaction(async (conn) => {
    const [res] = await conn.execute(
      'INSERT INTO posts (user_id, body, expires_at) VALUES (?,?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
      [userId, clean, POST_TTL_HOURS]
    );
    const id = Number(res.insertId);

    for (const [i, m] of media.entries()) {
      await conn.execute(
        `INSERT INTO post_media (post_id, kind, url, thumb_url, media_key, thumb_key, position)
         VALUES (?,?,?,?,?,?,?)`,
        [id, m.kind, m.url, m.thumbUrl || null, m.fileKey, m.thumbKey || null, i]
      );
    }

    if (pollOptions) {
      for (const [i, label] of pollOptions.entries()) {
        await conn.execute('INSERT INTO poll_options (post_id, label, position) VALUES (?,?,?)', [id, label, i]);
      }
    }
    return id;
  });

  return getPost(postId, userId);
}

export async function getPost(postId, viewerId) {
  const row = await queryOne(
    `${SELECT_POST} WHERE p.id = ? AND ${LIVE} AND ${NOT_BLOCKED} LIMIT 1`,
    [viewerId, postId, viewerId, viewerId]
  );
  if (!row) throw notFound('That post is no longer available.');
  const [shaped] = await hydrate([row], viewerId);
  return shaped;
}

/**
 * The feed: newest first, cursor-paginated.
 *
 * The cursor is the last id seen rather than an OFFSET, so scrolling stays
 * O(1) as the feed grows and a post arriving mid-scroll cannot shift the page
 * and make you see a duplicate.
 */
export async function feed(viewerId, { limit = 20, before = null, authorId = null } = {}) {
  const params = [viewerId];
  let where = `${LIVE} AND ${NOT_BLOCKED}`;
  params.push(viewerId, viewerId);

  if (authorId) {
    where += ' AND p.user_id = ?';
    params.push(authorId);
  }
  if (before) {
    where += ' AND p.id < ?';
    params.push(before);
  }
  params.push(limit);

  const rows = await query(`${SELECT_POST} WHERE ${where} ORDER BY p.id DESC LIMIT ?`, params);
  const posts = await hydrate(rows, viewerId);
  return {
    posts,
    nextCursor: posts.length === limit ? posts[posts.length - 1].id : null
  };
}

export async function deletePost(postId, userId, { asModerator = false } = {}) {
  const row = await queryOne('SELECT id, user_id FROM posts WHERE id = ? AND deleted_at IS NULL LIMIT 1', [
    postId
  ]);
  if (!row) throw notFound('That post is no longer available.');
  if (!asModerator && Number(row.user_id) !== Number(userId)) throw forbidden('That post is not yours.');

  const media = await query('SELECT media_key, thumb_key FROM post_media WHERE post_id = ?', [postId]);

  await execute('UPDATE posts SET deleted_at = NOW(), deleted_by = ? WHERE id = ?', [userId, postId]);
  // Comments die with their parent, immediately and not just at read time.
  await execute('UPDATE comments SET deleted_at = NOW(), deleted_by = ? WHERE post_id = ? AND deleted_at IS NULL', [
    userId,
    postId
  ]);
  await notificationService.unnotify(`post_like:post:${postId}`);
  await notificationService.unnotify(`post_comment:post:${postId}`);

  let files = 0;
  for (const m of media) {
    for (const key of [m.media_key, m.thumb_key].filter(Boolean)) {
      try {
        if (await storage.remove(key)) files += 1;
      } catch (err) {
        log.warn('media unlink failed', { key, error: err.message });
      }
    }
  }

  return { deleted: true, id: postId, filesRemoved: files };
}

/* ------------------------------------------------------------------ *
 * Polls
 * ------------------------------------------------------------------ */

/**
 * Vote, or change an existing vote.
 *
 * The whole thing is one transaction because a vote touches three rows: the
 * old option's counter down, the new one's up, and the vote record. A crash
 * between them would leave a poll whose numbers do not add up.
 */
export async function vote(postId, userId, optionId) {
  const post = await getPost(postId, userId); // authorises, checks expiry + blocks
  if (!post.poll) throw badRequest('That post has no poll.');

  const option = await queryOne('SELECT id FROM poll_options WHERE id = ? AND post_id = ? LIMIT 1', [
    optionId,
    postId
  ]);
  if (!option) throw badRequest('That option is not on this poll.');

  await withTransaction(async (conn) => {
    const [[existing]] = await conn.execute(
      'SELECT option_id FROM poll_votes WHERE post_id = ? AND user_id = ? LIMIT 1',
      [postId, userId]
    );

    if (existing) {
      if (Number(existing.option_id) === Number(optionId)) return; // idempotent
      await conn.execute('UPDATE poll_options SET vote_count = vote_count - 1 WHERE id = ? AND vote_count > 0', [
        existing.option_id
      ]);
      await conn.execute('UPDATE poll_votes SET option_id = ? WHERE post_id = ? AND user_id = ?', [
        optionId,
        postId,
        userId
      ]);
    } else {
      await conn.execute('INSERT INTO poll_votes (post_id, option_id, user_id) VALUES (?,?,?)', [
        postId,
        optionId,
        userId
      ]);
    }
    await conn.execute('UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ?', [optionId]);
  });

  return getPost(postId, userId);
}

/* ------------------------------------------------------------------ *
 * Comments and threaded replies
 * ------------------------------------------------------------------ */

/**
 * Add a comment, or a reply to one.
 *
 * Replying to a reply re-parents to the top-level comment: threads stay one
 * level deep no matter what the client sends.
 */
export async function addComment(postId, userId, { body, parentId = null }) {
  const post = await getPost(postId, userId);

  const clean = sanitizeText(body || '').slice(0, 500);
  if (!clean) throw badRequest('Write something first.');

  let resolvedParent = null;
  let replyToUserId = null;

  if (parentId) {
    const parent = await queryOne(
      `SELECT id, user_id, parent_id FROM comments
        WHERE id = ? AND post_id = ? AND deleted_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [parentId, postId]
    );
    if (!parent) throw notFound('That comment is no longer available.');
    // Flatten: a reply to a reply belongs to the same top-level comment.
    resolvedParent = parent.parent_id ? Number(parent.parent_id) : Number(parent.id);
    replyToUserId = Number(parent.user_id);
  }

  // The comment inherits the post's expiry to the second, so it can never
  // outlive the thing it is replying to.
  const res = await execute(
    `INSERT INTO comments (post_id, user_id, parent_id, body, expires_at)
     SELECT ?, ?, ?, ?, p.expires_at FROM posts p WHERE p.id = ?`,
    [postId, userId, resolvedParent, clean, postId]
  );
  const commentId = Number(res.insertId);

  await execute('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?', [postId]);

  // Notify the post author, and the comment author when this is a reply.
  // Never both for the same person, and never yourself (notify() drops self).
  if (replyToUserId && replyToUserId !== Number(userId)) {
    await notificationService.notify({
      userId: replyToUserId,
      actorId: userId,
      kind: 'comment_reply',
      targetType: 'comment',
      targetId: commentId,
      // Posts are mounted on the /moments page; there is no /posts route.
      href: `/moments#comment-${commentId}`,
      body: 'replied to your comment',
      groupKey: `comment_reply:comment:${resolvedParent}`
    });
  }
  if (post.author.id !== Number(userId) && post.author.id !== replyToUserId) {
    await notificationService.notify({
      userId: post.author.id,
      actorId: userId,
      kind: 'post_comment',
      targetType: 'post',
      targetId: postId,
      href: `/moments#post-${postId}`,
      body: 'commented on your post',
      groupKey: `post_comment:post:${postId}`
    });
  }

  return getComment(commentId, userId);
}

export async function getComment(commentId, viewerId) {
  const row = await queryOne(
    `SELECT c.id, c.post_id, c.user_id, c.parent_id, c.body, c.like_count, c.created_at,
            u.username, u.display_name, u.avatar_url, u.is_verified,
            (SELECT 1 FROM content_likes cl
              WHERE cl.target_type = 'comment' AND cl.target_id = c.id AND cl.user_id = ? LIMIT 1) AS liked
       FROM comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.id = ? AND c.deleted_at IS NULL AND c.expires_at > NOW() AND u.status = 'active'
      LIMIT 1`,
    [viewerId, commentId]
  );
  if (!row) throw notFound('That comment is no longer available.');
  return shapeComment(row, viewerId);
}

/**
 * All live comments on a post, nested one level.
 *
 * Fetched flat in a single query and assembled in memory — a thread is small
 * enough that this beats a recursive CTE, and it keeps the ordering explicit:
 * top-level comments oldest-first (so a conversation reads top to bottom),
 * replies likewise.
 */
export async function listComments(postId, viewerId, { limit = 100 } = {}) {
  await getPost(postId, viewerId); // authorises + enforces expiry/blocks

  const rows = await query(
    `SELECT c.id, c.post_id, c.user_id, c.parent_id, c.body, c.like_count, c.created_at,
            u.username, u.display_name, u.avatar_url, u.is_verified,
            (SELECT 1 FROM content_likes cl
              WHERE cl.target_type = 'comment' AND cl.target_id = c.id AND cl.user_id = ? LIMIT 1) AS liked
       FROM comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ? AND c.deleted_at IS NULL AND c.expires_at > NOW()
        AND u.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = ? AND b.blocked_id = c.user_id)
              OR (b.blocker_id = c.user_id AND b.blocked_id = ?)
        )
      ORDER BY c.created_at ASC
      LIMIT ?`,
    [viewerId, postId, viewerId, viewerId, limit]
  );

  const byId = new Map();
  const top = [];
  for (const row of rows) {
    const c = shapeComment(row, viewerId);
    byId.set(c.id, c);
    if (!c.parentId) top.push(c);
  }
  for (const c of byId.values()) {
    if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId).replies.push(c);
  }

  return { comments: top, total: rows.length };
}

/**
 * Resolve which post a comment belongs to, for deep links.
 *
 * A notification says "X replied to your comment" and links to
 * `/moments#comment-<id>`, but the client cannot open the right thread without
 * knowing the parent post. This runs the same LIVE + NOT_BLOCKED gate as every
 * other read, so a deep link cannot be used to confirm the existence of an
 * expired post or reach a blocked user's thread.
 */
export async function commentContext(commentId, viewerId) {
  const row = await queryOne(
    `SELECT c.id, c.post_id
       FROM comments c
       JOIN posts p ON p.id = c.post_id
       JOIN users u ON u.id = p.user_id
      WHERE c.id = ? AND c.deleted_at IS NULL AND ${LIVE} AND ${NOT_BLOCKED}
      LIMIT 1`,
    [commentId, viewerId, viewerId]
  );
  if (!row) throw notFound('That comment is no longer available.');
  return { commentId: Number(row.id), postId: Number(row.post_id) };
}

export async function deleteComment(commentId, userId, { asModerator = false } = {}) {
  const row = await queryOne(
    `SELECT c.id, c.user_id, c.post_id, p.user_id AS post_owner
       FROM comments c JOIN posts p ON p.id = c.post_id
      WHERE c.id = ? AND c.deleted_at IS NULL LIMIT 1`,
    [commentId]
  );
  if (!row) throw notFound('That comment is no longer available.');

  // Moderation hook: the post's author may remove comments on their own post,
  // which is the lightest-weight moderation tool there is and stops a thread
  // being hijacked without waiting for staff.
  const isAuthor = Number(row.user_id) === Number(userId);
  const isPostOwner = Number(row.post_owner) === Number(userId);
  if (!asModerator && !isAuthor && !isPostOwner) throw forbidden('That comment is not yours.');

  // Deleting a top-level comment takes its replies with it.
  const res = await execute(
    'UPDATE comments SET deleted_at = NOW(), deleted_by = ? WHERE (id = ? OR parent_id = ?) AND deleted_at IS NULL',
    [userId, commentId, commentId]
  );
  const removed = res.affectedRows;

  await execute('UPDATE posts SET comment_count = GREATEST(comment_count - ?, 0) WHERE id = ?', [
    removed,
    row.post_id
  ]);
  await notificationService.unnotify(`comment_reply:comment:${commentId}`);

  return { deleted: true, id: commentId, removed, removedBy: isAuthor ? 'author' : isPostOwner ? 'post_owner' : 'moderator' };
}

/* ------------------------------------------------------------------ *
 * Likes — delegated to the one polymorphic primitive
 * ------------------------------------------------------------------ */

/**
 * Posts and comments reuse `like.service` rather than growing their own like
 * tables. That service already resolves owners, rejects expired/deleted/blocked
 * targets and keeps the denormalised counters in step, so there is exactly one
 * definition of "liked" in the product.
 */
export async function likePost(postId, userId, actorUsername) {
  return likeService.toggleLike(userId, 'post', postId, { actorUsername });
}

export async function likeComment(commentId, userId, actorUsername) {
  return likeService.toggleLike(userId, 'comment', commentId, { actorUsername });
}

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */

/** Hard-delete expired posts + their media. Comments cascade with the post. */
export async function purgeExpired({ limit = 2000 } = {}) {
  const rows = await query(
    `SELECT id FROM posts WHERE expires_at <= NOW() OR deleted_at IS NOT NULL LIMIT ?`,
    [limit]
  );
  if (!rows.length) return { posts: 0, files: 0 };

  const ids = rows.map((r) => Number(r.id));
  const ph = ids.map(() => '?').join(',');

  const media = await query(`SELECT media_key, thumb_key FROM post_media WHERE post_id IN (${ph})`, ids);
  let files = 0;
  for (const m of media) {
    for (const key of [m.media_key, m.thumb_key].filter(Boolean)) {
      try {
        if (await storage.remove(key)) files += 1;
      } catch {
        /* already gone */
      }
    }
  }

  const res = await execute(`DELETE FROM posts WHERE id IN (${ph})`, ids);
  return { posts: res.affectedRows, files };
}

/** Sweep comments orphaned by their own expiry (a post may outlive a rewrite). */
export async function purgeExpiredComments({ limit = 5000 } = {}) {
  // MySQL prepared statements do not accept a placeholder in DELETE ... LIMIT,
  // so the bound is coerced to a safe integer and inlined.
  const n = Math.max(1, Math.min(20000, Number.parseInt(limit, 10) || 5000));
  const res = await execute(
    `DELETE FROM comments WHERE (expires_at <= NOW() OR deleted_at IS NOT NULL) LIMIT ${n}`
  );
  return { comments: res.affectedRows };
}

/** Resolve post media back to its owner for the authorised media route. */
export async function ownerOfMedia(basename, viewerId) {
  const row = await queryOne(
    `SELECT p.id, p.user_id
       FROM post_media pm
       JOIN posts p ON p.id = pm.post_id
       JOIN users u ON u.id = p.user_id
      WHERE (pm.media_key LIKE ? OR pm.thumb_key LIKE ?)
        AND ${LIVE} AND ${NOT_BLOCKED}
      LIMIT 1`,
    [`%${basename}`, `%${basename}`, viewerId, viewerId]
  );
  return row ? { postId: Number(row.id), ownerId: Number(row.user_id) } : null;
}
