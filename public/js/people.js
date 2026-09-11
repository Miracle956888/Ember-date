/**
 * people.js — the shared person tile used by every browse surface
 * (Nearby, Bumped into, Likes you, Visitors, Favourites, Taps, Top Picks).
 *
 * One renderer keeps those seven screens visually identical and means a fix to
 * the badge logic lands everywhere at once. Each surface only supplies its own
 * "meta" line and which quick actions to show.
 */
import { api, ApiError } from './api.js';
import { escapeHtml, avatarSrc, initialsAvatar, toast, timeAgo, openModal, html } from './ui.js';

const INTENT_LABELS = {
  long_term: 'Long-term',
  short_term: 'Something casual',
  friends: 'New friends',
  figuring_out: 'Still figuring it out'
};

export function intentLabel(intent) {
  return INTENT_LABELS[intent] || null;
}

/** Blue verification tick. Inline SVG so CSP and the offline preview are happy. */
export function verifiedBadge(size = 'h-4 w-4') {
  return `<svg viewBox="0 0 24 24" class="${size} shrink-0 fill-superlike" aria-label="Verified profile" role="img">
    <path d="M12 2l2.4 1.8 3-.3 1 2.8 2.6 1.5-.9 2.9.9 2.9-2.6 1.5-1 2.8-3-.3L12 22l-2.4-1.8-3 .3-1-2.8-2.6-1.5.9-2.9-.9-2.9 2.6-1.5 1-2.8 3 .3L12 2z"/>
    <path d="M10.6 15.4l-3-3 1.4-1.4 1.6 1.6 4.4-4.4 1.4 1.4-5.8 5.8z" fill="#fff"/>
  </svg>`;
}

function onlineMark(person) {
  if (!person.isOnline) return '';
  return '<span class="online-dot absolute right-2 top-2 z-10 ring-2 ring-white" aria-label="Online now"></span>';
}

function sharedInterestChips(person, max = 2) {
  const shared = person.sharedInterests || [];
  if (!shared.length) return '';
  const shown = shared.slice(0, max);
  const extra = shared.length - shown.length;
  return `<div class="mt-1.5 flex flex-wrap gap-1">
    ${shown
      .map(
        (i) =>
          `<span class="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
             ${i.emoji ? `${escapeHtml(i.emoji)} ` : ''}${escapeHtml(i.label)}
           </span>`
      )
      .join('')}
    ${extra > 0 ? `<span class="rounded-full bg-surface-grey px-2 py-0.5 text-[11px] font-semibold text-ink-soft">+${extra}</span>` : ''}
  </div>`;
}

/**
 * Match reasons — the "why am I seeing this person" line.
 *
 * The server decides *what* is worth saying and in what order; the client only
 * decides how much fits. On a tile that is one reason, because a grid cell
 * that shouts loses its scannability.
 */
export function reasonChips(person, max = 1) {
  const reasons = person.reasons || [];
  if (!reasons.length) return '';
  return `<ul class="mt-1.5 flex flex-wrap gap-1" aria-label="Why you might get on">
    ${reasons
      .slice(0, max)
      .map(
        (r) =>
          `<li class="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5
                      text-[11px] font-semibold text-brand-700">
             <span aria-hidden="true">${escapeHtml(r.icon)}</span>
             <span class="truncate">${escapeHtml(r.text)}</span>
           </li>`
      )
      .join('')}
  </ul>`;
}

/** The full reason list, for a profile page where there is room to breathe. */
export function reasonList(person) {
  const reasons = person.reasons || [];
  if (!reasons.length) return '';
  return `<ul class="flex flex-wrap gap-1.5" aria-label="Why you might get on">
    ${reasons
      .map(
        (r) =>
          `<li class="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1
                      text-[13px] font-semibold text-brand-700">
             <span aria-hidden="true">${escapeHtml(r.icon)}</span>${escapeHtml(r.text)}
           </li>`
      )
      .join('')}
  </ul>`;
}

/**
 * A grid tile.
 * @param {object} person   decorated user from the API
 * @param {object} opts
 * @param {string} opts.meta        small line under the name
 * @param {string} opts.source      where the click came from (for Visitors)
 * @param {boolean} opts.showLike   render the like button
 */
export function personCard(person, { meta = '', source = 'direct', showLike = true } = {}) {
  const photo = person.photos?.[0]?.url || person.avatarUrl || initialsAvatar(person.displayName, person.id);
  const metaLine = meta || person.distance || person.city || '';

  return `
  <article class="group relative overflow-hidden rounded-3xl bg-surface shadow-card transition hover:shadow-lift"
           data-person="${person.id}">
    ${onlineMark(person)}
    <a href="/profile?id=${person.id}&from=${escapeHtml(source)}" class="block focus-visible:outline-none"
       data-person-open="${person.id}" aria-label="View ${escapeHtml(person.displayName)}'s profile">
      <div class="relative aspect-[4/5] overflow-hidden bg-surface-grey">
        <img src="${escapeHtml(photo)}" alt="" loading="lazy" decoding="async"
             class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" />
        ${person.boosted ? '<span class="absolute left-2 top-2 rounded-full bg-boost px-2 py-0.5 text-[11px] font-bold text-white shadow">Boosted</span>' : ''}
      </div>
      <div class="p-3">
        <h3 class="flex items-center gap-1 truncate text-[15px] font-bold text-ink">
          <span class="truncate">${escapeHtml(person.displayName)}</span>
          ${person.age ? `<span class="font-semibold text-ink-soft">${person.age}</span>` : ''}
          ${person.isVerified ? verifiedBadge('h-4 w-4') : ''}
        </h3>
        ${metaLine ? `<p class="mt-0.5 truncate text-[13px] text-ink-soft">${escapeHtml(metaLine)}</p>` : ''}
        ${person.reasons?.length ? reasonChips(person) : sharedInterestChips(person)}
      </div>
    </a>

    <div class="flex items-center gap-1.5 border-t border-hairline/[var(--hairline-a)] px-3 py-2">
      <button type="button" class="tile-action" data-tile-action="tap" data-id="${person.id}"
              aria-label="Send a wave to ${escapeHtml(person.displayName)}" title="Send a wave">
        <svg viewBox="0 0 24 24" class="h-[18px] w-[18px] fill-current" aria-hidden="true"><path d="M12 2a2 2 0 012 2v6h1V6a2 2 0 114 0v9a7 7 0 01-7 7h-1a7 7 0 01-7-7v-4a2 2 0 114 0v-1a2 2 0 114 0V4a2 2 0 012-2z"/></svg>
      </button>
      <button type="button" class="tile-action ${person.isFavorite ? 'is-on' : ''}"
              data-tile-action="favorite" data-id="${person.id}" aria-pressed="${person.isFavorite ? 'true' : 'false'}"
              aria-label="${person.isFavorite ? 'Remove from' : 'Add to'} favourites" title="Favourite">
        <svg viewBox="0 0 24 24" class="h-[18px] w-[18px] ${person.isFavorite ? 'fill-current' : 'fill-none stroke-current'}" stroke-width="2" aria-hidden="true"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>
      </button>
      ${
  showLike && !person.matched
    ? `<button type="button" class="tile-action tile-action-like ml-auto" data-tile-action="like" data-id="${person.id}"
                 aria-label="Like ${escapeHtml(person.displayName)}" title="Like">
             <svg viewBox="0 0 24 24" class="h-[18px] w-[18px] fill-current" aria-hidden="true"><path d="M12 21C7 17.5 3 14.4 3 10.5 3 7.5 5.4 5 8.5 5c1.7 0 3.3.8 4.3 2.1C13.8 5.8 15.4 5 17 5c3.1 0 5.5 2.5 5.5 5.5C22.5 14.4 18.5 17.5 13.5 21L12 22l-1.5-1z"/></svg>
           </button>`
    : person.matched
      ? '<span class="ml-auto rounded-full bg-like/10 px-2 py-1 text-[11px] font-bold text-like">Matched</span>'
      : ''
}
    </div>
  </article>`;
}

/** Render a list of people into a container, or an empty state. */
export function renderPeople(container, people, opts = {}) {
  if (!people.length) {
    container.innerHTML = `
      <div class="col-span-full grid place-items-center px-6 py-14 text-center">
        <div class="mb-3 grid h-14 w-14 place-items-center rounded-3xl bg-brand-50 text-2xl">${opts.emptyIcon || '✨'}</div>
        <h2 class="text-lg font-bold text-ink">${escapeHtml(opts.emptyTitle || 'Nothing here yet')}</h2>
        <p class="mt-1 max-w-xs text-[14px] text-ink-soft">${escapeHtml(opts.emptyMessage || 'Check back a little later.')}</p>
      </div>`;
    return;
  }
  container.innerHTML = people
    .map((p) => personCard(p, { ...opts, meta: opts.metaFor ? opts.metaFor(p) : '' }))
    .join('');
}

/**
 * Wire the quick actions. Delegated once per container, so re-rendering the
 * grid never needs re-binding.
 */
export function wirePeopleActions(container, { onMatch, onChanged } = {}) {
  container.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-tile-action]');
    if (!button) return;
    event.preventDefault();

    const id = Number(button.dataset.id);
    const action = button.dataset.tileAction;
    if (!id || button.disabled) return;

    button.disabled = true;
    try {
      if (action === 'like') {
        const result = await api.swipe(id, 'like');
        const tile = button.closest('[data-person]');
        if (result.matched) {
          onMatch?.(result);
          if (tile) {
            const bar = tile.querySelector('.border-t');
            if (bar) {
              bar.innerHTML =
                '<span class="ml-auto rounded-full bg-like/10 px-2 py-1 text-[11px] font-bold text-like">Matched</span>';
            }
          }
        } else {
          toast('Liked.');
          button.classList.add('is-on');
        }
      } else if (action === 'favorite') {
        const on = button.getAttribute('aria-pressed') === 'true';
        if (on) {
          await api.removeFavorite(id);
          button.setAttribute('aria-pressed', 'false');
          button.classList.remove('is-on');
          button.querySelector('svg')?.classList.replace('fill-current', 'fill-none');
          toast('Removed from favourites.');
        } else {
          await api.addFavorite(id);
          button.setAttribute('aria-pressed', 'true');
          button.classList.add('is-on');
          button.querySelector('svg')?.classList.replace('fill-none', 'fill-current');
          toast('Added to favourites.');
        }
        onChanged?.();
      } else if (action === 'tap') {
        await api.sendTap(id, 'wave');
        button.classList.add('is-on');
        toast('Wave sent 👋');
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work.', { type: 'error' });
    } finally {
      button.disabled = false;
    }
  });
}

/** The celebratory modal shown when a like turns into a match. */
export function matchModal(result) {
  const user = result.user || {};
  openModal({
    title: 'It’s a match!',
    body: html(`
      <div class="text-center">
        <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(user))}" alt="" class="mx-auto h-24 w-24 rounded-full object-cover ring-4 ring-brand-50" />
        <p class="mt-3 text-[15px] text-ink-soft">
          You and <strong class="text-ink">${escapeHtml(user.displayName || 'they')}</strong> liked each other.
        </p>
        <p class="mt-1 text-[13px] text-ink-faint">Remember: messages disappear after 24 hours.</p>
      </div>`),
    actions: [
      { label: 'Keep browsing', value: 'close' },
      {
        label: 'Send a message',
        value: 'chat',
        class: 'btn-primary',
        onClick: () => {
          if (result.conversationId) location.href = `/chat?c=${result.conversationId}`;
        }
      }
    ]
  });
}

export { timeAgo };
