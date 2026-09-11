import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query, queryOne, execute } from '../db/pool.js';
import { conflict, unauthorized, forbidden, badRequest, tooMany } from '../utils/errors.js';

const BCRYPT_ROUNDS = 12;
/** Failed sign-ins allowed per email address per 15 minutes. */
const MAX_ACCOUNT_FAILURES = 10;
/** Password-reset tokens are deliberately short-lived. */
const RESET_TTL_MIN = 30;

/** Public shape of a user returned to the client. Never includes password_hash. */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    birthdate: row.birthdate ? new Date(row.birthdate).toISOString().slice(0, 10) : null,
    age: row.birthdate ? calcAge(row.birthdate) : null,
    gender: row.gender,
    interestedIn: row.interested_in,
    bio: row.bio,
    city: row.city,
    avatarUrl: row.avatar_url,
    isOnline: Boolean(row.is_online),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    // V1 profile depth.
    intent: row.intent ?? null,
    jobTitle: row.job_title ?? null,
    school: row.school ?? null,
    heightCm: row.height_cm === null || row.height_cm === undefined ? null : Number(row.height_cm),
    languages: parseJsonArray(row.languages),
    hobbies: parseJsonArray(row.hobbies),
    country: row.country ?? null,
    // i18n rendering hints. Deliberately absent from the PUBLIC profile
    // serialiser (profile.service.js): a precise IANA zone narrows a stranger's
    // location far more than the coarse city we already show.
    timezone: row.timezone ?? null,
    locale: row.locale ?? null,
    profileCompletion: Number(row.profile_completion) || 0,
    isVerified: Boolean(row.is_verified),
    emailVerified: Boolean(row.email_verified_at),
    phoneVerified: Boolean(row.phone_verified_at),
    phone: row.phone ?? null,
    role: row.role || 'user',
    status: row.status || 'active',
    shareUrl: row.username ? `/@${row.username}` : null
  };
}

/** Tolerant JSON-array reader: the driver may hand back a string or an array. */
function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function calcAge(birthdate) {
  const b = new Date(birthdate);
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

export async function findUserByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
}

export async function findUserById(id) {
  return queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
}

export async function findUserByUsername(username) {
  return queryOne('SELECT * FROM users WHERE username = ? LIMIT 1', [String(username).toLowerCase()]);
}

/** True when the handle is free (optionally ignoring the user who owns it). */
export async function isUsernameAvailable(username, exceptUserId = null) {
  const row = await queryOne(
    'SELECT id FROM users WHERE username = ? AND (? IS NULL OR id <> ?) LIMIT 1',
    [String(username).toLowerCase(), exceptUserId, exceptUserId]
  );
  return !row;
}

export async function createUser(input) {
  const existing = await findUserByEmail(input.email);
  if (existing) {
    // Generic message: no user enumeration.
    throw conflict('We could not create that account. Try signing in instead.', { code: 'REGISTRATION_FAILED' });
  }
  // Usernames are public and searchable, so a specific message here is fine.
  if (!(await isUsernameAvailable(input.username))) {
    throw conflict('That username is already taken.', {
      code: 'USERNAME_TAKEN',
      details: { username: 'That username is already taken.' }
    });
  }
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  let res;
  try {
    res = await execute(
      `INSERT INTO users (email, username, password_hash, display_name, birthdate, gender, interested_in, bio, city)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        input.email,
        input.username,
        passwordHash,
        input.displayName,
        input.birthdate ?? null,
        input.gender ?? null,
        input.interestedIn ?? 'everyone',
        input.bio ?? null,
        input.city ?? null
      ]
    );
  } catch (err) {
    // Race between the availability check and the insert.
    if (err?.code === 'ER_DUP_ENTRY') {
      throw conflict('That username is already taken.', {
        code: 'USERNAME_TAKEN',
        details: { username: 'That username is already taken.' }
      });
    }
    throw err;
  }
  return findUserById(res.insertId);
}

/** Constant-ish time credential check with a generic failure message. */
export async function verifyCredentials(email, password, ip = null) {
  // Per-account throttle. The IP limiter alone does not slow a distributed
  // attack against ONE account, so count recent failures for this address too.
  const recent = await queryOne(
    `SELECT COUNT(*) AS n FROM login_attempts
      WHERE email = ? AND ok = 0 AND created_at > (NOW() - INTERVAL 15 MINUTE)`,
    [email]
  );
  if (Number(recent?.n || 0) >= MAX_ACCOUNT_FAILURES) {
    throw tooMany('Too many sign-in attempts for this account. Try again in a few minutes.', {
      code: 'ACCOUNT_THROTTLED'
    });
  }

  const user = await findUserByEmail(email);
  if (!user) {
    // Spend similar time hashing so timing does not reveal account existence.
    await bcrypt.compare(password, '$2a$12$0000000000000000000000000000000000000000000000000000');
    await recordLoginAttempt(email, ip, false);
    throw unauthorized('Email or password is incorrect.', { code: 'BAD_CREDENTIALS' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await recordLoginAttempt(email, ip, false);
    throw unauthorized('Email or password is incorrect.', { code: 'BAD_CREDENTIALS' });
  }

  assertUsable(user);
  await recordLoginAttempt(email, ip, true);
  return user;
}

/**
 * Banned and suspended accounts cannot sign in. A lapsed suspension heals
 * itself on the next attempt rather than needing a scheduled job.
 */
/**
 * Reject an access token minted before the user's session epoch. Called with
 * the JWT payload during authentication; a request with no `iat` (or a user
 * with no epoch set) is unaffected.
 */
export function assertTokenNotStale(user, payload) {
  if (!user?.sessions_valid_from || !payload?.iat) return;
  const issuedAt = payload.iat * 1000;
  if (issuedAt < new Date(user.sessions_valid_from).getTime()) {
    throw unauthorized('Your session has expired. Please sign in again.', { code: 'SESSION_REVOKED' });
  }
}

export function assertUsable(user) {
  if (user.status === 'banned') {
    throw forbidden('This account has been permanently suspended for breaking our community rules.', {
      code: 'ACCOUNT_BANNED'
    });
  }
  if (user.status === 'suspended') {
    const until = user.suspended_until ? new Date(user.suspended_until) : null;
    if (!until || until > new Date()) {
      throw forbidden(
        until
          ? `This account is suspended until ${until.toISOString().slice(0, 10)}.`
          : 'This account is currently suspended.',
        { code: 'ACCOUNT_SUSPENDED' }
      );
    }
    // Suspension expired — restore lazily.
    execute("UPDATE users SET status = 'active', suspended_until = NULL WHERE id = ?", [user.id]).catch(() => {});
    user.status = 'active';
  }
}

async function recordLoginAttempt(email, ip, ok) {
  await execute('INSERT INTO login_attempts (email, ip, ok) VALUES (?,?,?)', [email, ip, ok ? 1 : 0]).catch(() => {});
}

// ------------------------------------------------------- password recovery

/**
 * Issue a reset token. Returns the raw token for delivery; only its SHA-256
 * is persisted, so a database read cannot be replayed into an account
 * takeover. Callers must NOT reveal whether the address existed.
 */
export async function createPasswordReset(email) {
  const user = await findUserByEmail(email);
  if (!user) return null;

  // One live token at a time: issuing a new one invalidates the old.
  await execute('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [user.id]);

  const token = crypto.randomBytes(32).toString('hex');
  await execute(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES (?, ?, (NOW() + INTERVAL ? MINUTE))`,
    [user.id, hashToken(token), RESET_TTL_MIN]
  );
  return { token, user };
}

/** Consume a reset token and set the new password. Single use. */
export async function consumePasswordReset(token, newPassword) {
  const row = await queryOne(
    `SELECT id, user_id FROM password_resets
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
    [hashToken(String(token || ''))]
  );
  if (!row) throw badRequest('That reset link is invalid or has expired.', { code: 'RESET_INVALID' });

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, row.user_id]);
  await execute('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [row.id]);
  // A password change invalidates every existing session.
  await revokeAllUserTokens(row.user_id);
  return Number(row.user_id);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export async function purgeExpiredResets() {
  const res = await execute(
    'DELETE FROM password_resets WHERE expires_at < NOW() OR used_at IS NOT NULL AND used_at < (NOW() - INTERVAL 1 DAY)'
  );
  return res.affectedRows;
}

// --------------------------------------------------------- refresh tokens

export async function storeRefreshToken(userId, jti, expiresAt) {
  await execute('INSERT INTO refresh_tokens (user_id, jti, expires_at) VALUES (?,?,?)', [
    userId,
    jti,
    expiresAt
  ]);
}

export async function isRefreshTokenActive(jti) {
  const row = await queryOne(
    'SELECT id FROM refresh_tokens WHERE jti = ? AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1',
    [jti]
  );
  return Boolean(row);
}

export async function revokeRefreshToken(jti) {
  await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE jti = ? AND revoked_at IS NULL', [jti]);
}

export async function revokeAllUserTokens(userId) {
  await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
  // Refresh rows are stateful, but access tokens are stateless JWTs that are
  // never looked up -- so revoking rows alone left an existing access token
  // usable for the remainder of its TTL. Stamping the epoch closes that window
  // immediately. NOW() + 1s guards the boundary: JWT `iat` has one-second
  // resolution, so a token minted in the same second as the change would
  // otherwise satisfy `iat >= epoch` and survive.
  await execute('UPDATE users SET sessions_valid_from = (NOW() + INTERVAL 1 SECOND) WHERE id = ?', [userId]);
}

export async function purgeExpiredRefreshTokens() {
  const res = await execute('DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL');
  return res.affectedRows;
}

export function newJti() {
  return crypto.randomUUID();
}

export function refreshExpiryDate() {
  return new Date(Date.now() + 7 * 24 * 3600 * 1000);
}

// ------------------------------------------------------------- presence

export async function markOnline(userId) {
  await execute('UPDATE users SET is_online = 1, last_seen_at = NOW() WHERE id = ?', [userId]);
}

export async function markOffline(userId) {
  await execute('UPDATE users SET is_online = 0, last_seen_at = NOW() WHERE id = ?', [userId]);
}

export async function resetAllPresence() {
  await execute('UPDATE users SET is_online = 0 WHERE is_online = 1');
}

export async function deleteAccount(userId) {
  // FKs cascade to photos, swipes, matches, conversations, messages, attachments.
  const res = await execute('DELETE FROM users WHERE id = ?', [userId]);
  return res.affectedRows;
}

export async function listUserAttachmentPaths(userId) {
  return query('SELECT file_path, thumb_path FROM attachments WHERE owner_id = ?', [userId]);
}
