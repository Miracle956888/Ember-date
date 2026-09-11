import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import * as cookieLib from 'cookie';
import { env, COOKIE, cookieOptions } from '../config/env.js';
import AppError, { unauthorized, forbidden } from '../utils/errors.js';
import { queryOne } from '../db/pool.js';
import { assertUsable, assertTokenNotStale } from '../services/auth.service.js';

/**
 * Re-check moderation state on every authenticated request.
 *
 * `assertUsable` is the same predicate the login path uses, so a ban, a
 * suspension and a lapsed suspension all behave identically whether the user
 * is signing in or already holds a valid access cookie.
 */
function assertNotSanctioned(user, payload) {
  assertUsable(user);
  assertTokenNotStale(user, payload);
}

// ------------------------------------------------------------------ tokens

export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email, name: user.display_name ?? user.displayName },
    env.JWT.accessSecret,
    { expiresIn: env.JWT.accessTtl, issuer: 'ephemeral-chat', audience: 'ec-web' }
  );
}

export function signRefreshToken(user, jti) {
  return jwt.sign({ sub: String(user.id), jti }, env.JWT.refreshSecret, {
    expiresIn: env.JWT.refreshTtl,
    issuer: 'ephemeral-chat',
    audience: 'ec-web'
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT.accessSecret, { issuer: 'ephemeral-chat', audience: 'ec-web' });
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.JWT.refreshSecret, { issuer: 'ephemeral-chat', audience: 'ec-web' });
}

export function newCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** Set access + refresh + csrf cookies on the response. */
export function setAuthCookies(res, { accessToken, refreshToken, csrfToken }) {
  if (accessToken) res.cookie(COOKIE.access, accessToken, cookieOptions(env.JWT.accessCookieMaxAge));
  if (refreshToken) res.cookie(COOKIE.refresh, refreshToken, cookieOptions(env.JWT.refreshCookieMaxAge));
  if (csrfToken) {
    // readable by JS on purpose: this is the "double submit" half of the pair
    res.cookie(COOKIE.csrf, csrfToken, cookieOptions(env.JWT.refreshCookieMaxAge, { httpOnly: false }));
  }
}

export function clearAuthCookies(res) {
  const base = { path: '/', sameSite: 'lax', secure: env.isProd };
  res.clearCookie(COOKIE.access, base);
  res.clearCookie(COOKIE.refresh, base);
  res.clearCookie(COOKIE.csrf, { ...base, httpOnly: false });
}

// -------------------------------------------------------------- middleware

/** Require a valid access token cookie; attaches req.user. */
export async function requireAuth(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE.access];
    if (!token) throw unauthorized('You need to sign in to do that.', { code: 'NO_TOKEN' });

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
      throw unauthorized('Your session has expired. Please sign in again.', { code });
    }

    const user = await queryOne(
      'SELECT id, email, display_name, avatar_url, role, status, suspended_until, sessions_valid_from FROM users WHERE id = ? LIMIT 1',
      [Number(payload.sub)]
    );
    if (!user) throw unauthorized('Your session is no longer valid.', { code: 'USER_GONE' });

    // A moderation decision has to bite the sessions that already exist, not
    // just the next sign-in. Without this a banned account keeps its cookie and
    // can carry on messaging until the token expires.
    assertNotSanctioned(user, payload);

    req.user = {
      id: Number(user.id),
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      role: user.role || 'user',
      status: user.status || 'active'
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Attaches req.user when a valid token exists, but never rejects. */
export async function optionalAuth(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE.access];
    if (token) {
      const payload = verifyAccessToken(token);
      const user = await queryOne(
        'SELECT id, email, display_name, avatar_url, role, status, suspended_until, sessions_valid_from FROM users WHERE id = ? LIMIT 1',
        [Number(payload.sub)]
      );
      // A sanctioned account falls back to anonymous rather than erroring:
      // optionalAuth must never reject, and treating them as signed-out is the
      // safe direction.
      if (user) {
        assertNotSanctioned(user, payload);
        req.user = {
          id: Number(user.id),
          email: user.email,
          displayName: user.display_name,
          avatarUrl: user.avatar_url,
          role: user.role || 'user',
          status: user.status || 'active'
        };
      }
    }
  } catch {
    /* ignore - anonymous */
  }
  next();
}

// ------------------------------------------------------------ role gating

/** Privilege ordering. A role satisfies any requirement at or below its rank. */
const ROLE_RANK = { user: 0, moderator: 1, admin: 2 };

export function rankOf(role) {
  return ROLE_RANK[role] ?? 0;
}

/**
 * Require a minimum role. Must be mounted *after* `requireAuth`, which is what
 * puts `role` on `req.user`.
 *
 * A signed-in user who lacks the role gets 404, not 403: confirming that
 * `/api/admin/*` exists tells an attacker where to point their effort. The
 * unauthenticated case still 401s via `requireAuth`.
 */
export function requireRole(minRole) {
  const needed = rankOf(minRole);
  return function roleGate(req, _res, next) {
    if (!req.user) return next(unauthorized('You need to sign in to do that.', { code: 'NO_TOKEN' }));
    if (rankOf(req.user.role) < needed) {
      return next(new AppError(404, 'Not found.', { code: 'NOT_FOUND' }));
    }
    return next();
  };
}

export const requireModerator = requireRole('moderator');
export const requireAdmin = requireRole('admin');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF: the `ec_csrf` cookie must equal the `x-csrf-token` header
 * on every state-changing request.
 */
export function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const cookieToken = req.cookies?.[COOKIE.csrf];
  const headerToken = req.get('x-csrf-token') || req.body?._csrf;

  if (!cookieToken || !headerToken) {
    return next(forbidden('Your session token is missing. Refresh the page and try again.', { code: 'CSRF_MISSING' }));
  }
  const a = Buffer.from(String(cookieToken));
  const b = Buffer.from(String(headerToken));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(forbidden('Your session token is invalid. Refresh the page and try again.', { code: 'CSRF_INVALID' }));
  }
  return next();
}

// ------------------------------------------------------------ socket auth

/** io.use() handler: authenticates a socket from the httpOnly access cookie. */
export async function socketAuth(socket, next) {
  try {
    const rawCookie = socket.handshake.headers?.cookie;
    if (!rawCookie) return next(new Error('UNAUTHORIZED'));

    const parsed = cookieLib.parse(rawCookie);
    const token = parsed[COOKIE.access];
    if (!token) return next(new Error('UNAUTHORIZED'));

    const payload = verifyAccessToken(token);
    const user = await queryOne(
      'SELECT id, email, display_name, avatar_url, role, status, suspended_until, sessions_valid_from FROM users WHERE id = ? LIMIT 1',
      [Number(payload.sub)]
    );
    if (!user) return next(new Error('UNAUTHORIZED'));

    // Sockets are long-lived, so a ban has to be enforced at handshake too --
    // otherwise a banned user keeps a live realtime channel.
    assertNotSanctioned(user, payload);

    socket.data.user = {
      id: Number(user.id),
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      role: user.role || 'user',
      status: user.status || 'active'
    };
    return next();
  } catch {
    return next(new Error('UNAUTHORIZED'));
  }
}
