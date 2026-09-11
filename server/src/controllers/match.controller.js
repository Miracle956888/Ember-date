import { asyncHandler } from '../utils/errors.js';
import { parseOrThrow, numericIdSchema } from '../utils/validators.js';
import * as matchService from '../services/match.service.js';
import { purgeFiles } from '../jobs/cleanup.js';
import { getIo } from '../sockets/index.js';

export const listMatches = asyncHandler(async (req, res) => {
  const matches = await matchService.listMatches(req.user.id);
  const newMatches = matches.filter((m) => !m.lastMessage);
  const conversations = matches.filter((m) => m.lastMessage);
  res.json({
    matches,
    newMatches,
    conversations,
    totalUnread: matches.reduce((sum, m) => sum + m.unreadCount, 0)
  });
});

export const getConversation = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  const conv = await matchService.getConversationWithPeer(id, req.user.id);
  res.json(conv);
});

export const unmatch = asyncHandler(async (req, res) => {
  const matchId = parseOrThrow(numericIdSchema, req.params.id);
  const result = await matchService.unmatch(matchId, req.user.id);

  // Cascade removed the rows; now remove the bytes.
  const deletedFiles = await purgeFiles(result.files);

  const io = getIo();
  if (io) {
    io.to(`user:${result.otherUserId}`).emit('match:removed', { matchId: result.matchId });
  }
  res.json({ ok: true, matchId: result.matchId, deletedFiles });
});
