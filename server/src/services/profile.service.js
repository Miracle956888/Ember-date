/**
 * profile.service — interests, prompts, photo verification, and the V1
 * identity layer (completion scoring, verification tiers, username changes).
 */
import crypto from 'node:crypto';
import { query, queryOne, execute, withTransaction } from '../db/pool.js';
import { badRequest, conflict, notFound, tooMany } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { matchReasons } from './reasons.service.js';
import { notify } from './notification.service.js';

/** At most this many interests may be selected. Mirrors interestsSchema. */
export const MAX_INTERESTS = 8;
/** At most this many prompts may be answered. Mirrors promptsSchema. */
export const MAX_PROMPTS = 3;

/* ------------------------------------------------------------------ *
 * Interests
 * ------------------------------------------------------------------ */

/** The catalogue, grouped by category for the picker UI. */
export async function listInterests() {
  const rows = await query(
    'SELECT id, slug, label, emoji, category FROM interests ORDER BY category ASC, label ASC'
  );
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push({
      id: Number(row.id),
      slug: row.slug,
      label: row.label,
      emoji: row.emoji
    });
  }
  return [...byCategory.entries()].map(([category, items]) => ({ category, items }));
}

/** One user's chosen interests. */
export async function getUserInterests(userId) {
  const rows = await query(
    `SELECT i.id, i.slug, i.label, i.emoji, i.category
       FROM user_interests ui
       JOIN interests i ON i.id = ui.interest_id
      WHERE ui.user_id = ?
      ORDER BY i.label ASC`,
    [userId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    slug: r.slug,
    label: r.label,
    emoji: r.emoji,
    category: r.category
  }));
}

/** Replace the whole selection in one transaction. Unknown slugs are ignored. */
export async function setUserInterests(userId, slugs) {
  const wanted = [...new Set(slugs)].slice(0, MAX_INTERESTS);

  let ids = [];
  if (wanted.length) {
    const placeholders = wanted.map(() => '?').join(',');
    const rows = await query(`SELECT id FROM interests WHERE slug IN (${placeholders})`, wanted);
    ids = rows.map((r) => Number(r.id));
  }

  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM user_interests WHERE user_id = ?', [userId]);
    for (const id of ids) {
      await conn.execute('INSERT INTO user_interests (user_id, interest_id) VALUES (?, ?)', [userId, id]);
    }
  });

  await refreshCompletion(userId).catch(() => {});
  return getUserInterests(userId);
}

/**
 * Interests two people have in common — the "5 shared interests" match reason.
 * Returns labels, since that is all the card renders.
 */
export async function sharedInterests(viewerId, targetId) {
  if (!viewerId || Number(viewerId) === Number(targetId)) return [];
  const rows = await query(
    `SELECT i.slug, i.label, i.emoji
       FROM user_interests a
       JOIN user_interests b ON b.interest_id = a.interest_id AND b.user_id = ?
       JOIN interests i ON i.id = a.interest_id
      WHERE a.user_id = ?
      ORDER BY i.label ASC`,
    [viewerId, targetId]
  );
  return rows.map((r) => ({ slug: r.slug, label: r.label, emoji: r.emoji }));
}

/* ------------------------------------------------------------------ *
 * Prompts
 * ------------------------------------------------------------------ */

/** Fixed prompt catalogue. Keys are stable; text may be reworded freely. */
export const PROMPT_CATALOGUE = [
  { key: 'perfect_sunday', text: 'My perfect Sunday looks like…' },
  { key: 'cook_best', text: 'The one dish I cook best is…' },
  { key: 'irrationally_love', text: 'I am irrationally passionate about…' },
  { key: 'first_round', text: 'First round is on me if…' },
  { key: 'travel_next', text: 'The next place I want to travel to is…' },
  { key: 'green_flag', text: 'A green flag I look for is…' },
  { key: 'weekend_plan', text: 'You will usually find me at the weekend…' },
  { key: 'make_me_laugh', text: 'The quickest way to make me laugh is…' }
];

const PROMPT_TEXT = new Map(PROMPT_CATALOGUE.map((p) => [p.key, p.text]));

/** One user's answered prompts, in display order. */
export async function getPrompts(userId) {
  const rows = await query(
    'SELECT prompt_key, answer, position FROM profile_prompts WHERE user_id = ? ORDER BY position ASC, id ASC',
    [userId]
  );
  return rows.map((r) => ({
    key: r.prompt_key,
    question: PROMPT_TEXT.get(r.prompt_key) || r.prompt_key,
    answer: r.answer,
    position: Number(r.position)
  }));
}

/** Replace all answers. Unknown keys are rejected rather than silently dropped. */
export async function setPrompts(userId, prompts) {
  const clean = prompts.slice(0, MAX_PROMPTS);
  for (const p of clean) {
    if (!PROMPT_TEXT.has(p.key)) throw badRequest('That prompt is not available.');
  }

  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM profile_prompts WHERE user_id = ?', [userId]);
    let position = 0;
    for (const p of clean) {
      await conn.execute(
        'INSERT INTO profile_prompts (user_id, prompt_key, answer, position) VALUES (?,?,?,?)',
        [userId, p.key, p.answer, position]
      );
      position += 1;
    }
  });

  return getPrompts(userId);
}

/* ------------------------------------------------------------------ *
 * Photo verification (selfie gesture challenge)
 * ------------------------------------------------------------------ */

/** Poses we may ask for. Chosen at random so a saved selfie cannot be replayed. */
export const VERIFICATION_GESTURES = [
  { gesture: 'peace', instruction: 'Hold up a peace sign next to your face' },
  { gesture: 'thumbs_up', instruction: 'Give a thumbs up' },
  { gesture: 'hand_on_head', instruction: 'Place one hand flat on top of your head' },
  { gesture: 'point_up', instruction: 'Point one finger straight up' },
  { gesture: 'open_palm', instruction: 'Show an open palm beside your cheek' },
  { gesture: 'wave', instruction: 'Wave at the camera' }
];

/** Issue a random pose challenge. */
export async function requestVerification(userId) {
  const user = await queryOne('SELECT is_verified FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!user) throw notFound('User not found.');
  if (user.is_verified) throw conflict('You are already verified.');

  const pick = VERIFICATION_GESTURES[crypto.randomInt(0, VERIFICATION_GESTURES.length)];
  return { gesture: pick.gesture, instruction: pick.instruction };
}

/** Where a user stands across all three tiers. */
export async function getVerificationStatus(userId) {
  const user = await queryOne(
    `SELECT is_verified, verified_at, email_verified_at, phone, phone_verified_at
       FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  if (!user) throw notFound('User not found.');

  const latest = await queryOne(
    'SELECT status, created_at, reviewed_at, note FROM verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );

  return {
    isVerified: Boolean(user.is_verified),
    verifiedAt: user.verified_at ? new Date(user.verified_at).toISOString() : null,
    tiers: verificationTiers(user),
    phone: user.phone || null,
    lastAttempt: latest
      ? {
        status: latest.status,
        createdAt: new Date(latest.created_at).toISOString(),
        reviewedAt: latest.reviewed_at ? new Date(latest.reviewed_at).toISOString() : null,
        note: latest.note || null
      }
      : null
  };
}

/**
 * Record a verification submission.
 *
 * There is no face-matching model in this stack, so the check is a recorded
 * liveness challenge rather than biometric proof: a random pose the user could
 * not have prepared in advance. The selfie is deleted by the caller once the
 * row is written — it is evidence, not profile content.
 */
export async function submitVerification(userId, { gesture, filePath }) {
  const known = VERIFICATION_GESTURES.some((g) => g.gesture === gesture);
  if (!known) throw badRequest('Unknown verification pose.');

  const user = await queryOne('SELECT is_verified FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!user) throw notFound('User not found.');
  if (user.is_verified) throw conflict('You are already verified.');

  await withTransaction(async (conn) => {
    await conn.execute(
      `INSERT INTO verifications (user_id, gesture, file_path, status, reviewed_at)
       VALUES (?, ?, ?, 'approved', NOW())`,
      [userId, gesture, filePath]
    );
    await conn.execute('UPDATE users SET is_verified = 1, verified_at = NOW() WHERE id = ?', [userId]);
  });

  await refreshCompletion(userId).catch(() => {});

  // Account-critical, so it bypasses preference gating by design (the
  // `verification` kind maps to a null pref column).
  await notify({
    userId,
    kind: 'verification',
    targetType: 'profile',
    targetId: userId,
    href: '/profile',
    body: 'Your profile is verified. The check now shows on your profile.',
    groupKey: `verification:profile:${userId}`
  });

  logger.info('[verify] photo verification approved', { userId, gesture });
  return { isVerified: true, verifiedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ *
 * V1 — profile completion
 * ------------------------------------------------------------------ */

/**
 * Weighted completion model. Weights sum to 100. The split is deliberate:
 * the things that actually make a profile work for other people (a photo,
 * a bio, interests) are worth far more than optional metadata.
 */
const COMPLETION_FIELDS = [
  { key: 'avatar', weight: 20, label: 'Add a profile photo' },
  { key: 'extraPhotos', weight: 12, label: 'Add at least two more photos' },
  { key: 'bio', weight: 14, label: 'Write a short bio' },
  { key: 'interests', weight: 12, label: 'Pick at least three interests' },
  { key: 'birthdate', weight: 8, label: 'Add your date of birth' },
  { key: 'gender', weight: 5, label: 'Add your gender' },
  { key: 'city', weight: 8, label: 'Add your city' },
  { key: 'intent', weight: 9, label: 'Say what you are looking for' },
  { key: 'languages', weight: 4, label: 'Add the languages you speak' },
  { key: 'hobbies', weight: 4, label: 'Add a few hobbies' },
  { key: 'verified', weight: 4, label: 'Confirm your email' }
];

export function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Score a profile 0-100 and report exactly what is missing, so the client can
 * render an actionable checklist instead of a bare percentage.
 */
export function scoreProfile({ user, photoCount = 0, interestCount = 0 }) {
  const languages = parseJsonArray(user.languages);
  const hobbies = parseJsonArray(user.hobbies);
  const have = {
    avatar: Boolean(user.avatar_url),
    extraPhotos: photoCount >= 3,
    bio: Boolean(user.bio && user.bio.trim().length >= 20),
    interests: interestCount >= 3,
    birthdate: Boolean(user.birthdate),
    gender: Boolean(user.gender),
    city: Boolean(user.city),
    intent: Boolean(user.intent),
    languages: languages.length > 0,
    hobbies: hobbies.length > 0,
    verified: Boolean(user.email_verified_at)
  };
  let percent = 0;
  const missing = [];
  for (const field of COMPLETION_FIELDS) {
    if (have[field.key]) percent += field.weight;
    else missing.push({ key: field.key, label: field.label, weight: field.weight });
  }
  // Highest-impact suggestion first — that is what the nudge should show.
  missing.sort((a, b) => b.weight - a.weight);
  return { percent: Math.min(100, percent), missing, complete: percent >= 100 };
}

/** Recompute and persist completion. Cheap enough to call after any profile write. */
export async function refreshCompletion(userId) {
  const user = await queryOne(
    `SELECT avatar_url, bio, birthdate, gender, city, intent, languages, hobbies, email_verified_at
       FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  if (!user) throw notFound('User not found.');

  const photoRow = await queryOne('SELECT COUNT(*) AS n FROM user_photos WHERE user_id = ?', [userId]);
  const interestRow = await queryOne('SELECT COUNT(*) AS n FROM user_interests WHERE user_id = ?', [userId]);

  const score = scoreProfile({
    user,
    photoCount: Number(photoRow?.n || 0),
    interestCount: Number(interestRow?.n || 0)
  });
  await execute('UPDATE users SET profile_completion = ? WHERE id = ?', [score.percent, userId]);
  return score;
}

/* ------------------------------------------------------------------ *
 * V1 — verification tiers
 * ------------------------------------------------------------------ */

/**
 * The three tiers, as a plain shape the client renders directly.
 *
 * Deliberately NOT called "verified safe". Verification proves control of an
 * address or a phone line, or that a live pose matches the photos — nothing
 * about whether a person is trustworthy. The copy reflects that.
 */
export function verificationTiers(user) {
  return {
    email: {
      verified: Boolean(user.email_verified_at),
      label: 'Email confirmed',
      at: user.email_verified_at ? new Date(user.email_verified_at).toISOString() : null
    },
    phone: {
      verified: Boolean(user.phone_verified_at),
      label: 'Phone confirmed',
      at: user.phone_verified_at ? new Date(user.phone_verified_at).toISOString() : null
    },
    photo: {
      verified: Boolean(user.is_verified),
      label: 'Photo verified',
      at: user.verified_at ? new Date(user.verified_at).toISOString() : null
    },
    // A single roll-up for compact badges. Photo is the strongest signal.
    level: user.is_verified
      ? 'photo'
      : user.phone_verified_at
        ? 'phone'
        : user.email_verified_at
          ? 'email'
          : 'none'
  };
}

/* ------------------------------------------------------------------ *
 * V1 — email / phone verification codes
 * ------------------------------------------------------------------ */

/** Verification codes are short-lived and attempt-capped. */
export const VERIFY_TTL_MIN = 15;
export const VERIFY_MAX_ATTEMPTS = 5;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Issue an email or phone verification code.
 * The plaintext code is returned to the caller (the controller decides whether
 * it may be echoed — never in production) and only its hash is persisted.
 */
export async function issueVerification(userId, kind, target) {
  if (!['email', 'phone'].includes(kind)) throw badRequest('Unknown verification type.');

  const recent = await queryOne(
    `SELECT COUNT(*) AS n FROM verification_tokens
      WHERE user_id = ? AND kind = ? AND created_at > (NOW() - INTERVAL 15 MINUTE)`,
    [userId, kind]
  );
  if (Number(recent?.n || 0) >= 5) throw tooMany('Too many codes requested. Try again in a few minutes.');

  // A 6-digit code is the right ergonomics for phone; reuse it for email so the
  // UI is one component. Entropy is low, so attempts are capped hard below.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

  await execute('DELETE FROM verification_tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL', [userId, kind]);
  await execute(
    `INSERT INTO verification_tokens (user_id, kind, target, token_hash, expires_at)
     VALUES (?, ?, ?, ?, (NOW() + INTERVAL ? MINUTE))`,
    [userId, kind, target, hashToken(code), VERIFY_TTL_MIN]
  );
  logger.info('[verify] code issued', { userId, kind });
  return { code, expiresInMinutes: VERIFY_TTL_MIN };
}

/** Consume a code. Wrong codes burn an attempt; five wrong kills the token. */
export async function confirmVerification(userId, kind, code) {
  const row = await queryOne(
    `SELECT id, target, token_hash, attempts FROM verification_tokens
      WHERE user_id = ? AND kind = ? AND used_at IS NULL AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1`,
    [userId, kind]
  );
  if (!row) throw badRequest('That code has expired. Request a new one.', { code: 'VERIFY_EXPIRED' });

  if (row.attempts >= VERIFY_MAX_ATTEMPTS) {
    await execute('DELETE FROM verification_tokens WHERE id = ?', [row.id]);
    throw tooMany('Too many incorrect attempts. Request a new code.');
  }

  const supplied = hashToken(code);
  const expected = row.token_hash;
  const ok =
    supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));

  if (!ok) {
    await execute('UPDATE verification_tokens SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    throw badRequest('That code is not correct.', { code: 'VERIFY_INVALID' });
  }

  await withTransaction(async (conn) => {
    await conn.execute('UPDATE verification_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
    if (kind === 'email') {
      await conn.execute('UPDATE users SET email_verified_at = NOW() WHERE id = ?', [userId]);
    } else {
      await conn.execute('UPDATE users SET phone = ?, phone_verified_at = NOW() WHERE id = ?', [row.target, userId]);
    }
  });

  await refreshCompletion(userId).catch(() => {});

  await notify({
    userId,
    kind: 'verification',
    targetType: kind,
    targetId: userId,
    href: '/settings',
    body: kind === 'email' ? 'Your email address is verified.' : 'Your phone number is verified.',
    groupKey: `verification:${kind}:${userId}`
  });

  logger.info('[verify] confirmed', { userId, kind });
  return { verified: true, kind };
}

/* ------------------------------------------------------------------ *
 * V1 — username changes
 * ------------------------------------------------------------------ */

/** Username changes are rate-limited to protect handle-based identity. */
export const USERNAME_CHANGE_DAYS = 30;
/** A released handle stays unclaimable for this long (anti-impersonation). */
export const USERNAME_COOLDOWN_DAYS = 90;

/**
 * Is this handle free for `userId` to take?
 * Case-insensitive (the column collation is _ai_ci) and additionally blocked
 * if someone else released it inside the cooling-off window.
 */
export async function canClaimUsername(username, userId = null) {
  const taken = await queryOne('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
  if (taken && Number(taken.id) !== Number(userId)) return { ok: false, reason: 'taken' };

  const held = await queryOne(
    `SELECT user_id FROM username_history
      WHERE username = ? AND claimable_at > NOW()
      ORDER BY claimable_at DESC LIMIT 1`,
    [username]
  );
  // The original owner may always reclaim their own former handle.
  if (held && Number(held.user_id) !== Number(userId)) return { ok: false, reason: 'cooling_off' };
  return { ok: true };
}

/**
 * Change a username, recording the old one so it cannot be grabbed to
 * impersonate the person who just released it.
 */
export async function changeUsername(userId, next) {
  const user = await queryOne('SELECT username, username_changed_at FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!user) throw notFound('User not found.');

  if (user.username === next) return { username: next, changed: false };

  if (user.username_changed_at) {
    const days = (Date.now() - new Date(user.username_changed_at).getTime()) / 86_400_000;
    if (days < USERNAME_CHANGE_DAYS) {
      const wait = Math.ceil(USERNAME_CHANGE_DAYS - days);
      throw tooMany(`You can change your username again in ${wait} day${wait === 1 ? '' : 's'}.`, {
        code: 'USERNAME_COOLDOWN',
        details: { daysRemaining: wait }
      });
    }
  }

  const claim = await canClaimUsername(next, userId);
  if (!claim.ok) {
    throw conflict(
      claim.reason === 'cooling_off'
        ? 'That username was recently in use and is not available yet.'
        : 'That username is already taken.',
      { code: 'USERNAME_TAKEN', details: { username: 'That username is already taken.' } }
    );
  }

  await withTransaction(async (conn) => {
    await conn.execute(
      `INSERT INTO username_history (user_id, username, claimable_at)
       VALUES (?, ?, (NOW() + INTERVAL ? DAY))`,
      [userId, user.username, USERNAME_COOLDOWN_DAYS]
    );
    await conn.execute('UPDATE users SET username = ?, username_changed_at = NOW() WHERE id = ?', [next, userId]);
  });

  logger.info('[username] changed', { userId, from: user.username, to: next });
  return { username: next, changed: true, previous: user.username };
}

/* ------------------------------------------------------------------ *
 * V1 — public profile by handle (/@username)
 * ------------------------------------------------------------------ */

/**
 * Public profile by handle. Respects blocks in both directions and never
 * reveals whether a blocked or suspended handle exists.
 */
export async function getPublicProfileByUsername(username, viewerId = null) {
  const user = await queryOne(
    `SELECT id, username, display_name, birthdate, gender, bio, city, country, avatar_url,
            intent, job_title, school, languages, hobbies, is_verified, verified_at,
            email_verified_at, phone_verified_at, profile_completion, status, is_online, last_seen_at
       FROM users
      WHERE username = ? LIMIT 1`,
    [username]
  );
  // Suspended/banned profiles are indistinguishable from missing ones.
  if (!user || user.status !== 'active') throw notFound('No user found.');

  if (viewerId && Number(viewerId) !== Number(user.id)) {
    const blocked = await queryOne(
      `SELECT 1 AS hit FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
        LIMIT 1`,
      [viewerId, user.id, user.id, viewerId]
    );
    if (blocked) throw notFound('No user found.');
  }

  // A signed-out visitor gets the plain profile: no like state, and no
  // "why you two" line, because there is no viewer to compare against.
  const isSelf = viewerId ? Number(viewerId) === Number(user.id) : false;
  const wantsViewerContext = Boolean(viewerId) && !isSelf;

  const [photos, interests, prompts, shared, viewerRow, likedRow, countRow] = await Promise.all([
    query('SELECT id, url, position FROM user_photos WHERE user_id = ? ORDER BY position ASC, id ASC', [user.id]),
    getUserInterests(user.id),
    getPrompts(user.id),
    wantsViewerContext ? sharedInterests(viewerId, user.id) : Promise.resolve([]),
    wantsViewerContext
      ? queryOne('SELECT city, intent, languages FROM users WHERE id = ? LIMIT 1', [viewerId])
      : Promise.resolve(null),
    viewerId
      ? queryOne(
        `SELECT 1 AS hit FROM content_likes
            WHERE user_id = ? AND target_type = 'profile' AND target_id = ? LIMIT 1`,
        [viewerId, user.id]
      )
      : Promise.resolve(null),
    queryOne(
      "SELECT COUNT(*) AS n FROM content_likes WHERE target_type = 'profile' AND target_id = ?",
      [user.id]
    )
  ]);

  const age = user.birthdate
    ? Math.floor((Date.now() - new Date(user.birthdate).getTime()) / 31_557_600_000)
    : null;

  return {
    id: Number(user.id),
    username: user.username,
    displayName: user.display_name,
    age,
    gender: user.gender,
    bio: user.bio,
    city: user.city,
    country: user.country,
    avatarUrl: user.avatar_url,
    intent: user.intent,
    jobTitle: user.job_title,
    school: user.school,
    languages: parseJsonArray(user.languages),
    hobbies: parseJsonArray(user.hobbies),
    profileCompletion: Number(user.profile_completion) || 0,
    verification: verificationTiers(user),
    isVerified: Boolean(user.is_verified),
    isOnline: Boolean(user.is_online),
    lastSeenAt: user.last_seen_at ? new Date(user.last_seen_at).toISOString() : null,
    photos: photos.map((p) => ({ id: Number(p.id), url: p.url, position: Number(p.position) })),
    interests,
    prompts,
    isSelf,
    sharedInterests: shared,
    reasons: wantsViewerContext
      ? matchReasons(
        {
          sharedInterests: shared,
          city: user.city,
          intent: user.intent,
          languages: parseJsonArray(user.languages),
          isVerified: Boolean(user.is_verified),
          isOnline: Boolean(user.is_online)
        },
        {
          city: viewerRow?.city || null,
          intent: viewerRow?.intent || null,
          languages: parseJsonArray(viewerRow?.languages)
        }
      )
      : [],
    liked: Boolean(likedRow),
    likeCount: Number(countRow?.n || 0),
    shareUrl: `/@${user.username}`
  };
}
