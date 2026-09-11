/**
 * All message SQL. LAYER 2 of the ephemerality rule lives here:
 * every single read carries `expires_at > NOW()`, so an expired row is
 * invisible the instant it lapses - never trusting the cleanup job alone.
 */
import { query, queryOne, execute, withTransaction } from '../db/pool.js';
import { notFound, badRequest, forbidden } from '../utils/errors.js';
import { assertParticipant } from './match.service.js';
import { attachLocationToMessage, locationsForMessages } from './location.service.js';
import { inspectMessage, shouldWarnRecipient } from '../utils/safety.js';
import { ttlForConversation } from './ttl.service.js';
import { notify } from './notification.service.js';

function toIso(v) {
  return v ? new Date(v).toISOString() : null;
}

export function shapeMessage(row) {
  const encrypted = Boolean(row.is_encrypted);
  const msg = {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    senderId: Number(row.sender_id),
    // For an E2EE message the server has no plaintext to give: `body` stays
    // null and the client decrypts `envelope` locally.
    body: encrypted ? null : row.body,
    isEncrypted: encrypted,
    envelope: encrypted
      ? { ciphertext: row.ciphertext, iv: row.iv, keyId: row.sender_key_id }
      : null,
    type: row.type,
    clientUuid: row.client_uuid,
    readAt: toIso(row.read_at),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    attachment: null
  };
  if (row.attachment_id) {
    msg.attachment = {
      id: Number(row.attachment_id),
      kind: row.attachment_kind,
      url: `/api/media/${row.attachment_id}`,
      thumbUrl: row.thumb_path ? `/api/media/${row.attachment_id}?variant=thumb` : null,
      mime: row.mime,
      sizeBytes: Number(row.size_bytes || 0),
      width: row.width ? Number(row.width) : null,
      height: row.height ? Number(row.height) : null,
      durationSecs: row.duration_secs ? Number(row.duration_secs) : null
    };
  }
  return msg;
}

/** Merge location rows into already-shaped messages (keyed by message id). */
export function attachLocations(messages, locationMap) {
  for (const m of messages) {
    const loc = locationMap.get(m.id);
    if (loc) m.location = loc;
  }
  return messages;
}

const SELECT_MESSAGE = `
  SELECT msg.id, msg.conversation_id, msg.sender_id, msg.body, msg.type, msg.client_uuid,
         msg.ciphertext, msg.iv, msg.sender_key_id, msg.is_encrypted,
         msg.read_at, msg.created_at, msg.expires_at,
         a.id AS attachment_id, a.kind AS attachment_kind, a.thumb_path, a.mime,
         a.size_bytes, a.width, a.height, a.duration_secs
    FROM messages msg
    LEFT JOIN attachments a ON a.message_id = msg.id AND a.expires_at > NOW()
`;

/** Page of non-expired messages, newest-first cursor via `before` (message id). */
export async function listMessages(conversationId, userId, { before, limit = 30 } = {}) {
  await assertParticipant(conversationId, userId);

  const params = [conversationId];
  let cursorSql = '';
  if (before) {
    cursorSql = ' AND msg.id < ?';
    params.push(before);
  }
  params.push(String(limit));

  const rows = await query(
    `${SELECT_MESSAGE}
      WHERE msg.conversation_id = ?
        AND msg.expires_at > NOW()${cursorSql}
      ORDER BY msg.id DESC
      LIMIT ?`,
    params
  );

  const messages = rows.map(shapeMessage).reverse();

  // Hydrate any shared places. One extra query for the whole page.
  const locIds = messages.filter((m) => m.type === 'location').map((m) => m.id);
  if (locIds.length) attachLocations(messages, await locationsForMessages(locIds));

  return {
    messages,
    hasMore: rows.length === Number(limit),
    nextCursor: messages.length ? messages[0].id : null,
    // The thread's own timer, not the global default — the header renders it.
    ttlHours: await ttlForConversation(conversationId)
  };
}

export async function getMessageById(messageId, userId) {
  const row = await queryOne(`${SELECT_MESSAGE} WHERE msg.id = ? AND msg.expires_at > NOW() LIMIT 1`, [messageId]);
  if (!row) throw notFound('That message is gone.');
  await assertParticipant(Number(row.conversation_id), userId);
  return shapeMessage(row);
}

/**
 * Create a message. LAYER 1: expires_at is always created_at + TTL, computed in
 * SQL so it cannot drift from the DB clock. An attached upload inherits the
 * exact same expiry.
 */
export async function createMessage({
  conversationId, senderId, body, type = 'text', clientUuid, attachmentId, location = null,
  envelope = null,
  // A moment reply already raises its own `moment_reply` notification, so the
  // caller switches this off to stop one action producing two badge pings.
  notifyRecipient = true
}) {
  const part = await assertParticipant(conversationId, senderId);

  const cleanBody = typeof body === 'string' && body.trim() !== '' ? body.trim() : null;

  // An E2EE message carries ciphertext instead of a body. We store the sealed
  // blob verbatim and never a plaintext copy — accepting both would defeat the
  // whole point, so a caller that sends an envelope has its `body` discarded.
  const sealed = envelope && envelope.ciphertext && envelope.iv
    ? { ciphertext: String(envelope.ciphertext), iv: String(envelope.iv), keyId: envelope.keyId || null }
    : null;

  if (!sealed && !cleanBody && !attachmentId && !location) {
    throw badRequest('Write something or attach a file.');
  }

  // De-dupe optimistic retries: same conversation + clientUuid returns the original.
  if (clientUuid) {
    const existing = await queryOne(
      `${SELECT_MESSAGE} WHERE msg.conversation_id = ? AND msg.client_uuid = ? AND msg.expires_at > NOW() LIMIT 1`,
      [conversationId, clientUuid]
    );
    if (existing) return { message: shapeMessage(existing), deduped: true, participants: part };
  }

  let resolvedType = location ? 'location' : type;
  if (attachmentId) {
    const att = await queryOne(
      'SELECT id, kind, owner_id, message_id, expires_at FROM attachments WHERE id = ? LIMIT 1',
      [attachmentId]
    );
    if (!att) throw notFound('That upload has expired. Please attach it again.');
    if (Number(att.owner_id) !== senderId) throw forbidden('That upload is not yours.');
    if (att.message_id) throw badRequest('That upload has already been sent.');
    resolvedType = att.kind === 'video' ? 'video' : 'image';
  }

  // LAYER 1: the expiry comes from THIS conversation's timer, resolved at write
  // time and computed in SQL from the DB clock. Changing the timer later cannot
  // reach back and alter a message that has already been stamped.
  const ttlHours = await ttlForConversation(conversationId);

  const messageId = await withTransaction(async (conn) => {
    const [ins] = await conn.execute(
      `INSERT INTO messages
         (conversation_id, sender_id, body, ciphertext, iv, sender_key_id, is_encrypted,
          type, client_uuid, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR))`,
      [
        conversationId,
        senderId,
        sealed ? null : cleanBody,
        sealed ? sealed.ciphertext : null,
        sealed ? sealed.iv : null,
        sealed ? sealed.keyId : null,
        sealed ? 1 : 0,
        resolvedType,
        clientUuid ?? null,
        ttlHours
      ]
    );
    const id = Number(ins.insertId);

    if (attachmentId) {
      // Attachment expiry is realigned to its message so both die together.
      await conn.execute(
        `UPDATE attachments
            SET message_id = ?, expires_at = (SELECT expires_at FROM messages WHERE id = ?)
          WHERE id = ? AND owner_id = ? AND message_id IS NULL`,
        [id, id, attachmentId, senderId]
      );
    }

    await conn.execute('UPDATE conversations SET last_message_at = NOW() WHERE id = ?', [conversationId]);
    return id;
  });

  if (location) {
    const expiry = await queryOne('SELECT expires_at FROM messages WHERE id = ? LIMIT 1', [messageId]);
    await attachLocationToMessage({
      messageId,
      senderId,
      lat: location.lat,
      lng: location.lng,
      accuracy: location.accuracy,
      label: location.label,
      liveMinutes: location.liveMinutes,
      expiresAt: expiry.expires_at
    });
  }

  const row = await queryOne(`${SELECT_MESSAGE} WHERE msg.id = ? LIMIT 1`, [messageId]);
  const shaped = shapeMessage(row);

  if (location) {
    const map = await locationsForMessages([messageId]);
    attachLocations([shaped], map);
  }

  // Safety heuristic runs on the stored body so the recipient's client can show
  // a "does this bother you?" bar. Nothing is ever blocked here.
  //
  // For an E2EE message there is no server-side plaintext to inspect — that is
  // the trade-off encryption buys, and we take it honestly rather than
  // quietly weakening the encryption to keep the heuristic working. The client
  // runs the same check locally before sealing (see confirmIfRisky).
  const safety = inspectMessage(sealed ? null : cleanBody);
  if (shouldWarnRecipient(safety)) {
    shaped.safety = { category: safety.category, severity: safety.severity, prompt: safety.recipientPrompt };
  }

  // Notify the recipient. This lives in the service rather than the controller
  // because messages arrive through BOTH the REST route and the socket
  // handler; putting it here means neither path can forget it.
  //
  // The group key is per-conversation, so twenty messages in a burst stay one
  // "N new messages" row instead of twenty badge pings. The body is
  // deliberately generic -- never the message text -- because an E2EE thread
  // has no server-readable plaintext and leaking previews for the rest would
  // be inconsistent and privacy-hostile.
  if (notifyRecipient && part?.otherUserId) {
    await notify({
      userId: part.otherUserId,
      actorId: senderId,
      kind: 'message',
      targetType: 'conversation',
      targetId: conversationId,
      href: `/chat?c=${conversationId}`,
      body: 'sent you a message',
      groupKey: `message:conversation:${conversationId}`
    });
  }

  return { message: shaped, deduped: false, participants: part };
}

/** System messages (call outcomes, timer changes) follow the thread's timer. */
export async function createSystemMessage(conversationId, senderId, body) {
  const ttlHours = await ttlForConversation(conversationId);
  const res = await execute(
    `INSERT INTO messages (conversation_id, sender_id, body, type, created_at, expires_at)
     VALUES (?, ?, ?, 'system', NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [conversationId, senderId, body, ttlHours]
  );
  const row = await queryOne(`${SELECT_MESSAGE} WHERE msg.id = ? LIMIT 1`, [res.insertId]);
  await execute('UPDATE conversations SET last_message_at = NOW() WHERE id = ?', [conversationId]);
  return shapeMessage(row);
}

export async function markRead(conversationId, userId) {
  await assertParticipant(conversationId, userId);
  const res = await execute(
    `UPDATE messages SET read_at = NOW()
      WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL AND expires_at > NOW()`,
    [conversationId, userId]
  );
  return { updated: res.affectedRows, readAt: new Date().toISOString() };
}

/**
 * "Clear chat": immediately expire every message in the thread for BOTH users
 * and return the files to unlink. Rows are expired (not just deleted) so any
 * in-flight read is filtered too; the cleanup job removes them permanently.
 */
export async function clearConversation(conversationId, userId) {
  const part = await assertParticipant(conversationId, userId);

  const files = await query(
    `SELECT a.id, a.file_path, a.thumb_path
       FROM attachments a
       JOIN messages msg ON msg.id = a.message_id
      WHERE msg.conversation_id = ?`,
    [conversationId]
  );

  // Soft-expire rather than hard-delete: back-dating expires_at makes the rows
  // invisible to every read query (they all filter `expires_at > NOW()`) and
  // hands the row + file removal to the same cleanup job that handles the 24h
  // purge. One deletion path, so a cleared chat cannot leave orphaned files.
  const result = await withTransaction(async (conn) => {
    const [attRes] = await conn.execute(
      `UPDATE attachments a
         JOIN messages msg ON msg.id = a.message_id
          SET a.expires_at = NOW()
        WHERE msg.conversation_id = ? AND a.expires_at > NOW()`,
      [conversationId]
    );
    const [msgRes] = await conn.execute(
      'UPDATE messages SET expires_at = NOW() WHERE conversation_id = ? AND expires_at > NOW()',
      [conversationId]
    );
    await conn.execute('UPDATE conversations SET last_message_at = NULL WHERE id = ?', [conversationId]);
    return { messages: msgRes.affectedRows, attachments: attRes.affectedRows };
  });

  return {
    deletedMessages: result.messages,
    deletedAttachments: result.attachments,
    // The cleanup job unlinks these on its next pass; callers may purge sooner.
    files: files.map((f) => ({ filePath: f.file_path, thumbPath: f.thumb_path })),
    participants: part
  };
}

export async function countUnread(conversationId, userId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS c FROM messages
      WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL AND expires_at > NOW()`,
    [conversationId, userId]
  );
  return Number(row?.c || 0);
}

/** Messages that expire within the next `withinSeconds` - used to schedule pushes. */
export async function listExpiringSoon(conversationId, withinSeconds = 60) {
  return query(
    `SELECT id, expires_at FROM messages
      WHERE conversation_id = ? AND expires_at > NOW()
        AND expires_at <= DATE_ADD(NOW(), INTERVAL ? SECOND)`,
    [conversationId, withinSeconds]
  );
}
