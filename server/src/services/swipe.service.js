import { queryOne, execute, withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../utils/errors.js';
import { isBlockedEitherWay } from './user.service.js';
import { calcAge } from './auth.service.js';
import { notify } from './notification.service.js';

/**
 * Record a swipe. If the other user already liked us, create the match plus its
 * conversation atomically and report matched: true.
 */
export async function recordSwipe(swiperId, swipeeId, direction) {
  if (swiperId === swipeeId) throw badRequest('You cannot swipe on yourself.');

  const target = await queryOne('SELECT id, display_name, avatar_url FROM users WHERE id = ? LIMIT 1', [swipeeId]);
  if (!target) throw notFound('That profile is no longer available.');

  if (await isBlockedEitherWay(swiperId, swipeeId)) {
    throw notFound('That profile is no longer available.');
  }

  await execute(
    `INSERT INTO swipes (swiper_id, swipee_id, direction) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE direction = VALUES(direction), created_at = CURRENT_TIMESTAMP`,
    [swiperId, swipeeId, direction]
  );

  // A superlike counts as a like for matching purposes.
  if (direction === 'pass') return { matched: false };

  const reciprocal = await queryOne(
    "SELECT id FROM swipes WHERE swiper_id = ? AND swipee_id = ? AND direction IN ('like','superlike') LIMIT 1",
    [swipeeId, swiperId]
  );
  if (!reciprocal) return { matched: false };

  const userA = Math.min(swiperId, swipeeId);
  const userB = Math.max(swiperId, swipeeId);

  const result = await withTransaction(async (conn) => {
    const [existingRows] = await conn.execute(
      'SELECT id FROM matches WHERE user_a_id = ? AND user_b_id = ? LIMIT 1',
      [userA, userB]
    );
    let matchId;
    if (existingRows.length) {
      matchId = Number(existingRows[0].id);
    } else {
      const [ins] = await conn.execute('INSERT INTO matches (user_a_id, user_b_id) VALUES (?,?)', [userA, userB]);
      matchId = Number(ins.insertId);
    }

    const [convRows] = await conn.execute('SELECT id FROM conversations WHERE match_id = ? LIMIT 1', [matchId]);
    let conversationId;
    if (convRows.length) {
      conversationId = Number(convRows[0].id);
    } else {
      const [convIns] = await conn.execute('INSERT INTO conversations (match_id) VALUES (?)', [matchId]);
      conversationId = Number(convIns.insertId);
    }
    return { matchId, conversationId };
  });

  const other = await queryOne(
    'SELECT id, display_name, birthdate, city, avatar_url FROM users WHERE id = ? LIMIT 1',
    [swipeeId]
  );

  // Both sides get a persisted, deep-linked notification. The socket event
  // fired by the controller only reaches someone who is online right now.
  const me = await queryOne('SELECT display_name FROM users WHERE id = ? LIMIT 1', [swiperId]);
  await Promise.all([
    notify({
      userId: swipeeId,
      actorId: swiperId,
      kind: 'match',
      targetType: 'match',
      targetId: result.matchId,
      href: `/chat?c=${result.conversationId}`,
      body: `You matched with ${me?.display_name || 'someone new'}`,
      groupKey: `match:${result.matchId}:${swipeeId}`
    }),
    notify({
      userId: swiperId,
      actorId: swipeeId,
      kind: 'match',
      targetType: 'match',
      targetId: result.matchId,
      href: `/chat?c=${result.conversationId}`,
      body: `You matched with ${other?.display_name || 'someone new'}`,
      groupKey: `match:${result.matchId}:${swiperId}`
    })
  ]);

  return {
    matched: true,
    matchId: result.matchId,
    conversationId: result.conversationId,
    user: {
      id: Number(other.id),
      displayName: other.display_name,
      age: other.birthdate ? calcAge(other.birthdate) : null,
      city: other.city,
      avatarUrl: other.avatar_url
    }
  };
}

/** Undo the most recent swipe (the "Rewind" button). */
export async function rewindLastSwipe(swiperId) {
  const last = await queryOne(
    'SELECT id, swipee_id, direction FROM swipes WHERE swiper_id = ? ORDER BY id DESC LIMIT 1',
    [swiperId]
  );
  if (!last) throw badRequest('There is nothing to rewind.');

  const userA = Math.min(swiperId, Number(last.swipee_id));
  const userB = Math.max(swiperId, Number(last.swipee_id));
  const match = await queryOne('SELECT id FROM matches WHERE user_a_id = ? AND user_b_id = ? LIMIT 1', [userA, userB]);
  if (match) {
    // Rewinding a swipe that produced a match also removes the match + chat.
    await execute('DELETE FROM matches WHERE id = ?', [match.id]);
  }
  await execute('DELETE FROM swipes WHERE id = ?', [last.id]);
  return { rewoundUserId: Number(last.swipee_id), direction: last.direction, matchRemoved: Boolean(match) };
}

export async function countLikesReceived(userId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS c FROM swipes s
      WHERE s.swipee_id = ? AND s.direction IN ('like','superlike')
        AND NOT EXISTS (SELECT 1 FROM swipes m WHERE m.swiper_id = ? AND m.swipee_id = s.swiper_id)`,
    [userId, userId]
  );
  return Number(row?.c || 0);
}
