import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';

/**
 * IPv6-safe key helper. express-rate-limit v7 has no exported ipKeyGenerator,
 * so we normalise here: collapse an IPv6 address to its /64 prefix so a single
 * client cannot rotate through its address block to defeat the limiter.
 */
function ipKey(ip) {
  if (!ip) return 'unknown';
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!clean.includes(':')) return clean;
  const groups = clean.split(':');
  return `${groups.slice(0, 4).join(':')}::/64`;
}
import { env, COOKIE } from '../config/env.js';

const json = (message) => (req, res) => {
  res.status(429).json({ error: { message, code: 'RATE_LIMITED' } });
};

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // In tests we do not want limits getting in the way.
  skip: () => env.isTest
};

/**
 * Global limiter applied to the whole /api surface.
 *
 * The ceiling is per-IP, and 300/min is a sane production default for a
 * single human on a phone. It is overridable via RATE_LIMIT_GLOBAL_PER_MIN
 * purely so an automated end-to-end run -- where a dozen suites and several
 * browser contexts share one source IP -- does not trip a limiter aimed at
 * abusive clients. It is a ceiling, never a security boundary: the controls
 * that actually protect accounts (auth throttling, per-account login backoff,
 * CSRF, authz) stay fully armed at their normal values in every environment.
 */
export const globalLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN) || 300,
  handler: json('Too many requests. Please slow down and try again shortly.')
});

/**
 * Tight limiter for credential endpoints (login/register).
 *
 * `skipSuccessfulRequests` is ON deliberately. What we are defending against
 * is credential *guessing*, and a guess that succeeds is not a guess — it is
 * the legitimate owner signing in. Counting successes punishes exactly the
 * wrong people: a shared IP (office, campus, NAT, or a household), or anyone
 * who signs in and out repeatedly across devices, gets locked out of their own
 * account while an attacker's failed attempts are still capped at 20.
 *
 * Failures are what get counted, and the key stays `ip:email` so one targeted
 * account cannot be locked out by someone hammering a different address.
 */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
  handler: json('Too many attempts. Please wait a few minutes and try again.'),
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
    return `${ipKey(req.ip)}:${email}`;
  }
});

/**
 * Session refresh. NOT the credential limiter: /refresh carries no email, so
 * authLimiter's `ip:email` key degenerates to a bare `ip:` that every user on
 * that address shares — one busy client (or a NAT/office/campus IP) would sign
 * everyone else out. Refresh tokens already rotate and are single-use, so
 * replay is stopped by revocation, not by throttling. We key on the token
 * itself and keep a ceiling generous enough for normal navigation.
 */
export const refreshLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 120,
  handler: json('Too many session refreshes. Please wait a moment and try again.'),
  keyGenerator: (req) => {
    const t = req.cookies?.[COOKIE.refresh];
    return t ? `rt${createHash('sha256').update(t).digest('hex').slice(0, 32)}` : ipKey(req.ip);
  }
});

/** Uploads are expensive: cap them per user. */
export const uploadLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 30,
  handler: json('You are uploading too quickly. Give it a moment.'),
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKey(req.ip))
});

/** Swipes: generous but bounded, to stop scripted mass-liking. */
export const swipeLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 120,
  handler: json('That is a lot of swiping. Take a breath.'),
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKey(req.ip))
});

/** Username search / availability lookups: keystroke-driven, so fairly high. */
export const searchLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 60,
  handler: json('Too many searches. Give it a second.'),
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKey(req.ip))
});

/**
 * Location pings. A moving client updates often (the watcher throttles to one
 * write per ~45s), so this only needs to stop a scripted flood.
 */
export const locationLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 40,
  handler: json('Location updates are coming in too fast.'),
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKey(req.ip))
});

/** REST message sending (the socket path has its own token bucket). */
export const messageLimiter = rateLimit({
  ...base,
  windowMs: 10_000,
  limit: 25,
  handler: json('You are sending messages too quickly.'),
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKey(req.ip))
});

/**
 * Simple in-memory sliding-window bucket used by the socket layer
 * (20 messages / 10 seconds per socket, per the spec).
 */
export class TokenBucket {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];
  }

  tryConsume(now = Date.now()) {
    const cutoff = now - this.windowMs;
    while (this.hits.length && this.hits[0] < cutoff) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }

  retryAfterMs(now = Date.now()) {
    if (!this.hits.length) return 0;
    return Math.max(0, this.hits[0] + this.windowMs - now);
  }
}

/**
 * Unauthenticated username-availability probing. The generous `searchLimiter`
 * is right for a signed-in user typing in the search box, but it also allowed
 * an anonymous caller to enumerate handles in bulk. Availability checks get
 * their own, tighter budget.
 */
export const usernameCheckLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 20,
  handler: json('Too many username checks. Give it a second.'),
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKey(req.ip))
});

/** Password-reset requests: deliberately slow, per IP. */
/**
 * Password-reset requests. 5 per 15 min per IP in production.
 *
 * Overridable via RATE_LIMIT_RESET_PER_15MIN for the same narrow reason as the
 * global ceiling: the limiter is in-memory and per-IP, so an automated suite
 * that exercises the recovery flow twice inside one window trips it and the
 * 429 masquerades as a broken reset. The DEFAULT IS UNCHANGED, so production
 * behaviour is identical; only an explicit env var in a test run raises it.
 * This is a spam/flood ceiling -- the controls that actually protect the flow
 * (single-use hashed tokens, 30-minute expiry, issuing a new token
 * invalidating the old, session revocation on change) are unconditional.
 */
export const passwordResetLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: Number(process.env.RATE_LIMIT_RESET_PER_15MIN) || 5,
  handler: json('Too many reset requests. Try again in a few minutes.'),
  keyGenerator: (req) => ipKey(req.ip)
});

/**
 * Email/phone verification codes. Keyed per *user*, not per IP: these routes
 * are authenticated, and an IP key would let one person on a shared network
 * (or behind carrier NAT) lock out everyone else. The service layer applies
 * its own per-kind cap on top of this.
 */
export const verifyCodeLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 10,
  handler: json('Too many verification codes requested. Try again in a few minutes.'),
  keyGenerator: (req) => (req.user?.id ? `u${req.user.id}` : ipKey(req.ip))
});

/** Content creation (posts, moments, comments): stops spam floods. */
/**
 * Likes are far burstier than posts: scrolling a gallery and double-tapping a
 * dozen photos in a few seconds is ordinary behaviour, so the 30/min content
 * limiter is the wrong shape here. Keyed per user (never per IP, which would
 * punish everyone behind one NAT) and set high enough that no human hits it
 * while a scripted like-farm still does.
 */
export const likeLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 120,
  handler: json('You are liking very quickly. Take a breath.'),
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKey(req.ip))
});

export const contentLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 30,
  handler: json('You are posting very quickly. Take a breath.'),
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKey(req.ip))
});

/**
 * Moderation surface. Keyed per moderator rather than per IP: a moderation
 * team commonly shares one office egress address, and one busy moderator must
 * not throttle their colleagues. Generous, because working a report queue is a
 * legitimately request-heavy activity — this is a runaway-script backstop, not
 * a usage cap.
 */
export const adminLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
  handler: json('Slow down a moment and try again.'),
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKey(req.ip))
});
