/**
 * WebRTC signalling over Socket.IO. The server never touches media - it only
 * relays SDP/ICE between the two participants and records call metadata.
 */
import crypto from 'node:crypto';
import { execute, queryOne } from '../db/pool.js';
import { assertParticipant } from '../services/match.service.js';
import { isUserOnline } from './index.js';
import { logger } from '../utils/logger.js';

const log = logger.child('call');

/** callId -> { conversationId, callerId, calleeId, logId, state, startedAt, timer } */
const activeCalls = new Map();
/** userId -> callId, so we can answer "busy". */
const userBusy = new Map();

const RING_TIMEOUT_MS = 35_000;

function isBusy(userId) {
  return userBusy.has(Number(userId));
}

async function logCall(conversationId, callerId, calleeId, status) {
  const res = await execute(
    'INSERT INTO call_logs (conversation_id, caller_id, callee_id, status, started_at) VALUES (?,?,?,?,NOW())',
    [conversationId, callerId, calleeId, status]
  );
  return Number(res.insertId);
}

async function finalizeCall(logId, status, startedAt) {
  const durationSecs = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
  await execute('UPDATE call_logs SET status = ?, ended_at = NOW(), duration_secs = ? WHERE id = ?', [
    status,
    durationSecs,
    logId
  ]).catch((err) => log.warn('failed to finalize call log', { logId, error: err.message }));
  return durationSecs;
}

function clearCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) return null;
  if (call.timer) clearTimeout(call.timer);
  activeCalls.delete(callId);
  userBusy.delete(Number(call.callerId));
  userBusy.delete(Number(call.calleeId));
  return call;
}

/** Only the two parties of a call may signal on it. */
function getCallForUser(callId, userId) {
  const call = activeCalls.get(callId);
  if (!call) return null;
  const uid = Number(userId);
  if (Number(call.callerId) !== uid && Number(call.calleeId) !== uid) return null;
  return call;
}

export function registerCallHandlers(io, socket) {
  const user = socket.data.user;

  socket.on('call:invite', async (payload, ack) => {
    try {
      const conversationId = Number(payload?.conversationId);
      const part = await assertParticipant(conversationId, user.id);
      const calleeId = part.otherUserId;

      if (isBusy(user.id)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'You are already on a call.' });
        return;
      }

      const callId = crypto.randomUUID();

      // Callee offline -> log as missed straight away.
      if (!isUserOnline(calleeId)) {
        const logId = await logCall(conversationId, user.id, calleeId, 'missed');
        await finalizeCall(logId, 'missed', null);
        socket.emit('call:ended', { callId, reason: 'offline', message: 'They are not online right now.' });
        if (typeof ack === 'function') ack({ ok: false, error: 'They are not online right now.', reason: 'offline' });
        return;
      }

      // Callee already on another call -> busy.
      if (isBusy(calleeId)) {
        const logId = await logCall(conversationId, user.id, calleeId, 'missed');
        await finalizeCall(logId, 'missed', null);
        socket.emit('call:ended', { callId, reason: 'busy', message: 'They are on another call.' });
        if (typeof ack === 'function') ack({ ok: false, error: 'They are on another call.', reason: 'busy' });
        return;
      }

      const logId = await logCall(conversationId, user.id, calleeId, 'missed'); // upgraded on accept
      const call = {
        callId,
        conversationId,
        callerId: user.id,
        calleeId,
        logId,
        state: 'ringing',
        startedAt: null,
        connectedAt: null,
        timer: null
      };

      call.timer = setTimeout(async () => {
        const stale = activeCalls.get(callId);
        if (!stale || stale.state !== 'ringing') return;
        clearCall(callId);
        await finalizeCall(logId, 'missed', null);
        io.to(`user:${call.callerId}`).emit('call:ended', { callId, reason: 'timeout', message: 'No answer.' });
        io.to(`user:${call.calleeId}`).emit('call:ended', { callId, reason: 'timeout' });
      }, RING_TIMEOUT_MS);

      activeCalls.set(callId, call);
      userBusy.set(Number(user.id), callId);
      userBusy.set(Number(calleeId), callId);

      const caller = await queryOne('SELECT id, display_name, avatar_url FROM users WHERE id = ? LIMIT 1', [user.id]);

      io.to(`user:${calleeId}`).emit('call:incoming', {
        callId,
        conversationId,
        from: {
          id: Number(caller.id),
          displayName: caller.display_name,
          avatarUrl: caller.avatar_url
        }
      });

      log.info('invite', { callId, callerId: user.id, calleeId });
      if (typeof ack === 'function') ack({ ok: true, callId, calleeId });
    } catch (err) {
      log.warn('invite failed', { userId: user.id, error: err.message });
      if (typeof ack === 'function') ack({ ok: false, error: 'Could not start the call.' });
    }
  });

  socket.on('call:accept', async (payload, ack) => {
    try {
      const callId = String(payload?.callId || '');
      const call = getCallForUser(callId, user.id);
      if (!call || Number(call.calleeId) !== Number(user.id)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'That call is no longer available.' });
        return;
      }
      if (call.timer) clearTimeout(call.timer);
      call.state = 'accepted';
      call.startedAt = Date.now();

      await execute("UPDATE call_logs SET status = 'completed' WHERE id = ?", [call.logId]).catch(() => {});

      // Caller now creates the offer.
      io.to(`user:${call.callerId}`).emit('call:accepted', { callId, by: Number(user.id) });
      if (typeof ack === 'function') ack({ ok: true, callId });
      log.info('accepted', { callId });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('call:decline', async (payload, ack) => {
    try {
      const callId = String(payload?.callId || '');
      const call = getCallForUser(callId, user.id);
      if (!call) {
        if (typeof ack === 'function') ack({ ok: false, error: 'That call is no longer available.' });
        return;
      }
      clearCall(callId);
      await finalizeCall(call.logId, 'declined', null);
      io.to(`user:${call.callerId}`).emit('call:declined', { callId, by: Number(user.id) });
      io.to(`user:${call.calleeId}`).emit('call:ended', { callId, reason: 'declined' });
      if (typeof ack === 'function') ack({ ok: true });
      log.info('declined', { callId });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // ---- pure signalling relays -------------------------------------------

  socket.on('call:offer', (payload) => {
    const callId = String(payload?.callId || '');
    const call = getCallForUser(callId, user.id);
    if (!call) return;
    const target = Number(call.callerId) === Number(user.id) ? call.calleeId : call.callerId;
    io.to(`user:${target}`).emit('call:offer', { callId, sdp: payload.sdp, from: Number(user.id) });
  });

  socket.on('call:answer', (payload) => {
    const callId = String(payload?.callId || '');
    const call = getCallForUser(callId, user.id);
    if (!call) return;
    const target = Number(call.callerId) === Number(user.id) ? call.calleeId : call.callerId;
    io.to(`user:${target}`).emit('call:answer', { callId, sdp: payload.sdp, from: Number(user.id) });
  });

  socket.on('call:ice-candidate', (payload) => {
    const callId = String(payload?.callId || '');
    const call = getCallForUser(callId, user.id);
    if (!call) return;
    const target = Number(call.callerId) === Number(user.id) ? call.calleeId : call.callerId;
    io.to(`user:${target}`).emit('call:ice-candidate', {
      callId,
      candidate: payload.candidate,
      from: Number(user.id)
    });
  });

  socket.on('call:end', async (payload, ack) => {
    try {
      const callId = String(payload?.callId || '');
      const call = getCallForUser(callId, user.id);
      if (!call) {
        if (typeof ack === 'function') ack({ ok: true });
        return;
      }
      const wasConnected = call.state === 'accepted';
      clearCall(callId);
      const duration = await finalizeCall(call.logId, wasConnected ? 'completed' : 'missed', call.startedAt);

      const payloadOut = { callId, reason: 'hangup', endedBy: Number(user.id), durationSecs: duration };
      io.to(`user:${call.callerId}`).emit('call:ended', payloadOut);
      io.to(`user:${call.calleeId}`).emit('call:ended', payloadOut);
      if (typeof ack === 'function') ack({ ok: true, durationSecs: duration });
      log.info('ended', { callId, durationSecs: duration, wasConnected });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('call:failed', async (payload) => {
    const callId = String(payload?.callId || '');
    const call = getCallForUser(callId, user.id);
    if (!call) return;
    clearCall(callId);
    await finalizeCall(call.logId, 'failed', call.startedAt);
    io.to(`user:${call.callerId}`).emit('call:ended', { callId, reason: 'failed' });
    io.to(`user:${call.calleeId}`).emit('call:ended', { callId, reason: 'failed' });
  });

  /** A dropped socket must not leave the peer ringing forever. */
  socket.on('disconnect', async () => {
    const callId = userBusy.get(Number(user.id));
    if (!callId) return;
    const call = activeCalls.get(callId);
    if (!call) return;
    // Another tab of the same user may still hold the call.
    if (isUserOnline(user.id)) return;

    const wasConnected = call.state === 'accepted';
    clearCall(callId);
    await finalizeCall(call.logId, wasConnected ? 'completed' : 'missed', call.startedAt);
    const other = Number(call.callerId) === Number(user.id) ? call.calleeId : call.callerId;
    io.to(`user:${other}`).emit('call:ended', { callId, reason: 'peer-disconnected' });
    log.info('ended by disconnect', { callId });
  });
}
