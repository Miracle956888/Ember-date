import { query, queryOne, execute } from '../db/pool.js';
import { notFound, forbidden } from '../utils/errors.js';
import { calcAge } from './auth.service.js';

/**
 * Match list with last (non-expired) message preview + unread count.
 * NOTE the `expires_at > NOW()` guard on both the preview and the counter -
 * expired content must be invisible even before the cleanup job runs.
 */
export async function listMatches(userId) {
  const rows = await query(
    `SELECT
        m.id            AS match_id,
        m.created_at    AS matched_at,
        c.id            AS conversation_id,
        c.last_message_at,
        o.id            AS other_id,
        o.display_name  AS other_name,
        o.birthdate     AS other_birthdate,
        o.avatar_url    AS other_avatar,
        o.is_online     AS other_online,
        o.last_seen_at  AS other_last_seen,
        (SELECT msg.body FROM messages msg
           WHERE msg.conversation_id = c.id AND msg.expires_at > NOW()
           ORDER BY msg.created_at DESC, msg.id DESC LIMIT 1)         AS last_body,
        (SELECT msg.type FROM messages msg
           WHERE msg.conversation_id = c.id AND msg.expires_at > NOW()
           ORDER BY msg.created_at DESC, msg.id DESC LIMIT 1)         AS last_type,
        (SELECT msg.sender_id FROM messages msg
           WHERE msg.conversation_id = c.id AND msg.expires_at > NOW()
           ORDER BY msg.created_at DESC, msg.id DESC LIMIT 1)         AS last_sender_id,
        (SELECT msg.created_at FROM messages msg
           WHERE msg.conversation_id = c.id AND msg.expires_at > NOW()
           ORDER BY msg.created_at DESC, msg.id DESC LIMIT 1)         AS last_at,
        (SELECT COUNT(*) FROM messages msg
           WHERE msg.conversation_id = c.id AND msg.expires_at > NOW()
             AND msg.sender_id <> ? AND msg.read_at IS NULL)          AS unread_count
      FROM matches m
      JOIN conversations c ON c.match_id = m.id
      JOIN users o ON o.id = CASE WHEN m.user_a_id = ? THEN m.user_b_id ELSE m.user_a_id END
     WHERE (m.user_a_id = ? OR m.user_b_id = ?)
       AND NOT EXISTS (
             SELECT 1 FROM blocks b
              WHERE (b.blocker_id = ? AND b.blocked_id = o.id)
                 OR (b.blocker_id = o.id AND b.blocked_id = ?))
     ORDER BY COALESCE(c.last_message_at, m.created_at) DESC`,
    [userId, userId, userId, userId, userId, userId]
  );

  return rows.map((r) => ({
    matchId: Number(r.match_id),
    conversationId: Number(r.conversation_id),
    matchedAt: new Date(r.matched_at).toISOString(),
    unreadCount: Number(r.unread_count || 0),
    lastMessage: r.last_at
      ? {
          body: r.last_type === 'image' ? 'Photo' : r.last_type === 'video' ? 'Video' : r.last_body,
          type: r.last_type,
          fromMe: Number(r.last_sender_id) === userId,
          createdAt: new Date(r.last_at).toISOString()
        }
      : null,
    user: {
      id: Number(r.other_id),
      displayName: r.other_name,
      age: r.other_birthdate ? calcAge(r.other_birthdate) : null,
      avatarUrl: r.other_avatar,
      isOnline: Boolean(r.other_online),
      lastSeenAt: r.other_last_seen ? new Date(r.other_last_seen).toISOString() : null
    }
  }));
}

/** Throws unless `userId` is one of the two participants. Returns the pair. */
export async function assertParticipant(conversationId, userId) {
  const row = await queryOne(
    `SELECT c.id AS conversation_id, m.id AS match_id, m.user_a_id, m.user_b_id
       FROM conversations c
       JOIN matches m ON m.id = c.match_id
      WHERE c.id = ? LIMIT 1`,
    [conversationId]
  );
  if (!row) throw notFound('That conversation does not exist.');

  const a = Number(row.user_a_id);
  const b = Number(row.user_b_id);
  if (a !== userId && b !== userId) {
    throw forbidden('You are not part of that conversation.');
  }
  return {
    conversationId: Number(row.conversation_id),
    matchId: Number(row.match_id),
    userAId: a,
    userBId: b,
    otherUserId: a === userId ? b : a
  };
}

export async function getConversationWithPeer(conversationId, userId) {
  const part = await assertParticipant(conversationId, userId);
  const other = await queryOne(
    `SELECT id, display_name, birthdate, city, bio, avatar_url, is_online, last_seen_at
       FROM users WHERE id = ? LIMIT 1`,
    [part.otherUserId]
  );
  if (!other) throw notFound('That conversation is no longer available.');
  return {
    conversationId: part.conversationId,
    matchId: part.matchId,
    peer: {
      id: Number(other.id),
      displayName: other.display_name,
      age: other.birthdate ? calcAge(other.birthdate) : null,
      city: other.city,
      bio: other.bio,
      avatarUrl: other.avatar_url,
      isOnline: Boolean(other.is_online),
      lastSeenAt: other.last_seen_at ? new Date(other.last_seen_at).toISOString() : null
    }
  };
}

/** Find the conversation for a match the user belongs to. */
export async function getConversationIdForMatch(matchId, userId) {
  const row = await queryOne(
    `SELECT c.id FROM conversations c
       JOIN matches m ON m.id = c.match_id
      WHERE m.id = ? AND (m.user_a_id = ? OR m.user_b_id = ?) LIMIT 1`,
    [matchId, userId, userId]
  );
  if (!row) throw notFound('Match not found.');
  return Number(row.id);
}

/**
 * Unmatch. Returns the file paths that must be unlinked from disk, because the
 * DB cascade removes the attachment rows but not the bytes.
 */
export async function unmatch(matchId, userId) {
  const match = await queryOne(
    'SELECT id, user_a_id, user_b_id FROM matches WHERE id = ? AND (user_a_id = ? OR user_b_id = ?) LIMIT 1',
    [matchId, userId, userId]
  );
  if (!match) throw notFound('Match not found.');

  const files = await query(
    `SELECT a.file_path, a.thumb_path
       FROM attachments a
       JOIN messages msg ON msg.id = a.message_id
       JOIN conversations c ON c.id = msg.conversation_id
      WHERE c.match_id = ?`,
    [matchId]
  );

  await execute('DELETE FROM matches WHERE id = ?', [matchId]);

  return {
    matchId: Number(matchId),
    otherUserId: Number(match.user_a_id) === userId ? Number(match.user_b_id) : Number(match.user_a_id),
    files: files.map((f) => ({ filePath: f.file_path, thumbPath: f.thumb_path }))
  };
}
