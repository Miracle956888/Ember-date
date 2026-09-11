/**
 * ttl.service — custom disappearing timers, per conversation.
 *
 * THE CONTRACT
 *   - Allowed values are a fixed menu: 1h, 6h, 12h, 24h (default), 3d, 7d.
 *     An arbitrary number is rejected, so nobody can set a 10-year "timer"
 *     and quietly turn an ephemeral app into a permanent archive.
 *   - Changing the timer applies to NEW messages only. It never retroactively
 *     extends the life of a message already sent: if you sent something under
 *     a 1-hour timer, the other person cannot flip a switch and keep it for a
 *     week. Shortening likewise does not reach backwards; expiry is stamped at
 *     write time, exactly as it always was.
 *   - Enforcement is server-side. `expires_at` is computed in SQL from the
 *     DB clock, and every read filters `expires_at > NOW()`, so a lapsed
 *     message is invisible the instant it expires — never trusting the
 *     cleanup job or a cooperative client.
 *   - Both participants can see and change the timer, and the change is
 *     announced in-thread as a system message so it can never happen silently.
 */
import { queryOne, execute } from '../db/pool.js';
import { badRequest } from '../utils/errors.js';
import { assertParticipant } from './match.service.js';

/**
 * The menu, in hours. Mirrors the spec exactly.
 * Kept as an ordered array so the UI can render it without duplicating copy.
 */
export const TTL_OPTIONS = [
  { hours: 1, label: '1 hour', short: '1h' },
  { hours: 6, label: '6 hours', short: '6h' },
  { hours: 12, label: '12 hours', short: '12h' },
  { hours: 24, label: '24 hours', short: '24h' },
  { hours: 72, label: '3 days', short: '3d' },
  { hours: 168, label: '7 days', short: '7d' }
];

export const DEFAULT_TTL_HOURS = 24;

const ALLOWED = new Set(TTL_OPTIONS.map((o) => o.hours));

/** True when `hours` is one of the six permitted values. */
export function isValidTtl(hours) {
  return ALLOWED.has(Number(hours));
}

/** Human label for a TTL, e.g. 72 → "3 days". Falls back gracefully. */
export function ttlLabel(hours) {
  return TTL_OPTIONS.find((o) => o.hours === Number(hours))?.label || `${hours} hours`;
}

/**
 * The effective TTL for a conversation, in hours.
 *
 * A conversation row always carries `ttl_hours` (default 24), but we clamp to
 * the allowed menu on read as well as on write. A value that somehow got into
 * the column out-of-band cannot extend anyone's messages.
 */
export async function ttlForConversation(conversationId) {
  const row = await queryOne('SELECT ttl_hours FROM conversations WHERE id = ? LIMIT 1', [conversationId]);
  const hours = Number(row?.ttl_hours);
  return isValidTtl(hours) ? hours : DEFAULT_TTL_HOURS;
}

/** Current timer plus the menu, for rendering the picker. */
export async function getTimer(conversationId, userId) {
  await assertParticipant(conversationId, userId);
  const row = await queryOne(
    `SELECT c.ttl_hours, c.ttl_set_at, c.ttl_set_by, u.display_name AS set_by_name
       FROM conversations c
       LEFT JOIN users u ON u.id = c.ttl_set_by
      WHERE c.id = ? LIMIT 1`,
    [conversationId]
  );
  const hours = isValidTtl(row?.ttl_hours) ? Number(row.ttl_hours) : DEFAULT_TTL_HOURS;
  return {
    ttlHours: hours,
    label: ttlLabel(hours),
    setBy: row?.ttl_set_by ? Number(row.ttl_set_by) : null,
    setByName: row?.set_by_name || null,
    setAt: row?.ttl_set_at ? new Date(row.ttl_set_at).toISOString() : null,
    options: TTL_OPTIONS
  };
}

/**
 * Change the timer. Returns the new state plus a flag telling the caller to
 * post the system message (kept out of here so this service stays free of a
 * circular import with message.service).
 */
export async function setTimer(conversationId, userId, hours) {
  await assertParticipant(conversationId, userId);

  const next = Number(hours);
  if (!isValidTtl(next)) {
    throw badRequest('Choose one of the offered timers: 1 hour, 6 hours, 12 hours, 24 hours, 3 days or 7 days.');
  }

  const current = await ttlForConversation(conversationId);
  if (current === next) {
    return { ttlHours: next, label: ttlLabel(next), changed: false };
  }

  await execute('UPDATE conversations SET ttl_hours = ?, ttl_set_by = ?, ttl_set_at = NOW() WHERE id = ?', [
    next,
    userId,
    conversationId
  ]);

  return {
    ttlHours: next,
    label: ttlLabel(next),
    previousHours: current,
    changed: true,
    // Existing messages keep the expiry they were stamped with at write time.
    appliesTo: 'new messages only'
  };
}
