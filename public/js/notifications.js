/**
 * notifications.js — the notification centre.
 *
 * A bell in the header opens a sheet listing everything that happened while
 * you were away. Three decisions worth recording:
 *
 * 1. **The list is the source of truth, the socket is only a hint.** The
 *    server pushes `notification:new` carrying nothing but a kind and an
 *    unread count, so a stale tab can update its badge without ever holding
 *    notification content it may no longer be allowed to see (the sender
 *    could have been blocked in the meantime). Detail is fetched on open.
 * 2. **Opening marks read, tapping navigates.** Anything else forces people
 *    to tidy a list by hand, which nobody does.
 * 3. **Coalesced rows render as "and N others"** rather than N rows, matching
 *    the server-side `group_key` behaviour.
 */
import { api } from './api.js';
import { el, escapeHtml, timeAgo, toast, openModal, avatarSrc, initialsAvatar } from './ui.js';
import { on } from './socket.js';

/** Icon + accent per kind. Text labels, never emoji-only: the browser test
 *  environment has no emoji font, and screen readers read these out. */
const KIND_META = {
  match: { label: 'New match', accent: 'bg-brand-50 text-brand-primary', icon: 'M12 21C7 17.5 3 14.4 3 10.5 3 7.5 5.4 5 8.5 5c1.7 0 3.3.8 4.3 2.1C13.8 5.8 15.4 5 17 5c3.1 0 5.5 2.5 5.5 5.5C22.5 14.4 18.5 17.5 13.5 21L12 22l-1.5-1z' },
  message: { label: 'Message', accent: 'bg-sky-50 text-sky-600', icon: 'M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z' },
  profile_like: { label: 'Profile like', accent: 'bg-rose-50 text-rose-600', icon: 'M12 21C7 17.5 3 14.4 3 10.5 3 7.5 5.4 5 8.5 5c1.7 0 3.3.8 4.3 2.1C13.8 5.8 15.4 5 17 5c3.1 0 5.5 2.5 5.5 5.5C22.5 14.4 18.5 17.5 13.5 21L12 22l-1.5-1z' },
  photo_like: { label: 'Photo like', accent: 'bg-rose-50 text-rose-600', icon: 'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM9 2l-1.7 2H4a2 2 0 00-2 2v13a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2h-3.3L15 2H9z' },
  post_like: { label: 'Post like', accent: 'bg-rose-50 text-rose-600', icon: 'M12 21C7 17.5 3 14.4 3 10.5 3 7.5 5.4 5 8.5 5c1.7 0 3.3.8 4.3 2.1C13.8 5.8 15.4 5 17 5c3.1 0 5.5 2.5 5.5 5.5C22.5 14.4 18.5 17.5 13.5 21L12 22l-1.5-1z' },
  post_comment: { label: 'Comment', accent: 'bg-violet-50 text-violet-600', icon: 'M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z' },
  comment_reply: { label: 'Reply', accent: 'bg-violet-50 text-violet-600', icon: 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z' },
  moment_reaction: { label: 'Moment', accent: 'bg-amber-50 text-amber-600', icon: 'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM9 2l-1.7 2H4a2 2 0 00-2 2v13a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2h-3.3L15 2H9z' },
  moment_reply: { label: 'Moment reply', accent: 'bg-amber-50 text-amber-600', icon: 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z' },
  verification: { label: 'Verification', accent: 'bg-emerald-50 text-emerald-600', icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
  safety: { label: 'Safety', accent: 'bg-emerald-50 text-emerald-600', icon: 'M12 2l8 4v6c0 5-3.4 9.4-8 10-4.6-.6-8-5-8-10V6l8-4z' },
  system: { label: 'Ember', accent: 'bg-surface-grey text-ink-soft', icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z' }
};

/**
 * Human sentence for a row, falling back to the server-supplied body.
 *
 * Coalescing counts *events*, not people, so "and N others" is only honest
 * for kinds where each actor can contribute at most once — a like, a
 * reaction. A conversation is 1:1, so twenty-two coalesced messages are
 * twenty-two messages from one person, not twenty-two people; and several
 * comments on one post may come from one person or many, so those are phrased
 * without claiming who. Getting this wrong reads as a bug to the user.
 */

/** Kinds where one actor can only ever contribute a single event. */
const ONE_PER_ACTOR = new Set(['profile_like', 'photo_like', 'post_like', 'moment_reaction', 'match']);

const SINGLE_VERB = {
  match: 'matched with you',
  message: 'sent you a message',
  profile_like: 'liked your profile',
  photo_like: 'liked your photo',
  post_like: 'liked your post',
  post_comment: 'commented on your post',
  comment_reply: 'replied to your comment',
  moment_reaction: 'reacted to your moment',
  moment_reply: 'replied to your moment'
};

/** Phrasing for a coalesced group whose actors are ambiguous. */
const GROUP_PHRASE = {
  message: (n) => `sent you ${n.count} messages`,
  post_comment: (n) => `${n.count} new comments on your post`,
  comment_reply: (n) => `${n.count} new replies to your comment`,
  moment_reply: (n) => `${n.count} new replies to your moment`
};

function sentence(n) {
  const who = n.actor?.displayName || 'Someone';
  const strong = (t) => `<strong class="font-semibold">${escapeHtml(t)}</strong>`;

  // A server-supplied body wins ONLY where the client cannot derive the
  // sentence itself: safety and verification rows are written server-side and
  // must not be re-phrased. For the interaction kinds the stored body is just
  // a copy of the singular verb, and letting it win here would hide the
  // coalesced count ("sent you a message" for a burst of twenty-two).
  const derivable = Object.prototype.hasOwnProperty.call(SINGLE_VERB, n.kind);
  if (n.body && !derivable) {
    return n.actor ? `${strong(who)} ${escapeHtml(n.body)}` : escapeHtml(n.body);
  }

  const single = SINGLE_VERB[n.kind] || 'sent you an update';
  if (!(n.count > 1)) return `${strong(who)} ${escapeHtml(single)}`;

  // Several events under one group key.
  if (ONE_PER_ACTOR.has(n.kind)) {
    // Each actor counted once, so the extra events really are other people.
    const others = ` and ${n.count - 1} other${n.count > 2 ? 's' : ''}`;
    return `${strong(who)}${escapeHtml(others)} ${escapeHtml(single)}`;
  }

  const phrase = GROUP_PHRASE[n.kind];
  if (!phrase) return `${strong(who)} ${escapeHtml(single)}`;

  // "sent you 22 messages" keeps the actor; the neutral counts do not, because
  // we cannot tell from the count alone whether one person or several acted.
  return n.kind === 'message'
    ? `${strong(who)} ${escapeHtml(phrase(n))}`
    : escapeHtml(phrase(n));
}

function row(n) {
  const meta = KIND_META[n.kind] || KIND_META.system;
  const avatar = n.actor ? (avatarSrc(n.actor) || initialsAvatar(n.actor.displayName, n.actor.id)) : null;

  const node = el('a', {
    href: n.href || '#',
    'data-notification': String(n.id),
    class: `flex items-start gap-3 rounded-2xl px-3 py-3 transition hover:bg-surface-grey ${
      n.read ? '' : 'bg-brand-50/60'
    }`
  });

  node.innerHTML = `
    <span class="relative shrink-0">
      ${
        avatar
          ? `<img loading="lazy" decoding="async" src="${escapeHtml(avatar)}" alt="" class="avatar h-11 w-11" />`
          : `<span class="grid h-11 w-11 place-items-center rounded-full ${meta.accent}">
               <svg viewBox="0 0 24 24" class="h-5 w-5 fill-current" aria-hidden="true"><path d="${meta.icon}"/></svg>
             </span>`
      }
      <span class="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-surface ${meta.accent}">
        <svg viewBox="0 0 24 24" class="h-2.5 w-2.5 fill-current" aria-hidden="true"><path d="${meta.icon}"/></svg>
      </span>
    </span>
    <span class="min-w-0 flex-1">
      <span class="block text-[14px] leading-snug text-ink">${sentence(n)}</span>
      <span class="mt-0.5 block text-[12px] text-ink-faint">${escapeHtml(meta.label)} &middot; ${escapeHtml(timeAgo(n.createdAt))}</span>
    </span>
    ${n.read ? '' : '<span class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-primary" aria-label="Unread"></span>'}`;

  return node;
}

function skeleton() {
  const wrap = el('div', { class: 'space-y-2 py-2' });
  for (let i = 0; i < 4; i += 1) {
    const s = el('div', { class: 'flex items-center gap-3 px-3 py-3' });
    s.innerHTML = `
      <span class="h-11 w-11 shrink-0 animate-pulse rounded-full bg-surface-grey"></span>
      <span class="flex-1 space-y-2">
        <span class="block h-3 w-2/3 animate-pulse rounded bg-surface-grey"></span>
        <span class="block h-2.5 w-1/3 animate-pulse rounded bg-surface-grey"></span>
      </span>`;
    wrap.append(s);
  }
  return wrap;
}

/** Paint the bell badge everywhere it appears. */
function paintBadge(count) {
  for (const badge of document.querySelectorAll('[data-badge="notifications"]')) {
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

let cachedUnread = 0;

export async function refreshNotificationBadge() {
  try {
    const { unread } = await api.unreadNotifications();
    cachedUnread = unread || 0;
    paintBadge(cachedUnread);
  } catch {
    /* a badge is not worth a toast */
  }
}

export async function openNotifications() {
  const body = el('div', { class: '-mx-2' });
  body.append(skeleton());

  // Opened via openModal so we inherit the focus trap, Escape-to-close and
  // the shared .sheet geometry (which is transform-free -- see the
  // animate-pop-in incident).
  const closed = openModal({
    title: 'Notifications',
    body,
    dismissible: true,
    labelledBy: 'notifications-title',
    actions: [
      {
        label: 'Mark all read',
        class: 'btn-ghost',
        onClick: async () => {
          try {
            await api.markNotificationsRead();
            cachedUnread = 0;
            paintBadge(0);
            for (const r of body.querySelectorAll('[data-notification]')) {
              r.classList.remove('bg-brand-50/60');
              r.querySelector('[aria-label="Unread"]')?.remove();
            }
            toast('All caught up.');
          } catch {
            toast('Could not mark those as read.');
          }
          return false; // keep the sheet open
        }
      },
      { label: 'Close', class: 'btn-secondary' }
    ]
  });

  try {
    const { notifications = [] } = await api.notifications({ limit: 30 });
    body.textContent = '';

    if (!notifications.length) {
      const empty = el('div', { class: 'px-4 py-12 text-center' });
      empty.innerHTML = `
        <div class="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-brand-50 text-brand-primary">
          <svg viewBox="0 0 24 24" class="h-7 w-7 fill-current" aria-hidden="true"><path d="M12 22a2.5 2.5 0 002.45-2h-4.9A2.5 2.5 0 0012 22zm7-6v-5a7 7 0 00-5.5-6.83V3.5a1.5 1.5 0 00-3 0v.67A7 7 0 005 11v5l-2 2v1h18v-1l-2-2z"/></svg>
        </div>
        <p class="text-[15px] font-semibold text-ink">Nothing yet</p>
        <p class="mt-1 text-[13px] text-ink-soft">Matches, messages and reactions will show up here.</p>`;
      body.append(empty);
    } else {
      const list = el('div', { class: 'space-y-1' });
      for (const n of notifications) list.append(row(n));
      body.append(list);
    }

    // Opening the centre IS the read receipt -- but only for the rows the
    // user actually just saw. Marking *everything* read here is a race: a
    // notification that arrives between the fetch and the mark would be
    // silently swallowed, and the user would never learn about it. Passing
    // explicit ids means anything newer stays unread and keeps its badge.
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    if (unreadIds.length) {
      api.markNotificationsRead(unreadIds)
        .then(({ unread }) => {
          cachedUnread = Number(unread) || 0;
          paintBadge(cachedUnread);
        })
        .catch(() => {});
    }
  } catch {
    body.textContent = '';
    const err = el('p', { class: 'px-4 py-10 text-center text-[14px] text-ink-soft' },
      'Could not load your notifications. Pull down to try again.');
    body.append(err);
  }

  await closed;
}

/**
 * Wire every [data-action="notifications"] button, keep the badge fresh, and
 * subscribe to live pushes.
 */
export function initNotifications({ live = true } = {}) {
  for (const btn of document.querySelectorAll('[data-action="notifications"]')) {
    btn.addEventListener('click', () => openNotifications());
  }

  refreshNotificationBadge();

  if (live) {
    // `on()` from socket.js survives reconnects, unlike a raw socket.on
    // captured at boot.
    on('notification:new', (payload) => {
      // Trust the server's count rather than incrementing locally: coalescing
      // means "one more event" does not always mean "one more unread".
      if (typeof payload?.unread === 'number') {
        cachedUnread = payload.unread;
        paintBadge(cachedUnread);
      } else {
        refreshNotificationBadge();
      }
    });
  }
}
