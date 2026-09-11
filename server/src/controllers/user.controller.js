import { asyncHandler, badRequest } from '../utils/errors.js';
import {
  parseOrThrow,
  updateProfileSchema,
  deckQuerySchema,
  usernameQuerySchema,
  numericIdSchema,
  blockSchema,
  reportSchema,
  photoOrderSchema,
  changeUsernameSchema,
  startVerificationSchema,
  confirmVerificationSchema,
  usernameSchema
} from '../utils/validators.js';
import * as userService from '../services/user.service.js';
import * as authService from '../services/auth.service.js';
import * as uploadService from '../services/upload.service.js';
import { countLikesReceived } from '../services/swipe.service.js';
import { recordView } from '../services/social.service.js';
import {
  getUserInterests,
  getPrompts,
  getVerificationStatus,
  refreshCompletion,
  changeUsername,
  canClaimUsername,
  issueVerification,
  confirmVerification,
  getPublicProfileByUsername
} from '../services/profile.service.js';
import { getSettings } from '../services/location.service.js';
import { storage } from '../services/storage.service.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

export const getDeck = asyncHandler(async (req, res) => {
  const { limit } = parseOrThrow(deckQuerySchema, req.query);
  const deck = await userService.getDeck(req.user.id, limit);
  res.json({ deck, count: deck.length });
});

export const searchUsers = asyncHandler(async (req, res) => {
  const { q, limit } = parseOrThrow(usernameQuerySchema, req.query);
  const results = await userService.searchUsers(req.user.id, q, limit);
  res.json({ results, count: results.length });
});

export const getProfile = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  const profile = await userService.getPublicProfile(req.user.id, id);

  // Log the visit for the target's "Visitors" list. Never blocks the response,
  // and recordView() itself ignores incognito viewers.
  const source = ['deck', 'search', 'nearby', 'bumped', 'likes', 'visitors', 'favorites'].includes(
    String(req.query.from)
  )
    ? String(req.query.from)
    : 'direct';
  recordView(req.user.id, id, source).catch(() => {});

  res.json({ user: profile });
});

export const getMyProfile = asyncHandler(async (req, res) => {
  const [row, photos, likes, interests, prompts, settings, verification] = await Promise.all([
    authService.findUserById(req.user.id),
    userService.listPhotos(req.user.id),
    countLikesReceived(req.user.id),
    getUserInterests(req.user.id),
    getPrompts(req.user.id),
    getSettings(req.user.id),
    getVerificationStatus(req.user.id)
  ]);
  res.json({
    user: {
      ...authService.toPublicUser(row),
      photos,
      interests,
      prompts,
      intent: row.intent || null,
      jobTitle: row.job_title || null,
      school: row.school || null,
      heightCm: row.height_cm === null || row.height_cm === undefined ? null : Number(row.height_cm),
      isVerified: Boolean(row.is_verified)
    },
    settings,
    verification,
    likesReceived: likes
  });
});

export const updateMe = asyncHandler(async (req, res) => {
  const patch = parseOrThrow(updateProfileSchema, req.body);
  const user = await userService.updateProfile(req.user.id, patch);
  const photos = await userService.listPhotos(req.user.id);
  res.json({ user: { ...user, photos } });
});

export const addPhoto = asyncHandler(async (req, res) => {
  const saved = await uploadService.savePhotoFile(req.user.id, req.file.buffer, req.file.mimetype);
  const photo = await userService.addPhoto(req.user.id, saved.url, saved.thumbUrl);
  const photos = await userService.listPhotos(req.user.id);
  res.status(201).json({ photo, photos });
});

export const deletePhoto = asyncHandler(async (req, res) => {
  const photoId = parseOrThrow(numericIdSchema, req.params.id);
  const removed = await userService.deletePhoto(req.user.id, photoId);

  // Best-effort disk cleanup for locally stored profile photos. The 400px
  // rendition is a separate file, stored under thumbs/ rather than photos/,
  // so it must be resolved by basename instead of assuming a directory.
  for (const candidate of [removed.url, removed.thumbUrl]) {
    const match = /\/api\/photos\/([A-Za-z0-9._-]+)$/.exec(candidate || '');
    if (match) await uploadService.removeStoredFile(match[1]).catch(() => {});
  }
  const photos = await userService.listPhotos(req.user.id);
  res.json({ ok: true, photos });
});

export const reorderPhotos = asyncHandler(async (req, res) => {
  const { order } = parseOrThrow(photoOrderSchema, req.body);
  const photos = await userService.reorderPhotos(req.user.id, order);
  res.json({ photos });
});

export const servePhoto = asyncHandler(async (req, res) => {
  // Authorisation, not just authentication: the viewer must still be allowed
  // to see this person's photos at request time. A URL captured before a block
  // must stop working, so the cache window is kept short and private.
  const { key, size } = await uploadService.getPhotoForViewer(req.params.filename, req.user.id);
  res.setHeader('Content-Type', key.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Vary', 'Cookie');
  storage.readStream(key).pipe(res);
});

export const block = asyncHandler(async (req, res) => {
  const { blockedId } = parseOrThrow(blockSchema, req.body);
  const result = await userService.blockUser(req.user.id, blockedId);
  res.status(201).json(result);
});

export const unblock = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  const result = await userService.unblockUser(req.user.id, id);
  res.json(result);
});

export const blockedList = asyncHandler(async (req, res) => {
  const blocked = await userService.listBlocked(req.user.id);
  res.json({ blocked, count: blocked.length });
});

export const report = asyncHandler(async (req, res) => {
  const { reportedId, reason } = parseOrThrow(reportSchema, req.body);
  const result = await userService.reportUser(req.user.id, reportedId, reason);
  res.status(201).json({ ok: true, ...result });
});

export const deleteAccount = asyncHandler(async (req, res) => {
  const files = await authService.listUserAttachmentPaths(req.user.id);
  await authService.deleteAccount(req.user.id);
  for (const f of files) {
    await storage.remove(f.file_path).catch(() => {});
    if (f.thumb_path) await storage.remove(f.thumb_path).catch(() => {});
  }
  res.clearCookie('ec_at', { path: '/' });
  res.clearCookie('ec_rt', { path: '/' });
  res.clearCookie('ec_csrf', { path: '/' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * V1 identity
 * ------------------------------------------------------------------ */

/** Live completion score plus the actionable checklist behind it. */
export const completion = asyncHandler(async (req, res) => {
  res.json(await refreshCompletion(req.user.id));
});

/** Controlled username change: cooldown + anti-impersonation enforced. */
export const updateUsername = asyncHandler(async (req, res) => {
  const { username } = parseOrThrow(changeUsernameSchema, req.body);
  const result = await changeUsername(req.user.id, username);
  res.json({ ...result, shareUrl: `/@${result.username}` });
});

/**
 * Availability for the change form. Authenticated, so this is not the
 * anonymous enumeration surface — that one stays on /api/auth.
 */
export const checkUsername = asyncHandler(async (req, res) => {
  const username = parseOrThrow(usernameSchema, req.query.username ?? '');
  const claim = await canClaimUsername(username, req.user.id);
  res.json({
    username,
    available: claim.ok,
    reason: claim.reason || null
  });
});

/** Send a 6-digit email or phone verification code. */
export const startVerification = asyncHandler(async (req, res) => {
  const { kind, phone } = parseOrThrow(startVerificationSchema, req.body);
  if (kind === 'phone' && !phone) throw badRequest('Enter the phone number to verify.');

  const target = kind === 'email' ? req.user.email : phone;
  const { code, expiresInMinutes } = await issueVerification(req.user.id, kind, target);

  // No mail/SMS provider is wired in this build. The code is a bearer
  // credential, so it is echoed ONLY outside production and never logged --
  // logging it would defeat that gate for anyone with log access.
  logger.info('[verify] code issued', { userId: req.user.id, kind });

  res.json({
    ok: true,
    kind,
    expiresInMinutes,
    message:
      kind === 'email'
        ? 'We sent a 6-digit code to your email address.'
        : 'We sent a 6-digit code by SMS.',
    ...(env.isProd ? {} : { devCode: code })
  });
});

/** Confirm a code and light up the tier. */
export const confirmVerificationCode = asyncHandler(async (req, res) => {
  const { kind, code } = parseOrThrow(confirmVerificationSchema, req.body);
  const result = await confirmVerification(req.user.id, kind, code);
  res.json({ ...result, verification: await getVerificationStatus(req.user.id) });
});

/** Public profile by handle, backing the shareable /@username URL. */
export const getByUsername = asyncHandler(async (req, res) => {
  const username = parseOrThrow(usernameSchema, req.params.username);
  const user = await getPublicProfileByUsername(username, req.user?.id ?? null);
  res.json({ user });
});
