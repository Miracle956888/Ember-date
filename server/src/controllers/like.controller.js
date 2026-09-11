import { asyncHandler, badRequest } from '../utils/errors.js';
import { parseOrThrow, likeTargetSchema, likeBodySchema, listQuerySchema } from '../utils/validators.js';
import * as likeService from '../services/like.service.js';
import * as notificationService from '../services/notification.service.js';

/**
 * One set of endpoints serves every likeable object, because the service is
 * polymorphic. `POST /api/likes` is idempotent by design: clients may retry
 * freely and the count will not inflate.
 */

export const create = asyncHandler(async (req, res) => {
  const { targetType, targetId } = parseOrThrow(likeBodySchema, req.body);
  const result = await likeService.like(req.user.id, targetType, targetId, {
    actorUsername: req.user.username
  });
  // 200 rather than 201 on a repeat: nothing new was created.
  res.status(result.alreadyLiked ? 200 : 201).json(result);
});

export const remove = asyncHandler(async (req, res) => {
  const { targetType, targetId } = parseOrThrow(likeTargetSchema, req.params);
  res.json(await likeService.unlike(req.user.id, targetType, targetId));
});

export const toggle = asyncHandler(async (req, res) => {
  const { targetType, targetId } = parseOrThrow(likeBodySchema, req.body);
  res.json(
    await likeService.toggleLike(req.user.id, targetType, targetId, { actorUsername: req.user.username })
  );
});

export const status = asyncHandler(async (req, res) => {
  const { targetType, targetId } = parseOrThrow(likeTargetSchema, req.params);
  const [count, liked] = await Promise.all([
    likeService.likeCount(targetType, targetId),
    likeService.hasLiked(req.user.id, targetType, targetId)
  ]);
  res.json({ targetType, targetId: Number(targetId), count, liked });
});

export const listLikers = asyncHandler(async (req, res) => {
  const { targetType, targetId } = parseOrThrow(likeTargetSchema, req.params);
  const { limit } = parseOrThrow(listQuerySchema, req.query);
  const users = await likeService.likers(req.user.id, targetType, targetId, { limit });
  res.json({ users, count: users.length });
});

/* -------------------------------------------------------- notifications */

export const notifications = asyncHandler(async (req, res) => {
  const { limit } = parseOrThrow(listQuerySchema, req.query);
  const before = req.query.before ? Number(req.query.before) : null;
  if (before !== null && !Number.isFinite(before)) throw badRequest('Invalid cursor.');
  const [items, unread] = await Promise.all([
    notificationService.list(req.user.id, { limit, before }),
    notificationService.unreadCount(req.user.id)
  ]);
  res.json({
    notifications: items,
    unread,
    nextCursor: items.length === limit ? items[items.length - 1].id : null
  });
});

export const unread = asyncHandler(async (req, res) => {
  res.json({ unread: await notificationService.unreadCount(req.user.id) });
});

export const readNotifications = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  res.json({ unread: await notificationService.markRead(req.user.id, ids) });
});

export const getPrefs = asyncHandler(async (req, res) => {
  res.json({ prefs: await notificationService.getPrefs(req.user.id) });
});

export const putPrefs = asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object') throw badRequest('Invalid preferences.');
  res.json({ prefs: await notificationService.updatePrefs(req.user.id, req.body) });
});
