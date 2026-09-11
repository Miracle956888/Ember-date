import { TokenBucket } from '../middleware/rateLimit.js';
import { assertParticipant } from '../services/match.service.js';
import { createMessage, markRead, listMessages } from '../services/message.service.js';
import { logger } from '../utils/logger.js';

const log = logger.child('chat');

/** Spec: 20 messages / 10 seconds per socket. */
const MESSAGE_LIMIT = 20;
const MESSAGE_WINDOW_MS = 10_000;
const TYPING_LIMIT = 30;
const TYPING_WINDOW_MS = 10_000;

function fail(socket, code, message) {
  socket.emit('error', { code, message });
}

export function registerChatHandlers(io, socket) {
  const user = socket.data.user;
  const messageBucket = new TokenBucket(MESSAGE_LIMIT, MESSAGE_WINDOW_MS);
  const typingBucket = new TokenBucket(TYPING_LIMIT, TYPING_WINDOW_MS);

  /** Verify participation on EVERY event, then cache for this socket. */
  async function ensureParticipant(conversationId) {
    const id = Number(conversationId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('INVALID_CONVERSATION');
    const part = await assertParticipant(id, user.id);
    return part;
  }

  socket.on('chat:join', async (payload, ack) => {
    try {
      const conversationId = Number(payload?.conversationId);
      const part = await ensureParticipant(conversationId);
      socket.join(`conv:${conversationId}`);
      socket.data.conversations.add(conversationId);

      const page = await listMessages(conversationId, user.id, { limit: 30 });
      const response = {
        conversationId,
        otherUserId: part.otherUserId,
        messages: page.messages,
        hasMore: page.hasMore,
        ttlHours: page.ttlHours,
        serverTime: new Date().toISOString()
      };
      if (typeof ack === 'function') ack({ ok: true, ...response });
      else socket.emit('chat:joined', response);
    } catch (err) {
      log.warn('join failed', { userId: user.id, error: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: 'You are not part of that conversation.' });
      fail(socket, 'JOIN_FAILED', 'You are not part of that conversation.');
    }
  });

  socket.on('chat:leave', (payload) => {
    const conversationId = Number(payload?.conversationId);
    if (Number.isInteger(conversationId)) {
      socket.leave(`conv:${conversationId}`);
      socket.data.conversations.delete(conversationId);
    }
  });

  socket.on('chat:message', async (payload, ack) => {
    try {
      if (!messageBucket.tryConsume()) {
        const retryMs = messageBucket.retryAfterMs();
        if (typeof ack === 'function') ack({ ok: false, error: 'You are sending messages too quickly.', retryMs });
        return fail(socket, 'RATE_LIMITED', 'You are sending messages too quickly.');
      }

      const conversationId = Number(payload?.conversationId);
      const part = await ensureParticipant(conversationId);

      const { message } = await createMessage({
        conversationId,
        senderId: user.id,
        body: typeof payload?.body === 'string' ? payload.body.slice(0, 4000) : null,
        clientUuid: payload?.clientUuid || null,
        attachmentId: payload?.attachmentId ? Number(payload.attachmentId) : null,
        // Sealed payload, passed straight through. The server cannot read it.
        envelope: payload?.envelope?.ciphertext
          ? {
            ciphertext: String(payload.envelope.ciphertext).slice(0, 16_384),
            iv: String(payload.envelope.iv || '').slice(0, 32),
            keyId: payload.envelope.keyId ? String(payload.envelope.keyId).slice(0, 64) : null
          }
          : null
      });

      // Everyone in the thread (both tabs of both users) gets the canonical row.
      io.to(`conv:${conversationId}`).emit('chat:message', message);
      // The recipient gets a notification even if their thread is closed.
      io.to(`user:${part.otherUserId}`).emit('chat:message:notify', { conversationId, message });

      if (typeof ack === 'function') ack({ ok: true, message });
      return undefined;
    } catch (err) {
      log.warn('message failed', { userId: user.id, error: err.message });
      const msg = err.expose ? err.message : 'That message could not be sent.';
      if (typeof ack === 'function') ack({ ok: false, error: msg });
      return fail(socket, 'MESSAGE_FAILED', msg);
    }
  });

  socket.on('chat:typing', async (payload) => {
    try {
      if (!typingBucket.tryConsume()) return;
      const conversationId = Number(payload?.conversationId);
      if (!socket.data.conversations.has(conversationId)) {
        await ensureParticipant(conversationId);
      }
      socket.to(`conv:${conversationId}`).emit('chat:typing', {
        conversationId,
        userId: user.id,
        isTyping: Boolean(payload?.isTyping)
      });
    } catch {
      /* silently ignore typing errors */
    }
  });

  socket.on('chat:read', async (payload, ack) => {
    try {
      const conversationId = Number(payload?.conversationId);
      await ensureParticipant(conversationId);
      const result = await markRead(conversationId, user.id);
      io.to(`conv:${conversationId}`).emit('chat:read', {
        conversationId,
        readerId: user.id,
        readAt: result.readAt
      });
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  /** Client asks for anything it missed while disconnected. */
  socket.on('chat:sync', async (payload, ack) => {
    try {
      const conversationId = Number(payload?.conversationId);
      await ensureParticipant(conversationId);
      const page = await listMessages(conversationId, user.id, { limit: 50 });
      if (typeof ack === 'function') {
        ack({ ok: true, conversationId, messages: page.messages, serverTime: new Date().toISOString() });
      }
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });
}
