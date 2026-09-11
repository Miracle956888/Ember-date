/**
 * Social routes — /api/moments, /api/posts, /api/comments, /api/reports.
 *
 * Route order rule (bitten before): every literal segment is registered ahead
 * of the `/:id` catch-all, or `/api/moments/feed` gets parsed as a moment with
 * the id "feed".
 *
 * Limiter choice: creation goes through `contentLimiter` (30/min) because a
 * post writes rows and media; reactions, votes and views go through
 * `likeLimiter` (120/min) because they are cheap, bursty and a user scrolling
 * a stories tray legitimately fires dozens in a minute.
 */
import { Router } from 'express';
import * as ctrl from '../controllers/social.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';
import { contentLimiter, likeLimiter } from '../middleware/rateLimit.js';

export const momentRoutes = Router();
momentRoutes.use(requireAuth);

momentRoutes.get('/', ctrl.momentsFeed);
momentRoutes.get('/feed', ctrl.momentsFeed);
momentRoutes.get('/user/:userId', ctrl.momentsByUser);
momentRoutes.post('/', csrfProtection, contentLimiter, ctrl.createMoment);

momentRoutes.get('/:id/viewers', ctrl.momentViewers);
momentRoutes.post('/:id/view', csrfProtection, likeLimiter, ctrl.viewMoment);
momentRoutes.post('/:id/react', csrfProtection, likeLimiter, ctrl.reactToMoment);
momentRoutes.delete('/:id/react', csrfProtection, likeLimiter, ctrl.unreactToMoment);
momentRoutes.post('/:id/reply', csrfProtection, contentLimiter, ctrl.replyToMoment);
momentRoutes.get('/:id', ctrl.getMoment);
momentRoutes.delete('/:id', csrfProtection, ctrl.deleteMoment);

export const postRoutes = Router();
postRoutes.use(requireAuth);

postRoutes.get('/', ctrl.postsFeed);
postRoutes.get('/feed', ctrl.postsFeed);
postRoutes.post('/', csrfProtection, contentLimiter, ctrl.createPost);

postRoutes.get('/:id/comments', ctrl.listComments);
postRoutes.post('/:id/comments', csrfProtection, contentLimiter, ctrl.addComment);
postRoutes.post('/:id/like', csrfProtection, likeLimiter, ctrl.togglePostLike);
postRoutes.post('/:id/vote', csrfProtection, likeLimiter, ctrl.votePoll);
postRoutes.get('/:id', ctrl.getPost);
postRoutes.delete('/:id', csrfProtection, ctrl.deletePost);

export const commentRoutes = Router();
commentRoutes.use(requireAuth);

commentRoutes.get('/:id/context', ctrl.commentContext);
commentRoutes.post('/:id/like', csrfProtection, likeLimiter, ctrl.toggleCommentLike);
commentRoutes.delete('/:id', csrfProtection, ctrl.deleteComment);

export const reportRoutes = Router();
reportRoutes.use(requireAuth);

reportRoutes.post('/', csrfProtection, contentLimiter, ctrl.createReport);
reportRoutes.get('/:targetType/:targetId', ctrl.reportStatus);
