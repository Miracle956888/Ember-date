/**
 * call.js — native WebRTC one-to-one audio/video calling.
 *
 * The server is signalling only: it relays SDP and ICE and writes call_logs.
 * Media flows peer-to-peer (STUN, plus TURN when one is configured).
 *
 * Roles
 *   caller  -> POST call:invite, wait for call:accepted, create the offer
 *   callee  -> arrive from a call:incoming notification, accept, answer
 *
 * States: idle -> ringing -> connecting -> connected -> ended
 */
import { api } from './api.js';
import * as socket from './socket.js';
import { $, formatDuration, avatarSrc, attachAvatarFallback, prefersReducedMotion } from './ui.js';

const RING_TIMEOUT_MS = 35_000;

let peer = null;
let conversationId = null;
let mode = 'video';
let role = 'caller';

let callId = null;
let pc = null;
let localStream = null;
let remoteStream = null;
let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];

let state = 'idle';
let connectedAt = null;
let timerInterval = null;
let statsInterval = null;
let ringTimer = null;
let ringtone = null;

/** ICE candidates that arrive before the remote description is set. */
const pendingCandidates = [];
let remoteDescriptionSet = false;
let iceRestartAttempts = 0;
const unsubscribers = [];

// --------------------------------------------------------------- UI helpers

function setState(next) {
  state = next;
  document.body.dataset.callState = next;

  const label = {
    idle: 'Starting…',
    ringing: role === 'caller' ? 'Ringing…' : 'Incoming call',
    connecting: 'Connecting…',
    connected: 'Connected',
    ended: 'Call ended'
  }[next] || '';

  const status = $('#call-status');
  if (status) status.textContent = label;

  $('#ringing-actions')?.classList.toggle('hidden', !(next === 'ringing' && role === 'callee'));
  $('#active-actions')?.classList.toggle('hidden', next === 'ringing' && role === 'callee');
  $('#call-timer')?.classList.toggle('hidden', next !== 'connected');
  $('#quality')?.classList.toggle('hidden', next !== 'connected');

  const announcer = $('#call-announcer');
  if (announcer) announcer.textContent = label;
}

function paintPeer() {
  if (!peer) return;
  const avatar = $('#peer-avatar');
  if (avatar) {
    avatar.src = avatarSrc(peer);
    attachAvatarFallback(avatar, peer);
  }
  $('#peer-name').textContent = peer.displayName || 'Unknown';
  document.title = `${peer.displayName || 'Call'} — Ember`;
}

function startTimer() {
  connectedAt = Date.now();
  const node = $('#call-timer');
  const paint = () => {
    node.textContent = formatDuration(Math.floor((Date.now() - connectedAt) / 1000));
  };
  paint();
  timerInterval = setInterval(paint, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

/** A short WebAudio ring — no asset to ship, and it respects an early hangup. */
function startRingtone() {
  if (prefersReducedMotion()) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(ctx.destination);

    const beep = () => {
      if (!ringtone) return;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = role === 'caller' ? 440 : 620;
      osc.connect(gain);
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
      osc.start(now);
      osc.stop(now + 0.75);
    };

    ringtone = { ctx, interval: setInterval(beep, 2400) };
    beep();
  } catch {
    /* audio is a nicety, never a blocker */
  }
}

function stopRingtone() {
  if (!ringtone) return;
  clearInterval(ringtone.interval);
  ringtone.ctx.close().catch(() => {});
  ringtone = null;
}

// ------------------------------------------------------------------- media

async function getLocalMedia() {
  const constraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video:
      mode === 'video'
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
        : false
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Permission denied, no device, or the device is held by another app.
    const reason =
      err.name === 'NotAllowedError'
        ? `Ember needs permission to use your ${mode === 'video' ? 'camera and microphone' : 'microphone'}. Allow it in your browser's address bar, then try again.`
        : err.name === 'NotFoundError'
          ? `No ${mode === 'video' ? 'camera or microphone' : 'microphone'} was found on this device.`
          : err.name === 'NotReadableError'
            ? 'Your camera or microphone is already in use by another app.'
            : 'Could not access your camera or microphone.';
    showFatal('Device unavailable', reason);
    throw err;
  }

  const local = $('#local-video');
  local.srcObject = localStream;
  local.muted = true;
  await local.play().catch(() => {});
  $('#local-tile').classList.toggle('hidden', mode !== 'video');
  return localStream;
}

// ---------------------------------------------------------- peer connection

function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });

  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  remoteStream = new MediaStream();
  $('#remote-video').srcObject = remoteStream;

  pc.ontrack = (event) => {
    for (const track of event.streams[0]?.getTracks() || [event.track]) {
      if (!remoteStream.getTracks().includes(track)) remoteStream.addTrack(track);
    }
    $('#remote-video').play().catch(() => {});
    $('#remote-placeholder').classList.add('hidden');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && callId) {
      socket.emit('call:ice-candidate', { callId, candidate: event.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      iceRestartAttempts = 0;
      if (state !== 'connected') {
        setState('connected');
        startTimer();
        startStatsLoop();
      }
    }
    if (pc.connectionState === 'failed') attemptIceRestart();
    if (pc.connectionState === 'disconnected') {
      setQuality('poor', 'Reconnecting…');
      // Give ICE a moment to recover on its own before forcing a restart.
      setTimeout(() => {
        if (pc && pc.connectionState === 'disconnected') attemptIceRestart();
      }, 4000);
    }
  };

  return pc;
}

/** One renegotiation attempt with fresh ICE before we give up on the call. */
async function attemptIceRestart() {
  if (!pc || role !== 'caller' || iceRestartAttempts >= 2) {
    if (state !== 'ended') endCall('failed', 'The connection dropped.');
    return;
  }
  iceRestartAttempts += 1;
  setQuality('poor', 'Reconnecting…');
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit('call:offer', { callId, sdp: pc.localDescription });
  } catch {
    endCall('failed', 'The connection dropped.');
  }
}

async function flushPendingCandidates() {
  while (pendingCandidates.length) {
    const candidate = pendingCandidates.shift();
    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }
}

// ------------------------------------------------------------------ quality

function setQuality(level, text) {
  const dot = $('#quality-dot');
  const label = $('#quality-text');
  if (!dot) return;
  dot.dataset.level = level;
  if (label) label.textContent = text;
}

/** Sample getStats once a second and turn packet loss / RTT into a dot. */
function startStatsLoop() {
  let lastLost = 0;
  let lastReceived = 0;

  statsInterval = setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') return;
    try {
      const stats = await pc.getStats();
      let lost = 0;
      let received = 0;
      let rtt = 0;

      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && !report.isRemote) {
          lost += report.packetsLost || 0;
          received += report.packetsReceived || 0;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
          rtt = Math.max(rtt, report.currentRoundTripTime * 1000);
        }
      });

      const deltaLost = Math.max(0, lost - lastLost);
      const deltaReceived = Math.max(0, received - lastReceived);
      lastLost = lost;
      lastReceived = received;

      const lossPct = deltaReceived + deltaLost > 0 ? (deltaLost / (deltaLost + deltaReceived)) * 100 : 0;

      if (lossPct > 8 || rtt > 400) setQuality('poor', 'Weak connection');
      else if (lossPct > 3 || rtt > 200) setQuality('fair', 'Fair connection');
      else setQuality('good', rtt ? `${Math.round(rtt)} ms` : 'Good connection');
    } catch {
      /* stats are advisory */
    }
  }, 1000);
}

function stopStatsLoop() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = null;
}

// ------------------------------------------------------------- call control

async function placeCall() {
  setState('ringing');
  startRingtone();

  const ack = await socket.emitAck('call:invite', { conversationId });
  if (!ack?.ok) {
    stopRingtone();
    showFatal(
      ack?.reason === 'busy' ? 'They are on another call' : 'Call not connected',
      ack?.error || 'Could not start the call.'
    );
    return;
  }
  callId = ack.callId;

  ringTimer = setTimeout(() => {
    if (state === 'ringing') endCall('timeout', 'No answer.');
  }, RING_TIMEOUT_MS + 1500);
}

/** Callee path: the invite already exists, we just accept it. */
async function answerCall() {
  clearTimeout(ringTimer);
  stopRingtone();
  setState('connecting');

  const ack = await socket.emitAck('call:accept', { callId });
  if (!ack?.ok) {
    showFatal('Call unavailable', ack?.error || 'That call is no longer available.');
    return;
  }
  createPeerConnection(); // the caller now sends us an offer
}

async function declineCall() {
  stopRingtone();
  clearTimeout(ringTimer);
  if (callId) await socket.emitAck('call:decline', { callId }).catch(() => {});
  teardown();
  goBack();
}

/** Local hangup, or a terminal remote event. */
async function endCall(reason = 'hangup', message = '') {
  if (state === 'ended') return;
  const wasConnected = state === 'connected';
  const duration = connectedAt ? Math.floor((Date.now() - connectedAt) / 1000) : 0;

  setState('ended');
  stopRingtone();
  stopTimer();
  stopStatsLoop();
  clearTimeout(ringTimer);

  if (callId && reason === 'hangup') {
    await socket.emitAck('call:end', { callId }).catch(() => {});
  } else if (callId && reason === 'failed') {
    socket.emit('call:failed', { callId });
  }

  teardown();
  showEnded(reason, message, wasConnected ? duration : null);
}

function teardown() {
  for (const unsub of unsubscribers.splice(0)) unsub();
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  for (const track of localStream?.getTracks() || []) track.stop();
  localStream = null;
  remoteStream = null;
}

function goBack() {
  location.href = conversationId ? `/chat?c=${conversationId}` : '/matches';
}

// ------------------------------------------------------------- end / errors

function showEnded(reason, message, durationSecs) {
  const reasons = {
    hangup: 'Call ended',
    declined: 'Call declined',
    timeout: 'No answer',
    offline: 'They are offline',
    busy: 'They are on another call',
    failed: 'Connection lost',
    'peer-disconnected': 'They lost connection'
  };

  $('#call-overlay').classList.remove('hidden');
  $('#overlay-title').textContent = reasons[reason] || 'Call ended';
  $('#overlay-message').textContent =
    message || (durationSecs !== null ? `Duration ${formatDuration(durationSecs)}` : '');
  $('#overlay-again').classList.toggle('hidden', reason === 'offline' || reason === 'busy');
}

function showFatal(title, message) {
  setState('ended');
  stopRingtone();
  teardown();
  $('#call-overlay').classList.remove('hidden');
  $('#overlay-title').textContent = title;
  $('#overlay-message').textContent = message;
  $('#overlay-again').classList.add('hidden');
}

// -------------------------------------------------------------- init

export async function initCall() {
  const params = new URLSearchParams(location.search);
  conversationId = Number(params.get('c'));
  mode = params.get('mode') === 'audio' ? 'audio' : 'video';
  role = params.get('role') === 'callee' ? 'callee' : 'caller';
  callId = params.get('callId') || null;

  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    location.replace('/matches');
    return;
  }
  if (role === 'callee' && !callId) {
    showFatal('Call unavailable', 'That call is no longer ringing.');
    return;
  }

  document.body.dataset.callMode = mode;
  $('#mode-label').textContent = mode === 'video' ? 'Video call' : 'Voice call';
  $('#toggle-camera').classList.toggle('hidden', mode !== 'video');

  // Peer identity + ICE configuration, in parallel.
  try {
    const [conv, ice] = await Promise.all([api.conversation(conversationId), api.iceServers()]);
    peer = conv.peer;
    if (ice?.iceServers?.length) iceServers = ice.iceServers;
    paintPeer();
  } catch {
    showFatal('Call unavailable', 'That conversation is not available.');
    return;
  }

  // ---- signalling listeners (registered before we invite, so nothing races)
  unsubscribers.push(
    socket.on('call:accepted', async ({ callId: id }) => {
      if (id !== callId) return;
      stopRingtone();
      clearTimeout(ringTimer);
      setState('connecting');
      try {
        createPeerConnection();
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: mode === 'video'
        });
        await pc.setLocalDescription(offer);
        socket.emit('call:offer', { callId, sdp: pc.localDescription });
      } catch {
        endCall('failed', 'Could not negotiate the connection.');
      }
    }),

    socket.on('call:offer', async ({ callId: id, sdp }) => {
      if (id !== callId) return;
      try {
        if (!pc) createPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        remoteDescriptionSet = true;
        await flushPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call:answer', { callId, sdp: pc.localDescription });
      } catch {
        endCall('failed', 'Could not negotiate the connection.');
      }
    }),

    socket.on('call:answer', async ({ callId: id, sdp }) => {
      if (id !== callId || !pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        remoteDescriptionSet = true;
        await flushPendingCandidates();
      } catch {
        endCall('failed', 'Could not negotiate the connection.');
      }
    }),

    socket.on('call:ice-candidate', async ({ callId: id, candidate }) => {
      if (id !== callId || !candidate) return;
      if (!pc || !remoteDescriptionSet) {
        pendingCandidates.push(candidate);
        return;
      }
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    }),

    socket.on('call:declined', ({ callId: id }) => {
      if (id !== callId) return;
      endCall('declined', `${peer.displayName} declined the call.`);
    }),

    socket.on('call:ended', ({ callId: id, reason, message, durationSecs }) => {
      if (id && callId && id !== callId) return;
      if (state === 'ended') return;
      stopRingtone();
      stopTimer();
      stopStatsLoop();
      setState('ended');
      teardown();
      showEnded(reason || 'hangup', message || '', durationSecs ?? null);
    }),

    socket.on('connection:state', ({ connected }) => {
      if (!connected && state !== 'ended') setQuality('poor', 'Signalling lost');
    })
  );

  // ---- controls
  $('#hangup').addEventListener('click', () => endCall('hangup'));
  $('#decline').addEventListener('click', declineCall);
  $('#accept').addEventListener('click', async () => {
    try {
      await getLocalMedia();
      await answerCall();
    } catch {
      if (callId) socket.emit('call:decline', { callId });
    }
  });

  $('#toggle-mic').addEventListener('click', (e) => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const btn = e.currentTarget;
    btn.dataset.off = String(!track.enabled);
    btn.setAttribute('aria-pressed', String(!track.enabled));
    btn.setAttribute('aria-label', track.enabled ? 'Mute microphone' : 'Unmute microphone');
    $('#muted-badge').classList.toggle('hidden', track.enabled);
  });

  $('#toggle-camera').addEventListener('click', (e) => {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const btn = e.currentTarget;
    btn.dataset.off = String(!track.enabled);
    btn.setAttribute('aria-pressed', String(!track.enabled));
    btn.setAttribute('aria-label', track.enabled ? 'Turn camera off' : 'Turn camera on');
    $('#local-tile').classList.toggle('opacity-40', !track.enabled);
  });

  $('#overlay-back').addEventListener('click', goBack);
  $('#overlay-again').addEventListener('click', () => {
    location.href = `/call?c=${conversationId}&role=caller&mode=${mode}`;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state !== 'ended') endCall('hangup');
    if (e.key.toLowerCase() === 'm' && state === 'connected') $('#toggle-mic').click();
  });

  window.addEventListener('beforeunload', () => {
    if (state !== 'ended' && callId) socket.emit('call:end', { callId });
    for (const track of localStream?.getTracks() || []) track.stop();
  });

  // ---- go
  if (role === 'caller') {
    try {
      await getLocalMedia();
    } catch {
      return; // showFatal already explained why
    }
    await placeCall();
  } else {
    setState('ringing');
    startRingtone();
    ringTimer = setTimeout(() => {
      if (state === 'ringing') endCall('timeout', 'You missed the call.');
    }, RING_TIMEOUT_MS);
  }
}
