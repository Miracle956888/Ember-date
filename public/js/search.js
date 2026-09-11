/**
 * search.js — find a specific person by their username.
 *
 * Opens a sheet with a debounced search box. Results show the handle, a photo
 * and the current relationship, so the two useful actions are always one tap
 * away: "Like" for someone new (which can immediately produce a match if they
 * already liked you) and "Message" for someone you have already matched with.
 */
import { api, ApiError } from './api.js';
import { el, escapeHtml, toast, openModal, avatarSrc, initialsAvatar } from './ui.js';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

let onMatch = () => {};

function photoFor(user) {
  const first = (user.photos || []).find((p) => p && p.url);
  if (first) return first.url;
  return avatarSrc(user) || initialsAvatar(user.displayName, user.id);
}

/** Copy of the deck's match celebration, minus the deck-specific bits. */
function celebrate(match, me) {
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
      { label: 'Not now', value: 'stay', class: 'btn-secondary' },
      { label: 'Send a message', value: 'chat', class: 'btn-primary' }
    ]
  }).then((value) => {
    if (value === 'chat') location.href = `/chat?c=${match.conversationId}`;
  });
}

function resultRow(user, me, refresh) {
  const row = el('li', {
    class: 'flex items-center gap-3 rounded-3xl px-2 py-2 transition hover:bg-surface-grey'
  });

  const img = el('img', {
    src: photoFor(user),
    alt: '',
    class: 'avatar h-12 w-12 shrink-0'
  });

  const meta = el('div', { class: 'min-w-0 flex-1' });
  meta.innerHTML = `
    <p class="truncate text-[15px] font-semibold text-ink">
      ${escapeHtml(user.displayName)}${user.age ? `<span class="ml-1 font-medium text-ink-soft">${escapeHtml(String(user.age))}</span>` : ''}
      ${user.isOnline ? '<span class="ml-1.5 inline-block h-2 w-2 rounded-full bg-like align-middle" title="Online now"></span>' : ''}
    </p>
    <p class="truncate text-[13px] font-medium text-brand-primary">@${escapeHtml(user.username)}</p>
    ${user.city ? `<p class="truncate text-[12px] text-ink-faint">${escapeHtml(user.city)}</p>` : ''}`;

  let action;
  if (user.matched && user.conversationId) {
    action = el('a', {
      href: `/chat?c=${user.conversationId}`,
      class: 'btn-secondary shrink-0 !px-4 !py-2 text-sm',
      text: 'Message'
    });
  } else if (user.myDirection === 'like' || user.myDirection === 'superlike') {
    action = el('span', {
      class: 'shrink-0 rounded-full bg-surface-cool px-4 py-2 text-sm font-semibold text-ink-soft',
      text: 'Liked'
    });
  } else {
    action = el('button', {
      type: 'button',
      class: 'btn-primary shrink-0 !px-4 !py-2 text-sm',
      text: 'Like',
      onClick: async () => {
        action.disabled = true;
        action.textContent = '…';
        try {
          const res = await api.swipe(user.id, 'like');
          if (res.matched) {
            onMatch(res);
            celebrate(res, me);
          } else {
            toast(`Liked @${user.username}. If they like you back, it's a match.`);
          }
          user.myDirection = 'like';
          user.matched = Boolean(res.matched);
          user.conversationId = res.conversationId || null;
          refresh();
        } catch (err) {
          action.disabled = false;
          action.textContent = 'Like';
          toast(err instanceof ApiError ? err.message : 'Could not send that like.', { type: 'error' });
        }
      }
    });
  }

  row.append(img, meta, action);
  return row;
}

export function openSearch(me) {
  const body = el('div', { class: 'text-left' });
  body.innerHTML = `
    <label class="label" for="user-search">Find someone by username</label>
    <div class="relative">
      <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[15px] font-semibold text-ink-soft" aria-hidden="true">@</span>
      <input class="field pl-8" type="search" id="user-search" autocomplete="off" autocapitalize="none"
             autocorrect="off" spellcheck="false" placeholder="theirhandle" aria-describedby="search-hint" autofocus />
    </div>
    <p class="hint mt-1.5" id="search-hint">Know their handle? Like them directly — no swiping required.</p>
    <div class="mt-4 min-h-[180px]" id="search-results" role="status" aria-live="polite"></div>`;

  const modal = openModal({
    title: 'Search',
    body,
    actions: [{ label: 'Close', value: 'close', class: 'btn-secondary' }]
  });

  const input = body.querySelector('#user-search');
  const results = body.querySelector('#search-results');
  let timer = null;
  let seq = 0;
  let latest = [];

  const note = (text, muted = true) =>
    results.replaceChildren(
      el('p', { class: `py-8 text-center text-[14px] ${muted ? 'text-ink-faint' : 'text-ink-soft'}`, text })
    );

  function paint() {
    if (!latest.length) return;
    const list = el('ul', { class: 'flex flex-col gap-1' });
    for (const user of latest) list.append(resultRow(user, me, paint));
    results.replaceChildren(list);
  }

  async function run(term) {
    const mine = ++seq;
    results.replaceChildren(
      el('div', { class: 'flex flex-col gap-2 py-1' }, [
        el('div', { class: 'skeleton h-16 rounded-3xl' }),
        el('div', { class: 'skeleton h-16 rounded-3xl' })
      ])
    );
    try {
      const res = await api.searchUsers(term, 10);
      if (mine !== seq) return;                 // a newer keystroke won
      latest = res.results || [];
      if (!latest.length) {
        note(`No one goes by "${term}". Check the spelling — handles are exact.`);
        return;
      }
      paint();
    } catch (err) {
      if (mine !== seq) return;
      note(err instanceof ApiError ? err.message : 'Search is unavailable right now.', false);
    }
  }

  note('Start typing a username.');

  input.addEventListener('input', () => {
    const term = input.value.trim().toLowerCase().replace(/^@+/, '');
    clearTimeout(timer);
    seq += 1;                                   // cancel any in-flight paint
    if (term.length < MIN_CHARS) {
      latest = [];
      note('Type at least 2 characters.');
      return;
    }
    timer = setTimeout(() => run(term), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(timer);
    const term = input.value.trim().toLowerCase().replace(/^@+/, '');
    if (term.length >= MIN_CHARS) run(term);
  });

  return modal;
}

/**
 * Wire every [data-action="search"] button on the page.
 * `onMatch` lets the host page refresh its badges when a search-then-like
 * turns into a match.
 */
export function initSearch({ me, onMatch: cb } = {}) {
  if (typeof cb === 'function') onMatch = cb;
  for (const btn of document.querySelectorAll('[data-action="search"]')) {
    btn.addEventListener('click', () => openSearch(me));
  }
  // "/" focuses search, the way most chat apps do it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.querySelector('.sheet')) return;
    e.preventDefault();
    openSearch(me);
  });
}
