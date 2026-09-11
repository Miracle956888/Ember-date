/**
 * Socket.IO client singleton.
 *
 * The handshake carries the httpOnly auth cookie automatically because we
 * connect to the same origin - no token is ever exposed to JS.
 */
import { toast } from './ui.js';

let socket = null;
let connectPromise = null;
const listeners = new Map();

/** Server clock offset (serverTime - clientTime) so countdowns stay honest. */
export let clockSkewMs = 0;

export function setClockSkew(serverTimeIso) {
  if (!serverTimeIso) return;
  clockSkewMs = new Date(serverTimeIso).getTime() - Date.now();
}

function bindCoreEvents(s) {
  s.on('ready', (payload) => {
    setClockSkew(payload?.serverTime);
    emitLocal('ready', payload);
  });

  s.on('connect', () => emitLocal('connection:state', { connected: true }));

  s.on('disconnect', (reason) => {
    emitLocal('connection:state', { connected: false, reason });
  });

  s.io.on('reconnect', () => {
    emitLocal('connection:state', { connected: true, reconnected: true });
  });

  s.on('connect_error', (err) => {
    emitLocal('connection:state', { connected: false, error: err.message });
    if (/auth|unauthor|jwt|token/i.test(err.message)) {
      // Session is gone - bounce to login rather than retrying forever.
      s.close();
      const next = encodeURIComponent(location.pathname + location.search);
      location.replace(`/login?next=${next}`);
    }
  });

  s.on('error', (payload) => {
    if (payload?.message) toast(payload.message, { type: 'error' });
  });

  s.on('server:shutdown', () => {
    toast('Server is restarting…', { type: 'info' });
  });

  // Re-broadcast every server event to local subscribers.
  s.onAny((event, ...args) => emitLocal(event, ...args));
}

/**
 * The Socket.IO server serves its own matching client build at
 * /socket.io/socket.io.esm.min.js. Importing it from the same origin keeps the
 * strict CSP (`script-src 'self'`) intact and guarantees the client and server
 * versions can never drift apart.
 */
async function loadIo() {
  if (typeof window.io === 'function') return window.io;
  const mod = await import('/socket.io/socket.io.esm.min.js');
  return mod.io || mod.default;
}

export function connectSocket() {
  if (socket) return connectPromise;

  connectPromise = new Promise((resolve, reject) => {
    loadIo().then((io) => {
      if (typeof io !== 'function') {
        reject(new Error('Socket.IO client failed to load.'));
        return;
      }
      socket = io({
        withCredentials: true,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 600,
        reconnectionDelayMax: 6000,
        timeout: 10000
      });

      bindCoreEvents(socket);
      socket.once('ready', (payload) => resolve(payload));
      socket.once('connect_error', (err) => reject(err));
    }).catch(reject);
  });

  return connectPromise;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.close();
    socket = null;
    connectPromise = null;
  }
}

// --------------------------------------------------- local pub/sub wrapper
function emitLocal(event, ...args) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(...args);
    } catch (err) {
      console.error(`listener for ${event} threw`, err);
    }
  }
}

/** Subscribe to a socket (or synthetic) event. Returns an unsubscribe fn. */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function off(event, handler) {
  listeners.get(event)?.delete(handler);
}

/** Fire-and-forget emit. */
export function emit(event, payload) {
  socket?.emit(event, payload);
}

/** Emit expecting an ack, with a timeout so the UI never hangs. */
export function emitAck(event, payload, timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      reject(new Error('You are offline.'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The server took too long to respond.'));
    }, timeout);

    socket.emit(event, payload, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (response && response.ok === false) reject(new Error(response.error || 'Request failed.'));
      else resolve(response);
    });
  });
}

export const isConnected = () => Boolean(socket?.connected);
