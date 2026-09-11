/**
 * deck.js — swipe deck.
 *
 * Renders a stack of up to three cards. The top card is draggable (pointer
 * events), keyboard-operable, and can be actioned from the button bar.
 * Decisions are optimistic: the card leaves immediately, the swipe is sent in
 * the background, and a failure re-inserts the card with a toast.
 */
import { api, ApiError } from './api.js';
import {
  $, $$, el, escapeHtml, toast, prefersReducedMotion, avatarSrc, initialsAvatar, openModal
} from './ui.js';
import { emptyState } from './app-shell.js';

const STACK_SIZE = 3;          // cards rendered at once
const REFILL_AT = 3;           // fetch more when the queue drops to this
const SWIPE_THRESHOLD = 110;   // px of horizontal travel that commits a swipe
const VELOCITY_THRESHOLD = 0.45;
const SUPER_THRESHOLD = 130;   // px of upward travel that commits a super like

/** @type {Array<object>} remaining candidates, index 0 is on top */
let queue = [];
/** @type {Array<{user: object, direction: string}>} for rewind */
const history = [];
let loading = false;
let exhausted = false;
let busy = false;

let stackEl;
let actionsEl;
let onMatch = () => {};

// --------------------------------------------------------------- rendering

function photoList(user) {
  const photos = (user.photos || []).filter((p) => p && p.url);
  if (photos.length) return photos.map((p) => p.url);
  if (user.avatarUrl) return [user.avatarUrl];
  return [initialsAvatar(user.displayName, user.id)];
}

function cardMarkup(user) {
  const photos = photoList(user);
  const dots = photos.length > 1
    ? `<div class="pointer-events-none absolute inset-x-3 top-3 z-20 flex gap-1.5" aria-hidden="true">
         ${photos.map((_, i) => `<span class="h-1 flex-1 rounded-full ${i === 0 ? 'bg-surface' : 'bg-white/35'}" data-dot="${i}"></span>`).join('')}
       </div>`
    : '';

  const online = user.isOnline
    ? '<span class="online-dot" aria-hidden="true"></span><span class="text-[13px] font-semibold text-white/90">Online now</span>'
    : '';

  // Why this person: two reasons at most. On a card that is already carrying a
  // name, age, city and bio, a third chip is clutter rather than information.
  // "Active now" is dropped here because the online dot above already says it.
  const reasons = (user.reasons || []).filter((r) => r.kind !== 'online').slice(0, 2);
  const reasonRow = reasons.length
    ? `<ul class="mt-2 flex flex-wrap gap-1.5" aria-label="Why you might get on">
         ${reasons
           .map(
             (r) => `<li class="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1
                                text-[12px] font-semibold text-white backdrop-blur-sm">
                       <span aria-hidden="true">${escapeHtml(r.icon)}</span>${escapeHtml(r.text)}
                     </li>`
           )
           .join('')}
       </ul>`
    : '';

  return `
    ${dots}
    <img class="absolute inset-0 h-full w-full object-cover" data-photo alt="Photo of ${escapeHtml(user.displayName)}"
         src="${escapeHtml(photos[0])}" draggable="false" />
    <div class="card-scrim"></div>

    <!-- decision stamps -->
    <div class="stamp stamp-like" data-stamp="like" aria-hidden="true">LIKE</div>
    <div class="stamp stamp-nope" data-stamp="pass" aria-hidden="true">NOPE</div>
    <div class="stamp stamp-super" data-stamp="superlike" aria-hidden="true">SUPER LIKE</div>

    <!-- tap zones for photo paging -->
    ${photos.length > 1 ? `
      <button type="button" class="absolute inset-y-0 left-0 z-10 w-1/3 cursor-default focus:outline-none" data-photo-prev aria-label="Previous photo"></button>
      <button type="button" class="absolute inset-y-0 right-0 z-10 w-1/3 cursor-default focus:outline-none" data-photo-next aria-label="Next photo"></button>
    ` : ''}

    <div class="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-5 text-white">
      <div class="flex items-center gap-2">
        ${online}
      </div>
      <h2 class="mt-1 flex items-end gap-2 font-display text-[28px] font-extrabold leading-tight tracking-tight">
        ${escapeHtml(user.displayName)}
        ${user.age ? `<span class="pb-0.5 text-[22px] font-medium opacity-90">${escapeHtml(String(user.age))}</span>` : ''}
      </h2>
      ${user.city ? `
        <p class="mt-1 flex items-center gap-1.5 text-[14px] font-medium text-white/85">
          <svg viewBox="0 0 24 24" class="h-4 w-4 fill-current" aria-hidden="true"><path d="M12 2a7 7 0 00-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z"/></svg>
          ${escapeHtml(user.city)}
        </p>` : ''}
      ${user.bio ? `<p class="mt-2 line-clamp-3 text-[14px] leading-snug text-white/90">${escapeHtml(user.bio)}</p>` : ''}
      ${reasonRow}
      <button type="button" class="pointer-events-auto mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3.5 py-1.5 text-[13px] font-semibold text-white backdrop-blur-sm transition hover:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              data-open-profile>
        <svg viewBox="0 0 24 24" class="h-4 w-4 fill-current" aria-hidden="true"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
        More info
      </button>
    </div>`;
}

function buildCard(user, depth) {
  const card = el('article', {
    class: 'swipe-card',
    'data-user-id': String(user.id),
    'aria-label': `${user.displayName}${user.age ? `, ${user.age}` : ''}`,
    role: 'group'
  });
  card.innerHTML = cardMarkup(user);
  card._user = user;
  card._photoIndex = 0;
  positionCard(card, depth);
  if (depth === 0) {
    card.tabIndex = 0;
    makeDraggable(card);
  } else {
    card.setAttribute('aria-hidden', 'true');
    card.inert = true;
  }
  wirePhotoPaging(card);
  return card;
}

/** Depth 0 = top card. Deeper cards are scaled down and pushed back. */
function positionCard(card, depth) {
  card.dataset.depth = String(depth);
  card.style.zIndex = String(STACK_SIZE - depth);
  card.style.transform = `translate3d(0, ${depth * 10}px, 0) scale(${1 - depth * 0.04})`;
  card.style.opacity = depth >= STACK_SIZE ? '0' : '1';
}

function wirePhotoPaging(card) {
  const photos = photoList(card._user);
  if (photos.length < 2) return;
  const img = card.querySelector('[data-photo]');

  const show = (index) => {
    card._photoIndex = (index + photos.length) % photos.length;
    img.src = photos[card._photoIndex];
    for (const dot of card.querySelectorAll('[data-dot]')) {
      dot.className = `h-1 flex-1 rounded-full ${Number(dot.dataset.dot) === card._photoIndex ? 'bg-surface' : 'bg-white/35'}`;
    }
  };

  card.querySelector('[data-photo-next]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    show(card._photoIndex + 1);
  });
  card.querySelector('[data-photo-prev]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    show(card._photoIndex - 1);
  });
  card._showPhoto = show;
}

// --------------------------------------------------------------- gestures

function makeDraggable(card) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let dx = 0;
  let dy = 0;
  let dragging = false;

  const stamps = {
    like: card.querySelector('[data-stamp="like"]'),
    pass: card.querySelector('[data-stamp="pass"]'),
    superlike: card.querySelector('[data-stamp="superlike"]')
  };

  const paint = () => {
    const rotation = dx / 18;
    card.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${rotation}deg)`;
    const horizontal = Math.abs(dx);
    const superProgress = dy < -20 && horizontal < 80 ? Math.min(1, -dy / SUPER_THRESHOLD) : 0;
    stamps.superlike.style.opacity = String(superProgress);
    stamps.like.style.opacity = superProgress > 0.2 ? '0' : String(Math.max(0, Math.min(1, dx / SWIPE_THRESHOLD)));
    stamps.pass.style.opacity = superProgress > 0.2 ? '0' : String(Math.max(0, Math.min(1, -dx / SWIPE_THRESHOLD)));
  };

  const reset = () => {
    card.classList.remove('grabbing');
    card.style.transition = prefersReducedMotion()
      ? 'transform 0.01s linear'
      : 'transform 0.42s cubic-bezier(0.34, 1.56, 0.64, 1)';
    card.style.transform = 'translate3d(0,0,0) scale(1)';
    for (const stamp of Object.values(stamps)) stamp.style.opacity = '0';
    setTimeout(() => { card.style.transition = ''; }, 430);
  };

  card.addEventListener('pointerdown', (e) => {
    if (busy || pointerId !== null) return;
    if (e.target.closest('[data-open-profile]')) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startTime = performance.now();
    dx = 0; dy = 0; dragging = false;
    card.setPointerCapture(pointerId);
    card.style.transition = '';
    card.classList.add('grabbing');
  });

  card.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) > 6) dragging = true;
    if (dragging) paint();
  });

  const finish = (e) => {
    if (e.pointerId !== pointerId) return;
    card.releasePointerCapture(pointerId);
    pointerId = null;

    if (!dragging) {
      // A tap on the sides pages photos; handled by the tap-zone buttons.
      reset();
      return;
    }

    const elapsed = Math.max(1, performance.now() - startTime);
    const vx = dx / elapsed;
    const vy = dy / elapsed;

    if (dy < -SUPER_THRESHOLD && Math.abs(dx) < 90) {
      decide('superlike');
    } else if (dx > SWIPE_THRESHOLD || vx > VELOCITY_THRESHOLD) {
      decide('like');
    } else if (dx < -SWIPE_THRESHOLD || vx < -VELOCITY_THRESHOLD) {
      decide('pass');
    } else if (vy < -VELOCITY_THRESHOLD && dy < -60) {
      decide('superlike');
    } else {
      reset();
    }
  };

  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== pointerId) return;
    card.releasePointerCapture(pointerId);
    pointerId = null;
    reset();
  });

  card.addEventListener('keydown', (e) => {
    if (busy) return;
    const keys = { ArrowLeft: 'pass', ArrowRight: 'like', ArrowUp: 'superlike' };
    if (keys[e.key]) {
      e.preventDefault();
      decide(keys[e.key]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openProfileSheet(card._user);
    }
  });

  card.querySelector('[data-open-profile]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openProfileSheet(card._user);
  });
}

/** Animate the top card off-screen in the direction of the decision. */
function flingCard(card, direction) {
  const reduced = prefersReducedMotion();
  card.style.transition = reduced ? 'opacity 0.12s linear' : 'transform 0.42s ease-out, opacity 0.42s ease-out';
  card.style.pointerEvents = 'none';
  if (reduced) {
    card.style.opacity = '0';
  } else if (direction === 'superlike') {
    card.style.transform = 'translate3d(0, -140%, 0) rotate(-4deg)';
  } else {
    const sign = direction === 'like' ? 1 : -1;
    card.style.transform = `translate3d(${sign * 150}%, 40px, 0) rotate(${sign * 22}deg)`;
    card.style.opacity = '0.6';
  }
  const remove = () => card.remove();
  setTimeout(remove, reduced ? 130 : 430);
}

// ---------------------------------------------------------------- profile

function openProfileSheet(user) {
  const photos = photoList(user);
  const body = el('div', { class: 'text-left' });
  body.innerHTML = `
    <div class="-mx-5 -mt-2 grid gap-1 ${photos.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}">
      ${photos.slice(0, 4).map((src, i) => `
        <img loading="lazy" decoding="async" src="${escapeHtml(src)}" alt="Photo ${i + 1} of ${escapeHtml(user.displayName)}"
             class="aspect-[4/5] w-full object-cover ${photos.length === 1 ? 'rounded-2xl' : ''}" />`).join('')}
    </div>
    <h3 class="mt-4 flex items-end gap-2 font-display text-2xl font-extrabold tracking-tight">
      ${escapeHtml(user.displayName)}
      ${user.age ? `<span class="pb-0.5 text-lg font-medium text-ink-soft">${escapeHtml(String(user.age))}</span>` : ''}
    </h3>
    ${user.username ? `<p class="mt-0.5 text-[13px] font-semibold text-brand-primary">@${escapeHtml(user.username)}</p>` : ''}
    ${user.city ? `<p class="mt-1 text-[14px] font-medium text-ink-soft">${escapeHtml(user.city)}</p>` : ''}
    ${user.bio ? `<p class="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-ink">${escapeHtml(user.bio)}</p>` : '<p class="mt-3 text-[15px] italic text-ink-faint">No bio yet.</p>'}
    <div class="mt-4 flex flex-wrap gap-2">
      <button type="button" class="chip-option chip-option-danger" data-report>Report</button>
      <button type="button" class="chip-option chip-option-danger" data-block>Block</button>
    </div>`;

  const modal = openModal({ title: '', body, actions: [{ label: 'Close', class: 'btn-secondary', value: 'close' }] });

  body.querySelector('[data-block]')?.addEventListener('click', async () => {
    modal.close('close');
    await blockUser(user);
  });
  body.querySelector('[data-report]')?.addEventListener('click', () => {
    modal.close('close');
    reportUser(user);
  });
}

async function blockUser(user) {
  try {
    await api.block(user.id);
    queue = queue.filter((u) => u.id !== user.id);
    render();
    toast(`${user.displayName} blocked.`);
  } catch (err) {
    toast(err.message || 'Could not block that person.', { type: 'error' });
  }
}

function reportUser(user) {
  const body = el('div');
  body.innerHTML = `
    <p class="text-[15px] text-ink-soft">Tell us what's wrong. Reports are confidential.</p>
    <div class="mt-3 flex flex-wrap gap-2" role="group" aria-label="Reason">
      ${['Inappropriate photos', 'Harassment', 'Spam or scam', 'Fake profile', 'Other']
        .map((r, i) => `<button type="button" class="chip-option" data-reason="${escapeHtml(r)}" aria-pressed="${i === 0}">${escapeHtml(r)}</button>`).join('')}
    </div>
    <textarea class="field mt-3 min-h-[90px]" data-details maxlength="500" placeholder="Add details (optional)"></textarea>`;

  let reason = 'Inappropriate photos';
  for (const btn of body.querySelectorAll('[data-reason]')) {
    btn.addEventListener('click', () => {
      reason = btn.dataset.reason;
      for (const sib of body.querySelectorAll('[data-reason]')) sib.setAttribute('aria-pressed', String(sib === btn));
    });
  }

  openModal({
    title: `Report ${user.displayName}`,
    body,
    actions: [
      { label: 'Cancel', class: 'btn-secondary', value: null },
      { label: 'Submit report', class: 'btn-danger', value: 'send' }
    ]
  }).then(async (value) => {
    if (value !== 'send') return;
    try {
      await api.report(user.id, reason, body.querySelector('[data-details]').value.trim());
      toast('Thanks — our team will take a look.');
    } catch (err) {
      toast(err.message || 'Could not send that report.', { type: 'error' });
    }
  });
}

// ---------------------------------------------------------------- matching

function showMatchModal(match, me) {
  const body = el('div', { class: 'text-center' });
  body.innerHTML = `
    <div class="relative mx-auto flex w-fit items-center justify-center gap-3 py-2">
      <img src="${escapeHtml(avatarSrc(me))}" alt="" class="avatar h-24 w-24 border-4 border-white shadow-card" />
      <span class="absolute left-1/2 top-1/2 z-10 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-brand-gradient shadow-action">
        <svg viewBox="0 0 24 24" class="h-6 w-6 fill-white" aria-hidden="true"><path d="M12 21C7 17.5 3 14.4 3 10.5 3 7.5 5.4 5 8.5 5c1.7 0 3.3.8 4.3 2.1C13.8 5.8 15.4 5 17 5c3.1 0 5.5 2.5 5.5 5.5C22.5 14.4 18.5 17.5 13.5 21L12 22l-1.5-1z"/></svg>
      </span>
      <img src="${escapeHtml(avatarSrc(match.user))}" alt="" class="avatar h-24 w-24 border-4 border-white shadow-card" />
    </div>
    <h3 class="mt-4 font-display text-3xl font-extrabold tracking-tight brand-text">It's a match!</h3>
    <p class="mt-2 text-[15px] text-ink-soft">You and ${escapeHtml(match.user.displayName)} liked each other.</p>
    <p class="mt-3 rounded-2xl bg-brand-50 px-4 py-2.5 text-[13px] font-medium text-brand-700">
      Remember: everything you send disappears after 24 hours.
    </p>`;

  openModal({
    title: '',
    body,
    actions: [
      { label: 'Keep swiping', class: 'btn-secondary', value: 'stay' },
      { label: 'Send a message', class: 'btn-primary', value: 'chat' }
    ]
  }).then((value) => {
    if (value === 'chat') location.href = `/chat?c=${match.conversationId}`;
  });
}

// ------------------------------------------------------------- decisioning

async function decide(direction) {
  if (busy || !queue.length) return;
  const user = queue[0];
  const card = stackEl.querySelector(`[data-user-id="${user.id}"]`);
  busy = true;

  queue.shift();
  history.unshift({ user, direction });
  history.length = Math.min(history.length, 10);
  if (card) flingCard(card, direction);

  // Slide the rest of the stack forward immediately so it feels instant.
  // `busy` must be cleared *before* render(), because render() ends with
  // updateActions() and that reads `busy` to decide whether the buttons are
  // disabled. Clearing it afterwards left every control permanently dead once
  // the queue stopped refilling (i.e. right after the last match).
  setTimeout(() => { busy = false; render({ skipTop: false }); }, prefersReducedMotion() ? 0 : 180);

  try {
    const result = await api.swipe(user.id, direction);
    if (result?.matched) {
      onMatch(result);
      showMatchModal(result, window.__ec_me || {});
    }
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'SESSION_EXPIRED') {
      queue.unshift(user);
      history.shift();
      render();
      toast(err.message || 'That swipe did not go through.', { type: 'error' });
    }
  } finally {
    if (queue.length <= REFILL_AT && !exhausted) loadMore();
    updateActions();
  }
}

async function rewind() {
  if (busy || !history.length) return;
  busy = true;
  const last = history[0];
  try {
    await api.rewind();
    history.shift();
    queue.unshift(last.user);
    render();
    toast(`Brought ${last.user.displayName} back.`);
  } catch (err) {
    toast(err.message || 'Nothing to rewind.', { type: 'error' });
  } finally {
    busy = false;
    updateActions();
  }
}

// ----------------------------------------------------------------- loading

async function loadMore() {
  if (loading || exhausted) return;
  loading = true;
  try {
    const { deck } = await api.deck();
    const seen = new Set(queue.map((u) => u.id));
    const fresh = (deck || []).filter((u) => !seen.has(u.id));
    if (!fresh.length) exhausted = true;
    queue.push(...fresh);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'SESSION_EXPIRED') {
      toast(err.message || 'Could not load more people.', { type: 'error' });
    }
    exhausted = true;
  } finally {
    loading = false;
    render();
  }
}

function updateActions() {
  const hasCards = queue.length > 0;
  for (const btn of $$('[data-action]', actionsEl)) {
    if (btn.dataset.action === 'rewind') btn.disabled = history.length === 0 || busy;
    else btn.disabled = !hasCards || busy;
  }
}

function renderEmpty() {
  stackEl.replaceChildren(emptyState({
    icon: `<svg viewBox="0 0 24 24" class="h-9 w-9 fill-current" aria-hidden="true"><path d="M12 21C7 17.5 3 14.4 3 10.5 3 7.5 5.4 5 8.5 5c1.7 0 3.3.8 4.3 2.1C13.8 5.8 15.4 5 17 5c3.1 0 5.5 2.5 5.5 5.5C22.5 14.4 18.5 17.5 13.5 21L12 22l-1.5-1z"/></svg>`,
    title: "That's everyone for now",
    message: 'You have seen every profile that matches your preferences. Check back soon, or widen who you want to see.',
    action: { label: 'Edit preferences', href: '/profile' }
  }));
}

function renderSkeleton() {
  const card = el('div', { class: 'swipe-card skeleton', 'aria-hidden': 'true' });
  stackEl.replaceChildren(card);
}

function render() {
  if (!stackEl) return;

  if (!queue.length) {
    if (loading) renderSkeleton();
    else renderEmpty();
    updateActions();
    return;
  }

  const wanted = queue.slice(0, STACK_SIZE);
  const existing = new Map([...stackEl.querySelectorAll('[data-user-id]')].map((n) => [n.dataset.userId, n]));

  // Remove cards no longer in the visible window.
  for (const [id, node] of existing) {
    if (!wanted.some((u) => String(u.id) === id)) node.remove();
  }

  // Deepest first so DOM order matches paint order.
  for (let depth = wanted.length - 1; depth >= 0; depth -= 1) {
    const user = wanted[depth];
    let node = existing.get(String(user.id));
    if (!node) {
      node = buildCard(user, depth);
      stackEl.prepend(node);
    } else if (Number(node.dataset.depth) !== depth) {
      node.style.transition = prefersReducedMotion() ? '' : 'transform 0.3s cubic-bezier(0.34, 1.4, 0.64, 1)';
      positionCard(node, depth);
      if (depth === 0 && !node._promoted) {
        node._promoted = true;
        node.inert = false;
        node.removeAttribute('aria-hidden');
        node.tabIndex = 0;
        makeDraggable(node);
      }
    }
  }

  // Any skeleton/empty-state leftovers.
  for (const node of stackEl.children) {
    if (!node.dataset.userId) node.remove();
  }

  updateActions();
}

// -------------------------------------------------------------------- init

export function initDeck({ stack, actions, me, onMatch: matchCb } = {}) {
  stackEl = typeof stack === 'string' ? $(stack) : stack;
  actionsEl = typeof actions === 'string' ? $(actions) : actions;
  window.__ec_me = me;
  if (typeof matchCb === 'function') onMatch = matchCb;

  const map = { rewind, pass: () => decide('pass'), superlike: () => decide('superlike'), like: () => decide('like') };
  for (const btn of $$('[data-action]', actionsEl)) {
    const fn = map[btn.dataset.action];
    if (fn) btn.addEventListener('click', fn);
  }

  // Global keyboard shortcuts when focus is not in a field.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.querySelector('.backdrop')) return;
    const keys = { ArrowLeft: 'pass', ArrowRight: 'like', ArrowUp: 'superlike' };
    if (keys[e.key]) {
      e.preventDefault();
      decide(keys[e.key]);
    } else if (e.key.toLowerCase() === 'z') {
      e.preventDefault();
      rewind();
    }
  });

  renderSkeleton();
  loadMore();
}

export function deckSize() {
  return queue.length;
}
