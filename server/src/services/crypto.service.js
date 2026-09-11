/**
 * crypto.service — the server half of end-to-end encryption.
 *
 * WHAT THIS FILE DELIBERATELY CANNOT DO
 * -------------------------------------
 * There is no decrypt function here, and there cannot be one. The server:
 *   - stores device PUBLIC keys only;
 *   - stores conversation keys only in wrapped (sealed) form, one copy per
 *     recipient device, wrapped client-side to that device's public key;
 *   - stores message ciphertext + IV and never the plaintext.
 *
 * The private halves are generated in the browser via WebCrypto with
 * `extractable: false` and stored in IndexedDB. They are never transmitted.
 * That is what makes this genuine E2EE rather than encryption-at-rest.
 *
 * HONEST LIMITS (stated plainly, and mirrored in the UI copy):
 *   - This is TOFU (trust on first use). The server distributes public keys,
 *     so a malicious server could serve a substituted key. Real protection
 *     against that needs an out-of-band safety-number comparison, which the
 *     client exposes as a fingerprint both people can read aloud.
 *   - Metadata is NOT encrypted: who talks to whom, when, and how often is
 *     visible to the server. Only message content is sealed.
 *   - Anyone holding an unlocked device can read the messages on it.
 * We never claim "nobody can ever read this".
 */
import { query, queryOne, execute } from '../db/pool.js';
import { badRequest, notFound } from '../utils/errors.js';
import { assertParticipant } from './match.service.js';
import logger from '../utils/logger.js';

const log = logger.child ? logger.child('crypto') : logger;

/** A device may publish at most this many keys before old ones are pruned. */
export const MAX_DEVICES_PER_USER = 10;

/* ------------------------------------------------------------------ *
 * Device keys
 * ------------------------------------------------------------------ */

/**
 * Register (or refresh) a device's public key.
 *
 * Re-registering the same device_id with the SAME key is a no-op heartbeat.
 * Re-registering with a DIFFERENT key is a legitimate key rotation (the user
 * cleared browser storage, say) — we overwrite, and every conversation that
 * device participates in will need a fresh wrapped key, which the client
 * detects by finding no readable key for the new device.
 */
export async function registerDevice(userId, { deviceId, publicKey, algorithm = 'ECDH-P256', label = null }) {
  if (!deviceId || !publicKey) throw badRequest('A device id and public key are required.');

  await execute(
    `INSERT INTO user_devices (user_id, device_id, public_key, algorithm, label, last_used_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       public_key   = VALUES(public_key),
       algorithm    = VALUES(algorithm),
       label        = COALESCE(VALUES(label), label),
       revoked_at   = NULL,
       last_used_at = NOW()`,
    [userId, deviceId, publicKey, algorithm, label]
  );

  // Keep the device list bounded: prune the oldest beyond the cap.
  const devices = await query(
    'SELECT id FROM user_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_used_at DESC, id DESC',
    [userId]
  );
  if (devices.length > MAX_DEVICES_PER_USER) {
    const stale = devices.slice(MAX_DEVICES_PER_USER).map((d) => Number(d.id));
    const ph = stale.map(() => '?').join(',');
    await execute(`UPDATE user_devices SET revoked_at = NOW() WHERE id IN (${ph})`, stale);
    log.info('pruned stale devices', { userId, count: stale.length });
  }

  const row = await queryOne(
    'SELECT device_id, public_key, algorithm, created_at FROM user_devices WHERE user_id = ? AND device_id = ? LIMIT 1',
    [userId, deviceId]
  );
  return shapeDevice(row);
}

function shapeDevice(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    publicKey: row.public_key,
    algorithm: row.algorithm,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
  };
}

/** Every active device of one user. */
export async function listDevices(userId) {
  const rows = await query(
    `SELECT device_id, public_key, algorithm, created_at
       FROM user_devices
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY last_used_at DESC, id DESC`,
    [userId]
  );
  return rows.map(shapeDevice);
}

/**
 * The public keys a sender needs in order to seal a conversation key: every
 * active device belonging to either participant (including the sender's own
 * other devices, so their phone can read what their laptop sent).
 *
 * Participation is asserted first — you cannot enumerate someone's devices
 * without sharing a conversation with them.
 */
export async function conversationDeviceKeys(conversationId, userId) {
  const part = await assertParticipant(conversationId, userId);
  const rows = await query(
    `SELECT d.user_id, d.device_id, d.public_key, d.algorithm
       FROM user_devices d
      WHERE d.user_id IN (?, ?) AND d.revoked_at IS NULL
      ORDER BY d.user_id ASC, d.last_used_at DESC`,
    [part.userAId, part.userBId]
  );
  return rows.map((r) => ({
    userId: Number(r.user_id),
    deviceId: r.device_id,
    publicKey: r.public_key,
    algorithm: r.algorithm
  }));
}

/* ------------------------------------------------------------------ *
 * Conversation keys
 * ------------------------------------------------------------------ */

/**
 * Publish one generation of a conversation key: an array of per-device
 * wrapped copies produced entirely in the sender's browser.
 *
 * The server validates shape and participation, then stores opaque blobs.
 */
export async function publishConversationKey(conversationId, userId, { keyId, wraps }) {
  const part = await assertParticipant(conversationId, userId);
  if (!keyId) throw badRequest('A key id is required.');
  if (!Array.isArray(wraps) || wraps.length === 0) throw badRequest('At least one wrapped key is required.');

  const allowed = new Set([Number(userId), Number(part.otherUserId)]);
  let stored = 0;

  for (const w of wraps) {
    // A wrap may only ever be addressed to a participant of THIS conversation.
    // Without this check a caller could plant a key copy readable by a third
    // party and quietly add themselves to someone else's private thread.
    if (!allowed.has(Number(w.userId))) {
      throw badRequest('A wrapped key was addressed to someone outside this conversation.');
    }
    if (!w.deviceId || !w.wrappedKey || !w.iv || !w.senderPubKey) {
      throw badRequest('A wrapped key is missing required fields.');
    }

    await execute(
      `INSERT INTO conversation_keys
         (conversation_id, key_id, user_id, device_id, wrapped_key, wrap_iv, sender_pub_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         wrapped_key    = VALUES(wrapped_key),
         wrap_iv        = VALUES(wrap_iv),
         sender_pub_key = VALUES(sender_pub_key)`,
      [conversationId, keyId, Number(w.userId), w.deviceId, w.wrappedKey, w.iv, w.senderPubKey]
    );
    stored += 1;
  }

  log.info('conversation key published', { conversationId, keyId, wraps: stored });
  return { keyId, stored };
}

/**
 * Every wrapped key copy this device can actually unwrap. Scoped hard to the
 * caller's own user id AND device id: one device can never fetch another
 * device's copy, even inside the same account.
 */
export async function myConversationKeys(conversationId, userId, deviceId) {
  await assertParticipant(conversationId, userId);
  if (!deviceId) throw badRequest('A device id is required.');

  const rows = await query(
    `SELECT key_id, wrapped_key, wrap_iv, sender_pub_key, created_at
       FROM conversation_keys
      WHERE conversation_id = ? AND user_id = ? AND device_id = ?
      ORDER BY id DESC`,
    [conversationId, userId, deviceId]
  );

  return rows.map((r) => ({
    keyId: r.key_id,
    wrappedKey: r.wrapped_key,
    iv: r.wrap_iv,
    senderPubKey: r.sender_pub_key,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null
  }));
}

/**
 * Does this conversation already have a key generation that covers every
 * currently-active device on both sides? If not, the client must publish a new
 * generation so a newly-added device is not locked out.
 */
export async function keyCoverage(conversationId, userId) {
  const part = await assertParticipant(conversationId, userId);

  const devices = await query(
    `SELECT user_id, device_id FROM user_devices
      WHERE user_id IN (?, ?) AND revoked_at IS NULL`,
    [userId, part.otherUserId]
  );
  if (!devices.length) return { keyId: null, covered: false, missing: [], deviceCount: 0 };

  const latest = await queryOne(
    'SELECT key_id FROM conversation_keys WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
    [conversationId]
  );
  if (!latest) return { keyId: null, covered: false, missing: devices.length, deviceCount: devices.length };

  const wrapped = await query(
    'SELECT user_id, device_id FROM conversation_keys WHERE conversation_id = ? AND key_id = ?',
    [conversationId, latest.key_id]
  );
  const have = new Set(wrapped.map((w) => `${w.user_id}:${w.device_id}`));
  const missing = devices.filter((d) => !have.has(`${d.user_id}:${d.device_id}`));

  return {
    keyId: latest.key_id,
    covered: missing.length === 0,
    missing: missing.length,
    deviceCount: devices.length
  };
}

/**
 * Revoke a device. Its wrapped key copies go with it, so the device cannot
 * decrypt anything new. Messages already downloaded to that device are of
 * course beyond our reach — the UI says so rather than pretending otherwise.
 */
export async function revokeDevice(userId, deviceId) {
  const res = await execute(
    'UPDATE user_devices SET revoked_at = NOW() WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL',
    [userId, deviceId]
  );
  if (!res.affectedRows) throw notFound('That device is not registered.');
  await execute('DELETE FROM conversation_keys WHERE user_id = ? AND device_id = ?', [userId, deviceId]);
  log.info('device revoked', { userId, deviceId });
  return { revoked: true, deviceId };
}
