/**
 * social.controller — HTTP surface for Moments, Posts, polls and comments.
 *
 * Controllers stay thin: parse, delegate, shape the response. Every authz and
 * expiry decision lives in the services, so there is one place to audit and no
 * route can accidentally skip a check.
 */
import { asyncHandler, badRequest } from '../utils/errors.js';
import {
  parseOrThrow,
  numericIdSchema,
  createMomentSchema,
  momentReactionSchema,
  momentReplySchema,
  createPostSchema,
  pollVoteSchema,
  createCommentSchema,
  feedQuerySchema,
  contentReportSchema,
  listQuerySchema
} from '../utils/validators.js';
import * as momentService from '../services/moment.service.js';
import * as postService from '../services/post.service.js';
import * as reportService from '../services/report.service.js';
import * as messageService from '../services/message.service.js';
import * as likeService from '../services/like.service.js';
import { getIo } from '../sockets/index.js';

/* ------------------------------------------------------------------ *
 * Moments
 * ------------------------------------------------------------------ */

export const createMoment = asyncHandler(async (req, res) => {
  const input = parseOrThrow(createMomentSchema, req.body);
  const moment = await momentService.createMoment(req.user.id, input);
  res.status(201).json({ moment });
});

export const momentsFeed = asyncHandler(async (req, res) => {
  res.json(await momentService.feed(req.user.id));
});

export const getMoment = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json({ moment: await momentService.getMoment(id, req.user.id) });
});

export const momentsByUser = asyncHandler(async (req, res) => {
  const userId = parseOrThrow(numericIdSchema, req.params.userId);
  res.json({ moments: await momentService.byUser(userId, req.user.id) });
});

export const viewMoment = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await momentService.recordView(id, req.user.id));
});

export const momentViewers = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  const { limit } = parseOrThrow(listQuerySchema, req.query);
  const viewers = await momentService.viewers(id, req.user.id, { limit });
  res.json({ viewers, count: viewers.length });
});

export const reactToMoment = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  const { emoji } = parseOrThrow(momentReactionSchema, req.body);
  res.json({ moment: await momentService.react(id, req.user.id, emoji) });
});

export const unreactToMoment = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json({ moment: await momentService.unreact(id, req.user.id) });
});

/**
 * Reply to a moment → a real DM in the existing conversation.
 *
 * The reply is sent through `message.service` rather than a parallel path, so
 * it inherits the conversation's disappearing timer, its read receipts and its
 * socket delivery for free. It is sent as plaintext: the sender is replying
 * from a feed, not from the encrypted thread, and silently sending an
 * unencrypted message inside an E2EE conversation without saying so would be
 * dishonest — so the body is prefixed to make the context explicit.
 */
export const replyToMoment = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  const { body } = parseOrThrow(momentReplySchema, req.body);

  const { conversationId, moment, otherUserId, text } = await momentService.replyToMoment(
    id,
    req.user.id,
    body
  );

  const { message } = await messageService.createMessage({
    conversationId,
    senderId: req.user.id,
    body: text,
    type: 'text',
    // replyToMoment already sent a `moment_reply` notification.
    notifyRecipient: false
  });

  // Deliver it live exactly like a message typed in the thread. The room is
  // `conv:<id>` (see sockets/chat.handler.js) and the payload is the bare
  // message object -- matching message.controller.js exactly, because chat.js
  // reads `msg.id`/`msg.body` straight off the event. The recipient also needs
  // the `chat:message:notify` fan-out or their unread badge never moves.
  try {
    const io = getIo();
    if (io) {
      io.to(`conv:${conversationId}`).emit('chat:message', message);
      io.to(`user:${otherUserId}`).emit('chat:message:notify', { conversationId, message });
    }
  } catch {
    /* socket layer is best-effort; the message is already persisted */
  }

  res.status(201).json({ sent: true, conversationId, momentId: moment.id, message });
});

export const deleteMoment = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await momentService.deleteMoment(id, req.user.id));
});

/* ------------------------------------------------------------------ *
 * Posts
 * ------------------------------------------------------------------ */

export const createPost = asyncHandler(async (req, res) => {
  const input = parseOrThrow(createPostSchema, req.body);
  const post = await postService.createPost(req.user.id, input);
  res.status(201).json({ post });
});

export const postsFeed = asyncHandler(async (req, res) => {
  const { limit, before } = parseOrThrow(feedQuerySchema, req.query);
  const authorId = req.query.userId ? parseOrThrow(numericIdSchema, req.query.userId) : null;
  res.json(await postService.feed(req.user.id, { limit, before, authorId }));
});

export const getPost = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json({ post: await postService.getPost(id, req.user.id) });
});

export const deletePost = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await postService.deletePost(id, req.user.id));
});

export const votePoll = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  const { optionId } = parseOrThrow(pollVoteSchema, req.body);
  res.json({ post: await postService.vote(id, req.user.id, optionId) });
});

/**
 * Like/unlike a post. Delegates to the polymorphic primitive, so the
 * idempotence guarantee proven in Phase 4 applies unchanged here.
 */
export const togglePostLike = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await likeService.toggleLike(req.user.id, 'post', id, { actorUsername: req.user.username }));
});

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

export const listComments = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await postService.listComments(id, req.user.id));
});

export const addComment = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  const { body, parentId } = parseOrThrow(createCommentSchema, req.body);
  const comment = await postService.addComment(id, req.user.id, { body, parentId: parentId || null });
  res.status(201).json({ comment });
});

/** Which post does this comment belong to? Powers notification deep links. */
export const commentContext = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await postService.commentContext(id, req.user.id));
});

export const deleteComment = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await postService.deleteComment(id, req.user.id));
});

export const toggleCommentLike = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await likeService.toggleLike(req.user.id, 'comment', id, { actorUsername: req.user.username }));
});

/* ------------------------------------------------------------------ *
 * Reporting — every content surface, one endpoint
 * ------------------------------------------------------------------ */

export const createReport = asyncHandler(async (req, res) => {
  const input = parseOrThrow(contentReportSchema, req.body);
  if (!input.targetType) throw badRequest('Choose what you are reporting.');
  res.status(201).json(await reportService.report(req.user.id, input));
});

export const reportStatus = asyncHandler(async (req, res) => {
  const { targetType, targetId } = req.params;
  res.json({
    reported: await reportService.hasReported(req.user.id, targetType, Number(targetId))
  });
});
