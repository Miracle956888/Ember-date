import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { socketAuth } from '../middleware/auth.js';
import { markOnline, markOffline } from '../services/auth.service.js';
import { listMatches } from '../services/match.service.js';
import { registerChatHandlers } from './chat.handler.js';
import { registerCallHandlers } from './call.handler.js';
import { setCleanupBroadcaster } from '../jobs/cleanup.js';
import { setNotificationBroadcaster } from '../services/notification.service.js';
import { logger } from '../utils/logger.js';

const log = logger.child('socket');

let io = null;

/** Live socket count per user id, so multi-tab presence is accurate. */
const userSockets = new Map();

export function getIo() {
  return io;
}

export function isUserOnline(userId) {
  return userSockets.has(Number(userId));
}

function addSocket(userId, socketId) {
  const id = Number(userId);
  if (!userSockets.has(id)) userSockets.set(id, new Set());
  userSockets.get(id).add(socketId);
  return userSockets.get(id).size;
}

function removeSocket(userId, socketId) {
  const id = Number(userId);
  const set = userSockets.get(id);
  if (!set) return 0;
  set.delete(socketId);
  if (!set.size) userSockets.delete(id);
  return set.size;
}

/** Tell everyone this user is matched with about a presence change. */
async function broadcastPresence(userId, isOnline) {
  try {
    const matches = await listMatches(userId);
    const payload = {
      userId: Number(userId),
      isOnline,
      lastSeenAt: new Date().toISOString()
    };
    for (const m of matches) {
      io.to(`user:${m.user.id}`).emit('presence:update', payload);
    }
  } catch (err) {
    log.warn('presence broadcast failed', { userId, error: err.message });
  }
}

export function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: [env.APP_ORIGIN, ...env.EXTRA_ORIGINS],
      credentials: true
    },
    path: '/socket.io',
    serveClient: true,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e6,
    transports: ['websocket', 'polling']
  });

  io.use(socketAuth);

  io.on('connection', async (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);
    const count = addSocket(user.id, socket.id);
    socket.data.conversations = new Set();

    log.debug('connected', { userId: user.id, socketId: socket.id, sockets: count });

    if (count === 1) {
      await markOnline(user.id).catch((e) => log.warn('markOnline failed', { error: e.message }));
      broadcastPresence(user.id, true);
    }

    socket.emit('ready', {
      userId: user.id,
      displayName: user.displayName,
      serverTime: new Date().toISOString(),
      messageTtlHours: env.MESSAGE_TTL_HOURS
    });

    registerChatHandlers(io, socket);
    registerCallHandlers(io, socket);

    socket.on('presence:ping', () => {
      socket.emit('presence:pong', { serverTime: new Date().toISOString() });
    });

    socket.on('disconnect', async (reason) => {
      const remaining = removeSocket(user.id, socket.id);
      log.debug('disconnected', { userId: user.id, reason, remaining });
      if (remaining === 0) {
        await markOffline(user.id).catch((e) => log.warn('markOffline failed', { error: e.message }));
        broadcastPresence(user.id, false);
      }
    });

    socket.on('error', (err) => {
      log.warn('socket error', { userId: user.id, error: err?.message });
    });
  });

  // LAYER 3 -> LAYER 4 bridge: when the cleanup job destroys rows, push the ids
  // so any open thread removes those bubbles immediately.
  setCleanupBroadcaster((conversationId, messageIds) => {
    io.to(`conv:${conversationId}`).emit('chat:message:expired', { conversationId, messageIds });
  });

  // Live notification badge. Only the unread count and the kind travel over
  // the wire -- never the notification body -- so nothing sensitive is pushed
  // to a stale tab, and the client fetches the detail when the panel opens.
  setNotificationBroadcaster((userId, payload) => {
    io.to(`user:${userId}`).emit('notification:new', payload);
  });

  log.info('socket.io ready');
  return io;
}

/** Graceful shutdown: ask clients to reconnect elsewhere, then close. */
export async function closeSockets() {
  if (!io) return;
  io.emit('server:shutdown', { message: 'Server is restarting.' });
  await new Promise((resolve) => {
    io.close(() => resolve());
    setTimeout(resolve, 3000);
  });
  io = null;
  userSockets.clear();
  log.info('socket.io closed');
}
