import { asyncHandler } from '../utils/errors.js';
import {
  parseOrThrow,
  numericIdSchema,
  sendMessageSchema,
  messagesQuerySchema,
  shareLocationSchema,
  liveLocationSchema
} from '../utils/validators.js';
import * as messageService from '../services/message.service.js';
import * as locationService from '../services/location.service.js';
import { inspectMessage } from '../utils/safety.js';
import { purgeFiles } from '../jobs/cleanup.js';
import { getIo } from '../sockets/index.js';
import { env } from '../config/env.js';

export const listMessages = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const { before, limit } = parseOrThrow(messagesQuerySchema, req.query);
  const page = await messageService.listMessages(conversationId, req.user.id, { before, limit });
  res.json({ ...page, serverTime: new Date().toISOString() });
});

export const sendMessage = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const data = parseOrThrow(sendMessageSchema, req.body);

  const { message, participants } = await messageService.createMessage({
    conversationId,
    senderId: req.user.id,
    body: data.body,
    clientUuid: data.clientUuid,
    attachmentId: data.attachmentId,
    envelope: data.envelope || null
  });

  const io = getIo();
  if (io) {
    io.to(`conv:${conversationId}`).emit('chat:message', message);
    io.to(`user:${participants.otherUserId}`).emit('chat:message:notify', {
      conversationId,
      message
    });
  }

  res.status(201).json({ message, serverTime: new Date().toISOString() });
});

/**
 * Share a place in a chat. A live share keeps updating for `liveMinutes`, but
 * can never outlive the message's 24h TTL.
 */
export const shareLocation = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const data = parseOrThrow(shareLocationSchema, req.body);

  const { message, participants } = await messageService.createMessage({
    conversationId,
    senderId: req.user.id,
    body: data.liveMinutes > 0 ? 'Shared live location' : 'Shared a location',
    type: 'location',
    clientUuid: data.clientUuid,
    location: {
      lat: data.lat,
      lng: data.lng,
      accuracy: data.accuracy,
      label: data.label,
      liveMinutes: data.liveMinutes
    }
  });

  const io = getIo();
  if (io) {
    io.to(`conv:${conversationId}`).emit('chat:message', message);
    io.to(`user:${participants.otherUserId}`).emit('chat:message:notify', { conversationId, message });
  }

  res.status(201).json({ message, serverTime: new Date().toISOString() });
});

/** Move an in-flight live share. Broadcast so the peer's pin follows along. */
export const updateLiveLocation = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const messageId = parseOrThrow(numericIdSchema, req.params.messageId);
  const data = parseOrThrow(liveLocationSchema, req.body);

  const result = await locationService.updateLiveLocation(req.user.id, messageId, data);

  const io = getIo();
  if (io) {
    io.to(`conv:${conversationId}`).emit('chat:location:update', {
      conversationId,
      messageId,
      ...result
    });
  }
  res.json(result);
});

export const stopLiveLocation = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const messageId = parseOrThrow(numericIdSchema, req.params.messageId);
  const result = await locationService.stopLiveLocation(req.user.id, messageId);

  const io = getIo();
  if (io) io.to(`conv:${conversationId}`).emit('chat:location:stopped', { conversationId, messageId });
  res.json(result);
});

/**
 * Pre-send check powering the "Are you sure?" nudge. The client calls this
 * before sending; it never blocks, it only advises.
 */
export const checkMessage = asyncHandler(async (req, res) => {
  const result = inspectMessage(typeof req.body?.body === 'string' ? req.body.body : '');
  res.json({
    flagged: Boolean(result.flagged),
    category: result.category || null,
    prompt: result.senderPrompt || null
  });
});

export const clearChat = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const result = await messageService.clearConversation(conversationId, req.user.id);
  const deletedFiles = await purgeFiles(result.files);

  const io = getIo();
  if (io) {
    io.to(`conv:${conversationId}`).emit('chat:cleared', {
      conversationId,
      clearedBy: req.user.id,
      deletedMessages: result.deletedMessages
    });
  }

  res.json({ ok: true, deletedMessages: result.deletedMessages, deletedFiles });
});

export const markRead = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const result = await messageService.markRead(conversationId, req.user.id);

  const io = getIo();
  if (io) {
    io.to(`conv:${conversationId}`).emit('chat:read', {
      conversationId,
      readerId: req.user.id,
      readAt: result.readAt
    });
  }
  res.json(result);
});

export const iceServers = asyncHandler(async (_req, res) => {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  if (env.TURN.url) {
    servers.push({
      urls: env.TURN.url.split(',').map((s) => s.trim()).filter(Boolean),
      username: env.TURN.username || undefined,
      credential: env.TURN.credential || undefined
    });
  }
  res.json({ iceServers: servers, iceTransportPolicy: 'all' });
});
