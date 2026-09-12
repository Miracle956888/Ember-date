/**
 * Realtime smoke test: two authenticated sockets exchange a message, typing
 * indicator, read receipt and a full WebRTC signalling handshake.
 * Run with the server already listening:  node scripts/smoke-socket.js
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3000';
// Defaults are the seeded development accounts, because that is the only place
// this has ever been run. Against a real host, point it at two accounts that
// share a conversation:
//   BASE=https://your.host SMOKE_PASSWORD=... SMOKE_EMAIL_A=... SMOKE_EMAIL_B=... \
//   SMOKE_CONVERSATION=12 node scripts/smoke-socket.js
// The password is an environment variable rather than a literal, so nothing that
// looks like a credential is committed to the repository.
const CONV = Number(process.env.SMOKE_CONVERSATION || 3);
const EMAIL_A = process.env.SMOKE_EMAIL_A || 'amara@example.com';
const EMAIL_B = process.env.SMOKE_EMAIL_B || 'kelechi@example.com';
const EMAIL_C = process.env.SMOKE_EMAIL_C || 'zainab@example.com';
const PASSWORD = process.env.SMOKE_PASSWORD || 'Password123!';

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD })
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const body = await res.json();
  return { cookies, user: body.user };
}

function connect(cookies) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      transports: ['websocket'],
      extraHeaders: { Cookie: cookies }
    });
    socket.on('ready', (payload) => resolve({ socket, ready: payload }));
    socket.on('connect_error', (err) => reject(new Error(`connect_error: ${err.message}`)));
    setTimeout(() => reject(new Error('socket timeout')), 8000);
  });
}

const waitFor = (socket, event, timeout = 8000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

async function main() {
  const amara = await login(EMAIL_A);
  const kelechi = await login(EMAIL_B);

  const a = await connect(amara.cookies);
  const k = await connect(kelechi.cookies);
  check('both sockets authenticate via httpOnly cookie', Boolean(a.ready && k.ready));

  // --- unauthenticated socket must be rejected
  const anon = io(BASE, { transports: ['websocket'], reconnection: false });
  const anonRejected = await new Promise((resolve) => {
    anon.on('connect_error', () => resolve(true));
    anon.on('ready', () => resolve(false));
    setTimeout(() => resolve(false), 5000);
  });
  anon.close();
  check('unauthenticated socket rejected by io.use()', anonRejected);

  // --- join
  const joinA = await a.socket.emitWithAck('chat:join', { conversationId: CONV });
  const joinK = await k.socket.emitWithAck('chat:join', { conversationId: CONV });
  check('both join conversation', joinA.ok && joinK.ok, `history=${joinA.messages.length}`);

  // --- non-participant cannot join
  const zainab = await login(EMAIL_C);
  const z = await connect(zainab.cookies);
  const joinZ = await z.socket.emitWithAck('chat:join', { conversationId: CONV });
  check('non-participant refused', joinZ.ok === false);
  z.socket.close();

  // --- message delivery latency
  const inbound = waitFor(k.socket, 'chat:message');
  const t0 = Date.now();
  const ack = await a.socket.emitWithAck('chat:message', {
    conversationId: CONV,
    body: 'Hello over websocket!',
    clientUuid: crypto.randomUUID()
  });
  const received = await inbound;
  const latency = Date.now() - t0;
  check('message delivered to peer', ack.ok && received.body === 'Hello over websocket!', `${latency}ms`);
  check('latency under 300ms', latency < 300, `${latency}ms`);
  check('expires_at is 24h out', (() => {
    const delta = new Date(received.expiresAt) - new Date(received.createdAt);
    return Math.abs(delta - 24 * 3600 * 1000) < 60_000;
  })());

  // --- typing
  const typingSeen = waitFor(k.socket, 'chat:typing');
  a.socket.emit('chat:typing', { conversationId: CONV, isTyping: true });
  const typing = await typingSeen;
  check('typing relayed to peer only', typing.userId === amara.user.id && typing.isTyping === true);

  // --- read receipt
  const readSeen = waitFor(a.socket, 'chat:read');
  await k.socket.emitWithAck('chat:read', { conversationId: CONV });
  const read = await readSeen;
  check('read receipt broadcast', read.readerId === kelechi.user.id);

  // --- rate limit: 20 msgs / 10s
  let limited = false;
  for (let i = 0; i < 26; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await a.socket.emitWithAck('chat:message', {
      conversationId: CONV,
      body: `flood ${i}`,
      clientUuid: crypto.randomUUID()
    });
    if (!r.ok) {
      limited = true;
      break;
    }
  }
  check('socket rate limit (20/10s) enforced', limited);

  // --- WebRTC signalling handshake
  const incoming = waitFor(k.socket, 'call:incoming');
  const inviteAck = await a.socket.emitWithAck('call:invite', { conversationId: CONV });
  const ring = await incoming;
  check('call invite rings callee', inviteAck.ok && ring.callId === inviteAck.callId, `from ${ring.from.displayName}`);

  const acceptedSeen = waitFor(a.socket, 'call:accepted');
  await k.socket.emitWithAck('call:accept', { callId: ring.callId });
  await acceptedSeen;
  check('callee accept reaches caller', true);

  const offerSeen = waitFor(k.socket, 'call:offer');
  a.socket.emit('call:offer', { callId: ring.callId, sdp: { type: 'offer', sdp: 'v=0 fake' } });
  const offer = await offerSeen;
  check('SDP offer relayed', offer.sdp.type === 'offer');

  const answerSeen = waitFor(a.socket, 'call:answer');
  k.socket.emit('call:answer', { callId: ring.callId, sdp: { type: 'answer', sdp: 'v=0 fake' } });
  const answer = await answerSeen;
  check('SDP answer relayed', answer.sdp.type === 'answer');

  const iceSeen = waitFor(k.socket, 'call:ice-candidate');
  a.socket.emit('call:ice-candidate', { callId: ring.callId, candidate: { candidate: 'candidate:1 fake' } });
  await iceSeen;
  check('ICE candidate relayed', true);

  const endedSeen = waitFor(k.socket, 'call:ended');
  const endAck = await a.socket.emitWithAck('call:end', { callId: ring.callId });
  const ended = await endedSeen;
  check('hangup ends both sides + logs duration', endAck.ok && ended.reason === 'hangup');

  // --- busy signal
  const inv2 = await a.socket.emitWithAck('call:invite', { conversationId: CONV });
  const inv3 = await a.socket.emitWithAck('call:invite', { conversationId: CONV });
  check('second concurrent call reports busy', inv2.ok && inv3.ok === false, inv3.error || '');
  await a.socket.emitWithAck('call:end', { callId: inv2.callId });

  a.socket.close();
  k.socket.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('SMOKE TEST ERROR:', err.message);
  process.exit(1);
});
