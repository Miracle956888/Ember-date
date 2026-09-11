import { asyncHandler } from '../utils/errors.js';
import { parseOrThrow, swipeSchema } from '../utils/validators.js';
import * as swipeService from '../services/swipe.service.js';
import { getIo } from '../sockets/index.js';
import { logger } from '../utils/logger.js';

const log = logger.child('swipe');

export const createSwipe = asyncHandler(async (req, res) => {
  const { swipeeId, direction } = parseOrThrow(swipeSchema, req.body);
  const result = await swipeService.recordSwipe(req.user.id, swipeeId, direction);

  if (result.matched) {
    log.info('match created', { matchId: result.matchId, a: req.user.id, b: swipeeId });
    const io = getIo();
    if (io) {
      // Tell the other user in realtime so their match list updates instantly.
      io.to(`user:${swipeeId}`).emit('match:new', {
        matchId: result.matchId,
        conversationId: result.conversationId,
        user: {
          id: req.user.id,
          displayName: req.user.displayName,
          avatarUrl: req.user.avatarUrl
        }
      });
    }
  }

  res.status(201).json(result);
});

export const rewind = asyncHandler(async (req, res) => {
  const result = await swipeService.rewindLastSwipe(req.user.id);
  res.json(result);
});

export const likesReceived = asyncHandler(async (req, res) => {
  const count = await swipeService.countLikesReceived(req.user.id);
  res.json({ count });
});
