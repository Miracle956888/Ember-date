/**
 * chat.js — one-to-one ephemeral chat.
 *
 * Ephemerality layer 4 lives here:
 *   - every bubble carries a live countdown chip (amber < 1h, red < 10m)
 *   - a message removes itself from the DOM with a fade the moment it expires
 *   - a persistent banner states the rule
 *   - "Clear chat" soft-deletes the thread for both people
 *
 * Sending is optimistic and idempotent: each message carries a clientUuid so a
 * retry over a flaky socket can never duplicate a row.
 */
import { api, ApiError } from './api.js';
import * as socket from './socket.js';
import {
  $, $$, el, escapeHtml, toast, openModal, confirmDialog, clockTime, timeAgo,
  formatRemaining, avatarSrc, attachAvatarFallback, prefersReducedMotion, formatBytes, html
} from './ui.js';
import { emptyState } from './app-shell.js';
import { formatDayLabel } from './i18n.js';
import { mapPreviewSvg, mapLink, getPosition, startLiveShare } from './geo.js';
import { ConversationCrypto } from './e2ee-session.js';

const TYPING_STOP_MS = 2200;
const TICK_MS = 1000;

let conversationId = null;
let me = null;
let other = null;
let ttlHours = 24;
let oldestId = null;
let hasMore = false;
let loadingMore = false;
let typingTimer = null;
let typingSent = false;
let peerTypingTimer = null;
let tickTimer = null;
let pendingAttachment = null;
/** Per-conversation E2EE session. Null until the thread is opened. */
let e2ee = null;

/** message id -> { node, expiresAt } for the countdown loop */
const live = new Map();
/** clientUuid -> node, so the echo can replace the optimistic bubble */
const optimistic = new Map();

let listEl;
let formEl;
let inputEl;

// ------------------------------------------------------------------ helpers

const isMine = (message) => Number(message.senderId) === Number(me.id);

function scrollToBottom(smooth = false) {
  requestAnimationFrame(() => {
    listEl.scrollTo({
      top: listEl.scrollHeight,
      behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto'
    });
  });
}

function isNearBottom() {
  return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 140;
}

const dayLabel = formatDayLabel;

// ----------------------------------------------------------------- bubbles

function attachmentMarkup(message) {
  const a = message.attachment;
  if (!a) return '';

  if (a.kind === 'image') {
    return `
      <button type="button" class="mt-1 block overflow-hidden rounded-2xl" data-lightbox="${escapeHtml(a.url)}"
              aria-label="Open photo full size">
        <img loading="lazy" decoding="async" src="${escapeHtml(a.thumbUrl || a.url)}" alt="Photo"
             class="max-h-[280px] w-full max-w-[260px] bg-hairline/[var(--track-a)] object-cover"
             loading="lazy" ${a.width && a.height ? `width="${a.width}" height="${a.height}"` : ''} />
      </button>`;
  }

  if (a.kind === 'video') {
    return `
      <video class="mt-1 max-h-[300px] w-full max-w-[260px] rounded-2xl bg-black" controls preload="metadata"
             ${a.thumbUrl ? `poster="${escapeHtml(a.thumbUrl)}"` : ''}>
        <source src="${escapeHtml(a.url)}" type="${escapeHtml(a.mime || 'video/mp4')}" />
        Your browser cannot play this video.
      </video>`;
  }

  return `
    <a href="${escapeHtml(a.url)}" class="mt-1 flex items-center gap-2 rounded-2xl bg-hairline/[var(--track-a)] px-3 py-2 text-sm">
      <svg viewBox="0 0 24 24" class="h-5 w-5 fill-current" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg>
      Attachment · ${escapeHtml(formatBytes(a.sizeBytes || 0))}
    </a>`;
}

/** A shared place. Live shares get a pulsing badge and a countdown. */
function locationMarkup(message) {
  const loc = message.location;
  if (!loc) return '';
  const live = loc.isLive;
  return `
    <div class="location-card mt-1 w-[240px]" data-location="${message.id}">
      <div class="location-map">
        ${mapPreviewSvg(loc.lat, loc.lng, { live })}
        ${live ? '<span class="live-pulse">LIVE</span>' : ''}
      </div>
      <div class="bg-surface px-3 py-2">
        <p class="text-[13px] font-bold text-ink">
          ${live ? 'Live location' : 'Shared a location'}
        </p>
        ${loc.label ? `<p class="mt-0.5 text-[12px] text-ink-soft">${escapeHtml(loc.label)}</p>` : ''}
        ${live ? `<p class="mt-0.5 text-[11.5px] text-ink-faint" data-live-until>${escapeHtml(liveRemaining(loc.liveUntil))}</p>` : ''}
        <a href="${escapeHtml(mapLink(loc.lat, loc.lng))}" target="_blank" rel="noopener noreferrer"
           class="mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-primary">
          Open in maps
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 fill-current" aria-hidden="true"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3zM5 5h5v2H7v10h10v-3h2v5H5V5z"/></svg>
        </a>
      </div>
    </div>`;
}

function liveRemaining(iso) {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((new Date(iso) - Date.now()) / 1000));
  if (secs <= 0) return 'Live sharing ended';
  const mins = Math.ceil(secs / 60);
  return `Sharing for another ${mins} min`;
}

/**
 * Decrypt in place, once, before render.
 *
 * `message.body` is null for an encrypted row, so every existing render path
 * (bubbles, previews, notifications) would show an empty line. We decrypt here
 * and set `body`, keeping the rest of the UI blissfully unaware of crypto.
 *
 * A message we cannot open gets an explicit placeholder rather than silently
 * rendering blank — the user is told the truth about what happened.
 */
async function decryptMessage(message) {
  if (!message?.isEncrypted || !message.envelope) return message;
  if (message._decrypted) return message;

  const text = e2ee ? await e2ee.open(message.envelope) : null;
  message._decrypted = true;
  if (text === null) {
    message.body = null;
    message.undecryptable = true;
    // Distinguish "sent before this device existed" (never readable here) from
    // "the key has not reached us yet" (still might). Claiming the latter for
    // the former is a small lie the user would eventually catch.
    const sentAt = Date.parse(message.createdAt || '');
    const born = e2ee?.deviceCreatedAt;
    message.predatesDevice = Boolean(born && sentAt && sentAt < born);
  } else {
    message.body = text;
  }
  return message;
}

/** Decrypt a whole page in parallel. */
async function decryptAll(messages) {
  await Promise.all(messages.map((m) => decryptMessage(m)));
  return messages;
}

function buildBubble(message) {
  const mine = isMine(message);
  const row = el('div', {
    class: `flex w-full flex-col ${mine ? 'items-end' : 'items-start'}`,
    'data-message-id': String(message.id ?? ''),
    'data-client-uuid': message.clientUuid || '',
    role: 'listitem'
  });

  const bubble = el('div', { class: `bubble ${mine ? 'bubble-out' : 'bubble-in'}` });
  // A location bubble carries its own caption inside the card, so the plain
  // body ("Shared a location") would just be a duplicate line.
  const hasText = Boolean(message.body && message.body.trim()) && message.type !== 'location';
  // An encrypted message this device holds no key for. Being explicit beats an
  // empty bubble: it usually means the sender's key has not reached us yet.
  const locked = Boolean(message.undecryptable);

  bubble.innerHTML = `
    ${attachmentMarkup(message)}
    ${locationMarkup(message)}
    ${locked
    ? `<span data-body class="italic opacity-80">${message.predatesDevice
      ? '🔒 Encrypted before you signed in on this device, so it cannot be opened here.'
      : '🔒 Encrypted message — this device does not have the key yet.'}</span>`
    : hasText ? `<span data-body>${escapeHtml(message.body)}</span>` : ''}
    <span class="mt-1 flex items-center justify-end gap-1.5">
      <span class="text-[11px] ${mine ? 'text-white/75' : 'text-ink-faint'}" data-time>${escapeHtml(clockTime(message.createdAt))}</span>
      <span class="ttl-chip" data-ttl title="This message is deleted 24 hours after it was sent">
        <svg viewBox="0 0 24 24" class="h-3 w-3 fill-current" aria-hidden="true"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v6l4.5 2.7-.8 1.3L11 14V7h2z"/></svg>
        <span data-ttl-text>—</span>
      </span>
      ${mine ? `<span class="text-[11px] text-white/75" data-receipt aria-label="${message.readAt ? 'Read' : 'Sent'}">${message.readAt ? '✓✓' : '✓'}</span>` : ''}
    </span>`;

  row.append(bubble);

  // "Does this bother you?" — shown to the recipient only, never the sender.
  if (!mine && message.safety?.prompt) {
    const bar = el('div', { class: 'safety-bar max-w-[300px]' });
    bar.innerHTML = `
      <svg viewBox="0 0 24 24" class="mt-0.5 h-4 w-4 shrink-0 fill-rewind" aria-hidden="true"><path d="M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z"/></svg>
      <span class="flex-1">
        ${escapeHtml(message.safety.prompt)}
        <button type="button" class="ml-1 font-bold text-brand-primary underline" data-safety-report="${message.senderId}">Report</button>
      </span>`;
    bar.querySelector('[data-safety-report]')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('ember:report', { detail: { userId: message.senderId } }));
    });
    row.append(bar);
  }

  bubble.querySelector('[data-lightbox]')?.addEventListener('click', (e) => {
    openLightbox(e.currentTarget.dataset.lightbox);
  });

  if (message.id) {
    live.set(String(message.id), { node: row, expiresAt: message.expiresAt });
    paintTtl(row, message.expiresAt);
  }
  return row;
}

function openLightbox(url) {
  const body = el('div');
  body.innerHTML = `<img src="${escapeHtml(url)}" alt="Photo, full size" class="mx-auto max-h-[70vh] w-auto rounded-2xl" />`;
  openModal({ title: '', body, actions: [{ label: 'Close', class: 'btn-secondary', value: 'close' }] });
}

/** Apply the current countdown to one bubble. Returns true when expired. */
function paintTtl(row, expiresAt) {
  const chip = row.querySelector('[data-ttl]');
  if (!chip) return false;
  const { text, state, expired } = formatRemaining(expiresAt, socket.clockSkewMs);
  chip.querySelector('[data-ttl-text]').textContent = expired ? 'gone' : text;
  chip.dataset.state = state;
  return expired;
}

/** Fade a bubble out, then drop it from the DOM. Layer 4. */
function removeMessageNode(id, { silent = false } = {}) {
  const entry = live.get(String(id));
  if (!entry) return;
  live.delete(String(id));

  const { node } = entry;
  const reduced = prefersReducedMotion();
  node.style.transition = reduced ? 'opacity .01s linear' : 'opacity .5s ease, transform .5s ease, max-height .5s ease';
  node.style.overflow = 'hidden';
  node.style.maxHeight = `${node.scrollHeight}px`;

  requestAnimationFrame(() => {
    node.style.opacity = '0';
    node.style.transform = 'scale(0.94)';
    node.style.maxHeight = '0px';
    node.style.marginBottom = '0px';
  });

  setTimeout(() => {
    node.remove();
    pruneEmptyDayGroups();
    if (!listEl.querySelector('[data-message-id]')) renderEmpty();
  }, reduced ? 20 : 520);

  if (!silent) {
    const announcer = $('#chat-announcer');
    if (announcer) announcer.textContent = 'A message expired and was deleted.';
  }
}

function pruneEmptyDayGroups() {
  for (const group of $$('[data-day-group]', listEl)) {
    if (!group.querySelector('[data-message-id]')) group.remove();
  }
}

/** One timer drives every countdown on the page. */
function startTicking() {
  stopTicking();
  tickTimer = setInterval(() => {
    for (const [id, { node, expiresAt }] of live) {
      if (paintTtl(node, expiresAt)) removeMessageNode(id);
    }
    updateNextExpiry();
  }, TICK_MS);
}

function stopTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

function updateNextExpiry() {
  const label = $('#next-expiry');
  if (!label) return;
  let soonest = null;
  for (const { expiresAt } of live.values()) {
    const ms = new Date(expiresAt).getTime();
    if (soonest === null || ms < soonest) soonest = ms;
  }
  if (soonest === null) {
    label.textContent = '';
    return;
  }
  const { text, expired } = formatRemaining(new Date(soonest).toISOString(), socket.clockSkewMs);
  label.textContent = expired ? '' : `Next message disappears in ${text}`;
}

// ------------------------------------------------------------------ render

function renderEmpty() {
  listEl.replaceChildren(emptyState({
    icon: `<svg viewBox="0 0 24 24" class="h-9 w-9 fill-current" aria-hidden="true"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>`,
    title: 'No messages yet',
    message: `Say something to ${other?.displayName || 'them'}. Whatever you send disappears ${ttlHours} hours later.`
  }));
}

/** Append a message, creating a day separator when the date changes. */
function appendMessage(message, { animate = true } = {}) {
  if (!listEl.querySelector('[data-day-group]')) listEl.replaceChildren();

  const label = dayLabel(message.createdAt);
  let group = [...listEl.querySelectorAll('[data-day-group]')].find((g) => g.dataset.dayGroup === label);

  if (!group) {
    group = el('section', { 'data-day-group': label, class: 'flex flex-col gap-2' });
    group.append(el('div', { class: 'my-3 flex justify-center' }, [
      el('span', { class: 'rounded-full bg-hairline/[var(--track-a)] px-3 py-1 text-[11px] font-semibold text-ink-soft', text: label })
    ]));
    listEl.append(group);
  }

  const row = buildBubble(message);
  if (animate && !prefersReducedMotion()) row.classList.add('animate-pop');
  group.append(row);
  return row;
}

/** Older page: prepend without disturbing the scroll position. */
function prependMessages(messages) {
  const previousHeight = listEl.scrollHeight;
  const previousTop = listEl.scrollTop;

  // Rebuild from scratch in order: simplest correct approach for day grouping.
  const existing = [...listEl.querySelectorAll('[data-message-id]')].map((n) => n._message).filter(Boolean);
  const all = [...messages, ...existing];
  listEl.replaceChildren();
  live.clear();
  for (const message of all) {
    const row = appendMessage(message, { animate: false });
    row._message = message;
  }
  listEl.scrollTop = previousTop + (listEl.scrollHeight - previousHeight);
}

function renderAll(messages) {
  listEl.replaceChildren();
  live.clear();
  if (!messages.length) {
    renderEmpty();
    return;
  }
  for (const message of messages) {
    const row = appendMessage(message, { animate: false });
    row._message = message;
  }
  scrollToBottom();
}

// ------------------------------------------------------------------ header

function paintHeader() {
  if (!other) return;
  const avatar = $('#peer-avatar');
  if (avatar) {
    avatar.src = avatarSrc(other);
    avatar.alt = '';
    attachAvatarFallback(avatar, other);
  }
  $('#peer-name').textContent = other.displayName;
  paintPresence();
}

function paintPresence() {
  const dot = $('#peer-online');
  const text = $('#peer-status');
  if (!text) return;
  if (other.isOnline) {
    dot?.classList.remove('hidden');
    text.textContent = 'Online now';
    text.className = 'text-[12px] font-medium text-like';
  } else {
    dot?.classList.add('hidden');
    text.textContent = other.lastSeenAt ? `Active ${timeAgo(other.lastSeenAt)}` : 'Offline';
    text.className = 'text-[12px] text-ink-soft';
  }
}

function showPeerTyping(isTyping) {
  const node = $('#typing-indicator');
  if (!node) return;
  node.classList.toggle('hidden', !isTyping);
  if (isTyping) {
    if (isNearBottom()) scrollToBottom(true);
    clearTimeout(peerTypingTimer);
    peerTypingTimer = setTimeout(() => node.classList.add('hidden'), TYPING_STOP_MS + 1500);
  }
}

// ------------------------------------------------------------- location share

let stopLiveShare = null;

/** Ask what to share, get a fix, then post it. */
async function shareLocationFlow() {
  const choice = await openModal({
    title: 'Share your location',
    body: html(`
      <div class="text-left">
        <p class="text-[14px] text-ink-soft">
          ${escapeHtml(other.displayName)} will see where you are. Like every message here,
          it disappears after 24 hours.
        </p>
      </div>`),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Live for 15 min', value: '15' },
      { label: 'Live for 60 min', value: '60' },
      { label: 'Send once', value: 'once', class: 'btn-primary' }
    ]
  });
  if (!choice || choice === 'cancel') return;

  const button = $('#share-location');
  button.disabled = true;
  try {
    const point = await getPosition();
    const liveMinutes = choice === 'once' ? 0 : Number(choice);
    const res = await api.shareLocation(conversationId, {
      lat: point.lat,
      lng: point.lng,
      accuracy: point.accuracy,
      liveMinutes,
      clientUuid: uuid()
    });

    // The socket echo renders the bubble; append directly if it is not connected.
    if (!socket.isConnected() && res.message) appendMessage(res.message);
    scrollToBottom(true);

    if (liveMinutes > 0) beginLiveShare(res.message.id, liveMinutes);
  } catch (err) {
    toast(err.message || 'Could not share your location.', { type: 'error' });
  } finally {
    button.disabled = false;
  }
}

function beginLiveShare(messageId, minutes) {
  const bar = $('#live-share-bar');
  const text = $('#live-share-text');
  bar.classList.remove('hidden');
  bar.classList.add('flex');

  stopLiveShare = startLiveShare({
    conversationId,
    messageId,
    minutes,
    onTick: (secsLeft) => {
      const m = Math.floor(secsLeft / 60);
      const sec = String(secsLeft % 60).padStart(2, '0');
      text.textContent = `Sharing your live location · ${m}:${sec} left`;
    },
    onEnd: () => {
      bar.classList.add('hidden');
      bar.classList.remove('flex');
      stopLiveShare = null;
      const card = listEl.querySelector(`[data-location="${messageId}"]`);
      card?.querySelector('.live-pulse')?.remove();
      const until = card?.querySelector('[data-live-until]');
      if (until) until.textContent = 'Live sharing ended';
    }
  });
}

// ------------------------------------------------------------------ sending

/**
 * Ask the server whether a message reads as hurtful before it goes out.
 * A failure here must never block sending — it is a nicety, not a gate.
 */
async function confirmIfRisky(body) {
  let verdict;
  try {
    verdict = await api.checkMessage(conversationId, body);
  } catch {
    return true;
  }
  if (!verdict.flagged || !verdict.prompt) return true;

  return confirmDialog({
    title: 'Before you send',
    message: verdict.prompt,
    confirmLabel: 'Send anyway'
  });
}

function clearComposer() {
  inputEl.value = '';
  inputEl.style.height = 'auto';
  pendingAttachment = null;
  $('#attachment-preview').classList.add('hidden');
  $('#attachment-preview').replaceChildren();
  updateSendState();
}

function updateSendState() {
  const hasContent = inputEl.value.trim().length > 0 || Boolean(pendingAttachment);
  $('#send').disabled = !hasContent;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

async function sendMessage(event) {
  event?.preventDefault();
  const body = inputEl.value.trim();
  const attachment = pendingAttachment;
  if (!body && !attachment) return;

  // "Are you sure?" — advisory only, and only for the patterns the server flags.
  if (body && !(await confirmIfRisky(body))) return;

  const clientUuid = uuid();
  const draft = {
    id: null,
    conversationId,
    senderId: me.id,
    body,
    type: attachment ? attachment.kind : 'text',
    clientUuid,
    readAt: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlHours * 3600 * 1000).toISOString(),
    attachment: attachment
      ? { ...attachment, url: attachment.url, thumbUrl: attachment.thumbUrl }
      : null
  };

  if (!listEl.querySelector('[data-message-id]')) listEl.replaceChildren();
  const row = appendMessage(draft);
  row._message = draft;
  row.dataset.pending = 'true';
  row.style.opacity = '0.65';
  optimistic.set(clientUuid, row);
  scrollToBottom(true);
  clearComposer();
  stopTyping();

  const payload = {
    body: body || null,
    type: draft.type,
    clientUuid,
    attachmentId: attachment?.attachmentId ?? null
  };

  // Seal the text if this thread has a working key. On success we send the
  // envelope INSTEAD of the plaintext — never both, or the encryption would be
  // theatre. If sealing is unavailable the header already says so.
  if (body && e2ee?.canEncrypt) {
    const envelope = await e2ee.seal(body);
    if (envelope) {
      payload.envelope = envelope;
      payload.body = null;
    }
  }

  try {
    let saved;
    if (socket.isConnected()) {
      const ack = await socket.emitAck('chat:message', { conversationId, ...payload });
      if (!ack?.ok) throw new Error(ack?.error || 'That message could not be sent.');
      saved = ack.message;
    } else {
      // Socket down: the REST route is the same write path.
      const res = await api.sendMessage(conversationId, payload);
      saved = res.message || res;
    }
    reconcile(clientUuid, saved);
  } catch (err) {
    const node = optimistic.get(clientUuid);
    if (node) {
      node.dataset.failed = 'true';
      node.style.opacity = '1';
      const bubble = node.querySelector('.bubble');
      bubble.classList.add('ring-2', 'ring-nope');
      if (!node.querySelector('[data-retry]')) {
        const retry = el('button', {
          type: 'button',
          class: 'mt-1 text-[11px] font-semibold text-nope underline',
          text: 'Not sent — tap to retry',
          'data-retry': ''
        });
        retry.addEventListener('click', () => {
          inputEl.value = body;
          pendingAttachment = attachment;
          node.remove();
          optimistic.delete(clientUuid);
          updateSendState();
          sendMessage();
        });
        node.append(retry);
      }
    }
    if (!(err instanceof ApiError) || err.code !== 'SESSION_EXPIRED') {
      toast(err.message || 'That message could not be sent.', { type: 'error' });
    }
  }
}

/** Replace an optimistic bubble with the canonical server row. */
function reconcile(clientUuid, saved) {
  // Our own encrypted echo comes back as ciphertext. We already know what we
  // typed, so reuse the optimistic plaintext rather than decrypting our own
  // message back out again.
  if (saved?.isEncrypted) {
    const pending = optimistic.get(clientUuid);
    const localText = pending?._message?.body;
    if (localText) {
      saved.body = localText;
      saved._decrypted = true;
    }
  }
  const node = optimistic.get(clientUuid);
  optimistic.delete(clientUuid);
  if (!node || !saved) return;

  const fresh = buildBubble(saved);
  fresh._message = saved;
  node.replaceWith(fresh);
  updateNextExpiry();
}

// ------------------------------------------------------------------ typing

function onInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 132)}px`;
  updateSendState();

  if (!typingSent) {
    typingSent = true;
    socket.emit('chat:typing', { conversationId, isTyping: true });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, TYPING_STOP_MS);
}

function stopTyping() {
  clearTimeout(typingTimer);
  if (typingSent) {
    typingSent = false;
    socket.emit('chat:typing', { conversationId, isTyping: false });
  }
}

// ------------------------------------------------------------- attachments

async function handleFile(file) {
  if (!file) return;
  const isVideo = file.type.startsWith('video/');
  const limit = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > limit) {
    toast(`That file is larger than ${isVideo ? '50MB' : '10MB'}.`, { type: 'error' });
    return;
  }

  const preview = $('#attachment-preview');
  preview.classList.remove('hidden');
  preview.innerHTML = `
    <div class="flex items-center gap-3 rounded-2xl bg-surface-grey p-2.5">
      <div class="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface-cool">
        <svg viewBox="0 0 24 24" class="h-6 w-6 fill-ink-faint" aria-hidden="true"><path d="M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-[13px] font-medium text-ink">${escapeHtml(file.name)}</p>
        <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-track/[var(--track-a)]">
          <div class="h-full w-0 rounded-full bg-brand-gradient transition-all" data-progress></div>
        </div>
      </div>
      <button type="button" class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-soft hover:bg-hairline/[var(--track-a)]"
              data-cancel-upload aria-label="Cancel upload">
        <svg viewBox="0 0 24 24" class="h-4 w-4 fill-current" aria-hidden="true"><path d="M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4L10.6 10.6l6.3-6.3z"/></svg>
      </button>
    </div>`;

  let cancelled = false;
  preview.querySelector('[data-cancel-upload]').addEventListener('click', () => {
    cancelled = true;
    pendingAttachment = null;
    preview.classList.add('hidden');
    preview.replaceChildren();
    updateSendState();
  });

  const bar = preview.querySelector('[data-progress]');
  try {
    const result = await api.upload(file, (pct) => {
      bar.style.width = `${Math.round(pct * 100)}%`;
    });
    if (cancelled) return;
    pendingAttachment = result;
    bar.style.width = '100%';

    // Swap the placeholder icon for the real thumbnail.
    const thumbBox = preview.querySelector('.h-12');
    if (result.thumbUrl && thumbBox) {
      thumbBox.innerHTML = `<img src="${escapeHtml(result.thumbUrl)}" alt="" class="h-full w-full object-cover" />`;
    }
    updateSendState();
    inputEl.focus();
  } catch (err) {
    preview.classList.add('hidden');
    preview.replaceChildren();
    pendingAttachment = null;
    updateSendState();
    toast(err.message || 'That file could not be uploaded.', { type: 'error' });
  }
}

// --------------------------------------------------------------- menu items

async function clearChat() {
  const ok = await confirmDialog({
    title: 'Clear this chat?',
    message: 'Every message, photo and video in this conversation is deleted immediately — for both of you. This cannot be undone.',
    confirmLabel: 'Clear chat',
    danger: true
  });
  if (!ok) return;

  try {
    const result = await api.clearConversation(conversationId);
    live.clear();
    renderEmpty();
    toast(`Cleared ${result.deletedMessages || 0} message${result.deletedMessages === 1 ? '' : 's'}.`);
  } catch (err) {
    toast(err.message || 'Could not clear this chat.', { type: 'error' });
  }
}

async function unmatch(matchId) {
  const ok = await confirmDialog({
    title: `Unmatch ${other.displayName}?`,
    message: 'You will no longer see each other, and this conversation and everything in it is deleted.',
    confirmLabel: 'Unmatch',
    danger: true
  });
  if (!ok) return;
  try {
    await api.unmatch(matchId);
    location.replace('/matches');
  } catch (err) {
    toast(err.message || 'Could not unmatch.', { type: 'error' });
  }
}

async function blockPeer() {
  const ok = await confirmDialog({
    title: `Block ${other.displayName}?`,
    message: 'They will not be able to see you or message you, and this conversation is deleted.',
    confirmLabel: 'Block',
    danger: true
  });
  if (!ok) return;
  try {
    await api.block(other.id);
    location.replace('/matches');
  } catch (err) {
    toast(err.message || 'Could not block that person.', { type: 'error' });
  }
}

function reportPeer() {
  const body = el('div');
  body.innerHTML = `
    <p class="text-[15px] text-ink-soft">Tell us what's wrong. Reports are confidential.</p>
    <div class="mt-3 flex flex-wrap gap-2" role="group" aria-label="Reason">
      ${['Harassment', 'Inappropriate content', 'Spam or scam', 'Fake profile', 'Other']
        .map((r, i) => `<button type="button" class="chip-option" data-reason="${escapeHtml(r)}" aria-pressed="${i === 0}">${escapeHtml(r)}</button>`).join('')}
    </div>
    <textarea class="field mt-3 min-h-[90px]" data-details maxlength="400" placeholder="Add details (optional)"></textarea>`;

  let reason = 'Harassment';
  for (const btn of body.querySelectorAll('[data-reason]')) {
    btn.addEventListener('click', () => {
      reason = btn.dataset.reason;
      for (const sib of body.querySelectorAll('[data-reason]')) sib.setAttribute('aria-pressed', String(sib === btn));
    });
  }

  openModal({
    title: `Report ${other.displayName}`,
    body,
    actions: [
      { label: 'Cancel', class: 'btn-secondary', value: null },
      { label: 'Submit report', class: 'btn-danger', value: 'send' }
    ]
  }).then(async (value) => {
    if (value !== 'send') return;
    try {
      await api.report(other.id, reason, body.querySelector('[data-details]').value.trim());
      toast('Thanks — our team will take a look.');
    } catch (err) {
      toast(err.message || 'Could not send that report.', { type: 'error' });
    }
  });
}

// -------------------------------------------------------------------- init

export async function initChat({ user }) {
  me = user;
  conversationId = Number(new URLSearchParams(location.search).get('c'));
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    location.replace('/matches');
    return;
  }

  listEl = $('#messages');
  formEl = $('#composer');
  inputEl = $('#message-input');

  // --- load the conversation shell (peer, match id)
  let meta;
  try {
    meta = await api.conversation(conversationId);
  } catch (err) {
    toast(err.message || 'That conversation is not available.', { type: 'error' });
    setTimeout(() => location.replace('/matches'), 1200);
    return;
  }

  // GET /api/conversations/:id -> { conversationId, matchId, peer }
  other = meta.peer;
  ttlHours = meta.ttlHours || 24;
  const matchId = meta.matchId ?? null;
  paintHeader();
  $('#ttl-banner-hours').textContent = String(ttlHours);

  // --- join the room; the ack carries the first page of history
  let history = [];
  try {
    const ack = await socket.emitAck('chat:join', { conversationId });
    if (!ack?.ok) throw new Error(ack?.error || 'Could not open that conversation.');
    history = ack.messages || [];
    hasMore = Boolean(ack.hasMore);
    ttlHours = ack.ttlHours || ttlHours;
    if (ack.serverTime) socket.setClockSkew(ack.serverTime);
  } catch {
    // Socket unavailable — fall back to REST so the thread still renders.
    const page = await api.messages(conversationId, { limit: 30 });
    history = page.messages || [];
    hasMore = Boolean(page.hasMore);
    if (page.serverTime) socket.setClockSkew(page.serverTime);
  }

  // --- bring up end-to-end encryption before the first render, so history
  //     paints as plaintext rather than flashing locked placeholders.
  e2ee = new ConversationCrypto(conversationId);
  await e2ee.init();
  paintEncryptionState();
  await decryptAll(history);

  oldestId = history.length ? history[0].id : null;
  renderAll(history);
  $('#load-more').classList.toggle('hidden', !hasMore);
  startTicking();
  updateNextExpiry();

  // Mark read now and whenever the tab is focused.
  const markRead = () => {
    if (document.visibilityState === 'visible') socket.emit('chat:read', { conversationId });
  };
  markRead();
  document.addEventListener('visibilitychange', markRead);
  window.addEventListener('focus', markRead);

  // A new key generation was published (new device, or the peer's first
  // visit). Adopt it and retry anything that failed to decrypt.
  socket.on('chat:key:published', async (payload) => {
    if (Number(payload?.conversationId) !== conversationId) return;
    if (!e2ee) return;
    await e2ee.refreshKeys();
    paintEncryptionState();
    await retryLockedMessages();
  });

  // The other side changed the disappearing timer.
  socket.on('chat:timer', (payload) => {
    if (Number(payload?.conversationId) !== conversationId) return;
    ttlHours = payload.ttlHours || ttlHours;
    const banner = $('#ttl-banner-hours');
    if (banner) banner.textContent = String(ttlHours);
    paintTimerButton();
  });

  // --------------------------------------------------------- socket wiring
  socket.on('chat:message', async (message) => {
    if (Number(message.conversationId) !== conversationId) return;

    // Our own echo: reconcile the optimistic bubble instead of duplicating.
    if (message.clientUuid && optimistic.has(message.clientUuid)) {
      reconcile(message.clientUuid, message);
      return;
    }
    if (message.id && live.has(String(message.id))) return;

    // Incoming ciphertext is opened before it is rendered.
    await decryptMessage(message);

    const stick = isNearBottom();
    if (!listEl.querySelector('[data-message-id]')) listEl.replaceChildren();
    const row = appendMessage(message);
    row._message = message;
    updateNextExpiry();

    if (isMine(message)) {
      scrollToBottom(true);
    } else {
      showPeerTyping(false);
      if (stick) {
        scrollToBottom(true);
        markRead();
      } else {
        showJumpButton();
      }
    }
  });

  socket.on('chat:typing', ({ conversationId: cid, userId, isTyping }) => {
    if (Number(cid) === conversationId && Number(userId) !== Number(me.id)) showPeerTyping(isTyping);
  });

  socket.on('chat:read', ({ conversationId: cid, readerId }) => {
    if (Number(cid) !== conversationId || Number(readerId) === Number(me.id)) return;
    for (const node of $$('[data-message-id]', listEl)) {
      const receipt = node.querySelector('[data-receipt]');
      if (receipt) {
        receipt.textContent = '✓✓';
        receipt.setAttribute('aria-label', 'Read');
      }
    }
  });

  socket.on('chat:message:expired', ({ conversationId: cid, messageIds }) => {
    if (Number(cid) !== conversationId) return;
    for (const id of messageIds || []) removeMessageNode(id);
    updateNextExpiry();
  });

  // A peer's live pin moved: swap the map preview in place.
  socket.on('chat:location:update', ({ conversationId: cid, messageId, lat, lng }) => {
    if (Number(cid) !== conversationId) return;
    const card = listEl.querySelector(`[data-location="${messageId}"] .location-map`);
    if (card) {
      card.innerHTML = `${mapPreviewSvg(lat, lng, { live: true })}<span class="live-pulse">LIVE</span>`;
    }
  });

  socket.on('chat:location:stopped', ({ conversationId: cid, messageId }) => {
    if (Number(cid) !== conversationId) return;
    const card = listEl.querySelector(`[data-location="${messageId}"]`);
    card?.querySelector('.live-pulse')?.remove();
    const until = card?.querySelector('[data-live-until]');
    if (until) until.textContent = 'Live sharing ended';
  });

  socket.on('chat:cleared', ({ conversationId: cid, clearedBy }) => {
    if (Number(cid) !== conversationId) return;
    live.clear();
    renderEmpty();
    if (Number(clearedBy) !== Number(me.id)) toast(`${other.displayName} cleared this chat.`);
  });

  socket.on('presence:update', ({ userId, isOnline, lastSeenAt }) => {
    if (Number(userId) !== Number(other.id)) return;
    other.isOnline = isOnline;
    if (lastSeenAt) other.lastSeenAt = lastSeenAt;
    paintPresence();
  });

  socket.on('match:removed', ({ conversationId: cid }) => {
    if (Number(cid) === conversationId) {
      toast('This match was removed.');
      setTimeout(() => location.replace('/matches'), 1200);
    }
  });

  // Re-sync after a reconnect so nothing is missed or left stale.
  socket.on('connection:state', async ({ connected, reconnected }) => {
    if (!connected || !reconnected) return;
    try {
      const ack = await socket.emitAck('chat:join', { conversationId });
      if (ack?.ok) {
        if (ack.serverTime) socket.setClockSkew(ack.serverTime);
        oldestId = ack.messages?.length ? ack.messages[0].id : null;
        hasMore = Boolean(ack.hasMore);
        renderAll(ack.messages || []);
        $('#load-more').classList.toggle('hidden', !hasMore);
        updateNextExpiry();
        markRead();
      }
    } catch {
      /* the banner already tells the user */
    }
  });

  // ------------------------------------------------------------ composer
  formEl.addEventListener('submit', sendMessage);
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  inputEl.addEventListener('blur', stopTyping);

  $('#attach').addEventListener('change', (e) => {
    handleFile(e.target.files?.[0]);
    e.target.value = '';
  });

  $('#share-location')?.addEventListener('click', shareLocationFlow);
  $('#live-share-stop')?.addEventListener('click', () => stopLiveShare?.());

  // Drag & drop and paste-to-send.
  const pane = $('#chat-pane');
  pane.addEventListener('dragover', (e) => {
    e.preventDefault();
    pane.classList.add('ring-2', 'ring-brand-primary', 'ring-inset');
  });
  pane.addEventListener('dragleave', () => pane.classList.remove('ring-2', 'ring-brand-primary', 'ring-inset'));
  pane.addEventListener('drop', (e) => {
    e.preventDefault();
    pane.classList.remove('ring-2', 'ring-brand-primary', 'ring-inset');
    handleFile(e.dataTransfer?.files?.[0]);
  });
  inputEl.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])][0];
    if (file) {
      e.preventDefault();
      handleFile(file);
    }
  });

  // ------------------------------------------------------------ pagination
  $('#load-more').addEventListener('click', async () => {
    if (loadingMore || !oldestId) return;
    loadingMore = true;
    const btn = $('#load-more');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const page = await api.messages(conversationId, { before: oldestId, limit: 30 });
      const older = page.messages || [];
      if (older.length) {
        // Older pages are ciphertext too — open them before they are painted.
        await decryptAll(older);
        prependMessages(older);
        oldestId = older[0].id;
      }
      hasMore = Boolean(page.hasMore);
      btn.classList.toggle('hidden', !hasMore);
    } catch (err) {
      toast(err.message || 'Could not load older messages.', { type: 'error' });
    } finally {
      loadingMore = false;
      btn.disabled = false;
      btn.textContent = 'Load earlier messages';
    }
  });

  listEl.addEventListener('scroll', () => {
    if (isNearBottom()) hideJumpButton();
  });

  $('#jump-latest').addEventListener('click', () => {
    scrollToBottom(true);
    hideJumpButton();
    markRead();
  });

  // ---------------------------------------------------------------- menu
  $('#menu-clear').addEventListener('click', clearChat);
  $('#menu-block').addEventListener('click', blockPeer);
  $('#menu-report').addEventListener('click', reportPeer);
  $('#menu-unmatch').addEventListener('click', () => {
    if (matchId) unmatch(matchId);
    else toast('Could not find that match.', { type: 'error' });
  });
  $('#menu-profile').addEventListener('click', () => showPeerProfile());
  $('#menu-timer')?.addEventListener('click', () => showTimerPicker());
  $('#menu-encryption')?.addEventListener('click', () => showEncryptionDetails());
  $('#e2ee-badge')?.addEventListener('click', () => showEncryptionDetails());

  const menu = $('#chat-menu');
  const menuBtn = $('#menu-button');
  const toggleMenu = (open) => {
    menu.classList.toggle('hidden', !open);
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.addEventListener('click', () => toggleMenu(menu.classList.contains('hidden')));
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !menuBtn.contains(e.target)) toggleMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleMenu(false);
  });
  for (const item of $$('[role="menuitem"]', menu)) item.addEventListener('click', () => toggleMenu(false));

  // ---------------------------------------------------------------- calls
  $('#call-video').addEventListener('click', () => startCall('video'));
  $('#call-audio').addEventListener('click', () => startCall('audio'));

  window.addEventListener('beforeunload', () => {
    stopTyping();
    socket.emit('chat:leave', { conversationId });
  });
  window.addEventListener('pagehide', stopTicking);
}

/* ------------------------------------------------------------------ *
 * Encryption + timer UI
 * ------------------------------------------------------------------ */

/**
 * Paint the header badge. The copy is deliberately measured: "Encrypted" when
 * we hold a working key, and an honest reason when we do not. We never show a
 * padlock we cannot back up.
 */
function paintEncryptionState() {
  const badge = $('#e2ee-badge');
  if (!badge) return;

  if (e2ee?.canEncrypt) {
    badge.textContent = '🔒 Encrypted';
    badge.classList.remove('bg-surface-grey', 'text-ink-soft');
    badge.classList.add('bg-brand-100', 'text-brand-700');
    badge.title = 'Messages in this chat are encrypted on your device.';
  } else {
    badge.textContent = 'Not encrypted';
    badge.classList.remove('bg-brand-100', 'text-brand-700');
    badge.classList.add('bg-surface-grey', 'text-ink-soft');
    badge.title = e2ee?.reason || 'Encryption is not available in this chat.';
  }
}

/** Re-attempt every bubble that could not be decrypted, after a key arrives. */
async function retryLockedMessages() {
  const rows = $$('[data-message-id]', listEl);
  for (const row of rows) {
    const message = row._message;
    if (!message?.isEncrypted || !message.undecryptable) continue;
    message._decrypted = false;
    message.undecryptable = false;
    await decryptMessage(message);
    if (!message.undecryptable) {
      const bodyEl = row.querySelector('[data-body]');
      if (bodyEl) {
        bodyEl.textContent = message.body || '';
        bodyEl.classList.remove('italic', 'opacity-80');
      }
    }
  }
}

/** Keep the banner's hour count in step with the conversation timer. */
function paintTimerButton() {
  const banner = $('#ttl-banner-hours');
  if (banner) banner.textContent = String(ttlHours);
}

/** The disappearing-message picker. */
async function showTimerPicker() {
  let state;
  try {
    state = await api.getTimer(conversationId);
  } catch {
    toast('Could not load the timer.', { type: 'error' });
    return;
  }

  const body = el('div', { class: 'text-left' });
  body.innerHTML = `
    <p class="mb-3 text-[13.5px] leading-relaxed text-ink-soft">
      New messages in this chat disappear after the time you choose. This applies to
      <strong class="text-ink">new messages only</strong> — messages already sent keep the
      timer they were sent with.
    </p>
    <div class="flex flex-col gap-1.5" role="radiogroup" aria-label="Disappear after">
      ${state.options
    .map(
      (o) => `
        <button type="button" role="radio" data-ttl-option="${o.hours}"
          aria-checked="${o.hours === state.ttlHours ? 'true' : 'false'}"
          class="flex items-center justify-between rounded-2xl border px-4 py-3 text-left text-[14.5px] font-semibold transition
                 ${o.hours === state.ttlHours
    ? 'border-brand-500 bg-brand-50 text-brand-700'
    : 'border-hairline/[var(--hairline-a)] text-ink hover:bg-surface-grey'}">
          <span>${escapeHtml(o.label)}</span>
          <span aria-hidden="true">${o.hours === state.ttlHours ? '✓' : ''}</span>
        </button>`
    )
    .join('')}
    </div>
    ${state.setByName
    ? `<p class="mt-3 text-[12px] text-ink-faint">Last changed by ${escapeHtml(state.setByName)}.</p>`
    : ''}`;

  for (const btn of $$('[data-ttl-option]', body)) {
    btn.addEventListener('click', async () => {
      const hours = Number(btn.dataset.ttlOption);
      for (const sib of $$('[data-ttl-option]', body)) sib.setAttribute('aria-checked', String(sib === btn));
      try {
        const res = await api.setTimer(conversationId, hours);
        ttlHours = res.ttlHours;
        paintTimerButton();
        toast(res.changed ? `Messages now disappear after ${res.label}.` : `Already set to ${res.label}.`);
      } catch (err) {
        toast(err.message || 'Could not change the timer.', { type: 'error' });
      }
    });
  }

  openModal({
    title: 'Disappearing messages',
    body,
    actions: [{ label: 'Done', class: 'btn-primary', value: 'done' }]
  });
}

/**
 * Encryption details. This copy is the honest-claims contract: it states what
 * is protected, and just as plainly what is not.
 */
function showEncryptionDetails() {
  const on = Boolean(e2ee?.canEncrypt);
  const body = el('div', { class: 'text-left' });
  body.innerHTML = `
    <div class="mb-3 flex items-center gap-2">
      <span class="rounded-full px-2.5 py-1 text-[12px] font-bold ${on ? 'bg-brand-100 text-brand-700' : 'bg-surface-grey text-ink-soft'}">
        ${on ? '🔒 Encrypted' : 'Not encrypted'}
      </span>
    </div>
    ${on
    ? `<p class="text-[13.5px] leading-relaxed text-ink">
         Messages in this chat are encrypted on your device before they are sent. The key
         never leaves your browser, so we cannot read them on our servers.
       </p>`
    : `<p class="text-[13.5px] leading-relaxed text-ink">
         ${escapeHtml(e2ee?.reason || 'Encryption is not available in this chat.')}
       </p>`}
    <p class="mt-3 text-[12.5px] font-semibold text-ink">What this does not do</p>
    <ul class="mt-1 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-soft">
      <li>It does not hide <strong>who</strong> you talk to or <strong>when</strong> — only what you say.</li>
      <li>It cannot protect messages on a device someone else can unlock.</li>
      <li>Screenshots are always possible. Nothing here can stop them.</li>
      <li>We distribute the keys, so compare the safety number below out of band to be certain.</li>
    </ul>
    ${e2ee?.safetyNumber
    ? `<p class="mt-3 text-[12.5px] font-semibold text-ink">Safety number</p>
       <p class="mt-1 select-all rounded-2xl bg-surface-grey px-3 py-2 font-mono text-[13px] tracking-wider text-ink">
         ${escapeHtml(e2ee.safetyNumber)}
       </p>
       <p class="mt-1 text-[12px] text-ink-faint">
         If this matches on both phones, nobody is sitting in the middle.
       </p>`
    : ''}`;

  openModal({
    title: 'Encryption details',
    body,
    actions: [{ label: 'Close', class: 'btn-secondary', value: 'close' }]
  });
}

function startCall(mode) {
  const params = new URLSearchParams({ c: String(conversationId), role: 'caller', mode });
  location.href = `/call?${params.toString()}`;
}

function showJumpButton() {
  $('#jump-latest').classList.remove('hidden');
}

function hideJumpButton() {
  $('#jump-latest').classList.add('hidden');
}

function showPeerProfile() {
  const body = el('div', { class: 'text-left' });
  body.innerHTML = `
    <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(other))}" alt="" class="mx-auto h-32 w-32 rounded-3xl object-cover" />
    <h3 class="mt-4 text-center font-display text-2xl font-extrabold tracking-tight">
      ${escapeHtml(other.displayName)}${other.age ? `<span class="ml-1.5 text-lg font-medium text-ink-soft">${escapeHtml(String(other.age))}</span>` : ''}
    </h3>
    ${other.city ? `<p class="mt-1 text-center text-[14px] text-ink-soft">${escapeHtml(other.city)}</p>` : ''}
    ${other.bio ? `<p class="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-ink">${escapeHtml(other.bio)}</p>` : ''}`;
  openModal({ title: '', body, actions: [{ label: 'Close', class: 'btn-secondary', value: 'close' }] });
}

export { startCall };
