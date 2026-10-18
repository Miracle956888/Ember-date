import { COOKIE, env } from '../config/env.js';
import { asyncHandler, unauthorized } from '../utils/errors.js';
import {
  parseOrThrow,
  registerSchema,
  loginSchema,
  usernameSchema,
  forgotPasswordSchema,
  resetPasswordSchema
} from '../utils/validators.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  setAuthCookies,
  clearAuthCookies,
  newCsrfToken
} from '../middleware/auth.js';
import * as authService from '../services/auth.service.js';
import { enqueueDelivery } from '../services/delivery.service.js';
import { logger } from '../utils/logger.js';

const log = logger.child('auth');

async function issueSession(res, user) {
  const jti = authService.newJti();
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user, jti);
  const csrfToken = newCsrfToken();
  await authService.storeRefreshToken(
    Number(user.id),
    jti,
    authService.refreshExpiryDate().toISOString().slice(0, 19).replace('T', ' ')
  );
  setAuthCookies(res, { accessToken, refreshToken, csrfToken });
  return { csrfToken };
}

export const register = asyncHandler(async (req, res) => {
  const data = parseOrThrow(registerSchema, req.body);
  const user = await authService.createUser(data);
  const { csrfToken } = await issueSession(res, user);
  log.info('registered', { userId: Number(user.id) });
  res.status(201).json({ user: authService.toPublicUser(user), csrfToken });
});

/**
 * Live availability check for the sign-up wizard and the profile editor.
 * Public by design: usernames are public handles, and the same information is
 * obtainable by trying to register. Rate limited by the auth limiter.
 */
export const checkUsername = asyncHandler(async (req, res) => {
  const username = parseOrThrow(usernameSchema, req.query.username);
  const available = await authService.isUsernameAvailable(username, null);
  res.json({ username, available });
});

export const login = asyncHandler(async (req, res) => {
  const data = parseOrThrow(loginSchema, req.body);
  const user = await authService.verifyCredentials(data.email, data.password, req.ip);
  const { csrfToken } = await issueSession(res, user);
  await authService.markOnline(Number(user.id));
  log.info('login', { userId: Number(user.id) });
  res.json({ user: authService.toPublicUser(user), csrfToken });
});

export const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.[COOKIE.refresh];
  if (token) {
    try {
      const payload = verifyRefreshToken(token);
      await authService.revokeRefreshToken(payload.jti);
      await authService.markOffline(Number(payload.sub));
    } catch {
      /* already invalid - nothing to revoke */
    }
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

export const me = asyncHandler(async (req, res) => {
  const user = await authService.findUserById(req.user.id);
  if (!user) throw unauthorized('Your session is no longer valid.');
  res.json({
    user: authService.toPublicUser(user),
    csrfToken: req.cookies?.[COOKIE.csrf] || null,
    config: {
      messageTtlHours: env.MESSAGE_TTL_HOURS,
      maxImageMb: env.MAX_IMAGE_MB,
      maxVideoMb: env.MAX_VIDEO_MB
    }
  });
});

/** Rotating refresh: the old jti is revoked and a new one issued. */
export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.[COOKIE.refresh];
  if (!token) throw unauthorized('Your session has expired. Please sign in again.', { code: 'NO_REFRESH' });

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    clearAuthCookies(res);
    throw unauthorized('Your session has expired. Please sign in again.', { code: 'REFRESH_INVALID' });
  }

  const active = await authService.isRefreshTokenActive(payload.jti);
  if (!active) {
    // Token reuse or revoked session: nuke every session for safety.
    await authService.revokeAllUserTokens(Number(payload.sub));
    clearAuthCookies(res);
    throw unauthorized('Your session has expired. Please sign in again.', { code: 'REFRESH_REVOKED' });
  }

  const user = await authService.findUserById(Number(payload.sub));
  if (!user) {
    clearAuthCookies(res);
    throw unauthorized('Your session is no longer valid.', { code: 'USER_GONE' });
  }

  await authService.revokeRefreshToken(payload.jti);
  const { csrfToken } = await issueSession(res, user);
  res.json({ user: authService.toPublicUser(user), csrfToken });
});

// ------------------------------------------------------- password recovery

/**
 * Always returns the same response. Reset bearer data is placed in an
 * authenticated-encryption outbox and never logged or returned in production.
 */
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = parseOrThrow(forgotPasswordSchema, req.body);
  const created = await authService.createPasswordReset(email);

  if (created) {
    try {
      await enqueueDelivery('password_reset', {
        to: created.user.email,
        displayName: created.user.display_name,
        token: created.token
      });
      log.info('password reset queued', { userId: Number(created.user.id) });
    } catch (error) {
      // Same public response for existing and unknown addresses. Do not log
      // recipient, reset link, token, or SMTP response content.
      log.error('password reset queue failed', { code: error.code || 'QUEUE_ERROR' });
    }
  }
  res.json({ ok: true, message: 'If that email is registered, a reset link is on its way.' });
});

/** Finish a reset: consume the single-use token and set the new password. */
export const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = parseOrThrow(resetPasswordSchema, req.body);
  const userId = await authService.consumePasswordReset(token, password);
  clearAuthCookies(res);
  log.info('password reset completed', { userId });
  res.json({ ok: true, message: 'Your password has been changed. Sign in with your new password.' });
});
