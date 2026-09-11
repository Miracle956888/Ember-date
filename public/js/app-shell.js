/**
 * Bootstrap shared by every authenticated page: session check, socket
 * connection, nav badges, global match/message notifications.
 */
import { api, setCsrfToken, requireSession } from './api.js';
import { connectSocket, on, emit } from './socket.js';
import { $, $$, el, toast, markActiveTab, setBadge, avatarSrc, escapeHtml, openModal } from './ui.js';
import { initI18n } from './i18n.js';
import { initThemeToggle } from '/js/theme.js';
import { initNotifications } from './notifications.js';

export const session = {
  user: null,
  config: {},
  ready: false
};

/** Guard a page: resolves with the user, or redirects to /login. */
export async function requireAuth() {
  try {
    const data = await api.me();
    session.user = data.user;
    session.config = data.config || {};
    session.ready = true;
    setCsrfToken(data.csrfToken);
    return data.user;
  } catch (err) {
    if (!requireSession(err)) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.replace(`/login?next=${next}`);
    }

    // Page scripts call this behind a top-level `await bootPage(...)`, so a
    // rejection here becomes an unhandled module rejection -- a red console
    // error with no stack. When the document is already being torn down (the
    // user tapped a link while the boot fetch was in flight, which aborts it
    // with a bare "Failed to fetch") there is nothing left to boot and nobody
    // left to tell, so resolve quietly instead. Genuine failures still throw.
    if (isNavigatingAway(err)) return new Promise(() => {});
    throw err;
  }
}

/**
 * True when a request failed because the page is unloading rather than
 * because the server said no. An aborted fetch surfaces as a TypeError with
 * no HTTP status, so a missing `status` plus a hidden/unloading document is
 * the signal.
 */
function isNavigatingAway(err) {
  const noStatus = !(err && typeof err.status === 'number');
  return noStatus && (document.visibilityState === 'hidden' || navigator.onLine === false ||
    err?.name === 'AbortError' || /Failed to fetch|NetworkError|load failed/i.test(String(err?.message || '')));
}

/** Redirect away from login/register when already signed in. */
export async function redirectIfAuthed(to = '/app') {
  try {
    const data = await api.me();
    if (data?.user) {
      const params = new URLSearchParams(location.search);
      location.replace(params.get('next') || to);
      return true;
    }
  } catch {
    /* not signed in - stay */
  }
  return false;
}

// ------------------------------------------------------------- connectivity
function mountConnectionBanner() {
  const banner = el('div', {
    class:
      'fixed inset-x-0 top-0 z-[90] hidden bg-stage px-4 py-2 text-center text-sm font-medium text-white',
    role: 'status',
    id: 'connection-banner'
  });
  document.body.prepend(banner);

  on('connection:state', ({ connected, reconnected }) => {
    if (connected) {
      if (reconnected) {
        banner.textContent = 'Back online';
        banner.classList.remove('bg-stage');
        banner.classList.add('bg-like');
        setTimeout(() => banner.classList.add('hidden'), 1600);
      } else {
        banner.classList.add('hidden');
      }
    } else {
      banner.textContent = 'Reconnecting…';
      banner.classList.remove('hidden', 'bg-like');
      banner.classList.add('bg-stage');
    }
  });
}

// --------------------------------------------------------- global notifiers
function mountGlobalNotifications() {
  const onChatPage = location.pathname.startsWith('/chat');

  on('match:new', (payload) => {
    toast(`You matched with ${payload?.user?.displayName || 'someone'}!`, { type: 'success' });
    bumpBadge('[data-badge="matches"]', 1);
  });

  on('chat:message:notify', ({ conversationId, message }) => {
    const activeConv = new URLSearchParams(location.search).get('c');
    if (onChatPage && String(activeConv) === String(conversationId)) return;

    const preview =
      message.type === 'text' ? message.body : message.type === 'image' ? '📷 Photo' : '🎥 Video';
    toast(`New message: ${preview.slice(0, 60)}`, { type: 'info' });
    bumpBadge('[data-badge="chats"]', 1);
  });

  on('call:incoming', (payload) => {
    // The chat and call pages render their own full ringing UI.
    if (location.pathname.startsWith('/call') || location.pathname.startsWith('/chat')) return;
    showIncomingCallPrompt(payload);
  });
}

let currentBadge = 0;
function bumpBadge(selector, by) {
  currentBadge += by;
  setBadge(selector, currentBadge);
}

export function resetBadge(selector) {
  currentBadge = 0;
  setBadge(selector, 0);
}

/** Lightweight cross-page ringing prompt; full UI lives on /call. */
function showIncomingCallPrompt(payload) {
  const body = el('div', { class: 'flex items-center gap-3' }, [
    el('img', {
      src: payload.from?.avatarUrl || '',
      alt: '',
      class: 'avatar h-14 w-14',
      onerror: "this.style.visibility='hidden'"
    }),
    el('div', {}, [
      el('p', { class: 'font-semibold text-ink', text: payload.from?.displayName || 'Someone' }),
      el('p', { class: 'text-sm text-ink-soft', text: 'is calling you' })
    ])
  ]);

  const dialog = openModal({
    title: 'Incoming video call',
    body,
    dismissible: false,
    actions: [
      {
        label: 'Decline',
        class: 'btn-danger',
        onClick: () => emit('call:decline', { callId: payload.callId })
      },
      {
        label: 'Answer',
        class: 'btn-primary',
        onClick: () => {
          location.href = `/call?c=${payload.conversationId}&callId=${payload.callId}&role=callee`;
        }
      }
    ]
  });

  // If the caller gives up, close the prompt.
  const stop = on('call:ended', (ended) => {
    if (ended.callId === payload.callId) {
      dialog.close?.(undefined);
      stop();
    }
  });
}

// ------------------------------------------------------------------ sign out
export function wireSignOut() {
  for (const btn of $$('[data-action="logout"]')) {
    btn.addEventListener('click', async () => {
      try {
        await api.logout();
      } catch {
        /* log out locally regardless */
      }
      // Destroy the device's private key material. On a shared computer the
      // next person must not inherit the ability to decrypt this account's
      // messages. Import lazily so pages without chat pay nothing for it.
      try {
        const { wipeKeys } = await import('./e2ee.js');
        await wipeKeys();
      } catch {
        /* best effort */
      }
      location.href = '/login';
    });
  }
}

/** Render the current user's avatar into any [data-me-avatar] slot. */
export function paintMe() {
  if (!session.user) return;
  for (const img of $$('[data-me-avatar]')) {
    img.src = avatarSrc(session.user);
    img.alt = session.user.displayName;
  }
  for (const node of $$('[data-me-name]')) {
    node.textContent = session.user.displayName;
  }
  revealModerationLink();
}

/**
 * Show the Moderation entry point only to staff.
 *
 * This is presentation only -- /api/admin enforces the real check and answers
 * 404 to everyone else -- but there is no reason to show a link that most
 * accounts cannot use.
 */
function revealModerationLink() {
  const role = session.user?.role;
  if (role !== 'moderator' && role !== 'admin') return;
  for (const node of $$('[data-staff-only]')) node.classList.remove('hidden');
}

/**
 * Standard page boot: auth gate + socket + shared chrome.
 * Pass { socket: false } for pages that do not need realtime.
 */
export async function bootPage({ socket = true, badges = true } = {}) {
  const user = await requireAuth();

  // Apply the account's language/timezone before the first paint so no date or
  // label renders in the wrong locale and then flips.
  initI18n(user);

  markActiveTab();
  wireSignOut();
  initThemeToggle();
  paintMe();
  mountConnectionBanner();

  if (socket) {
    try {
      await connectSocket();
      mountGlobalNotifications();
    } catch (err) {
      console.error('socket connect failed', err);
      toast('Realtime features are unavailable.', { type: 'error' });
    }
  }

  if (badges) {
    refreshBadges();
    // The bell lives in the shared header, so it is wired once here rather
    // than in every page entry point. `live` follows the socket flag: with no
    // socket there is nothing to subscribe to, but the badge still paints.
    initNotifications({ live: socket });
  }

  return user;
}

/**
 * Repaint the header badges.
 *
 * Every one of the eleven call sites invokes this as fire-and-forget
 * (`refreshBadges()`, never awaited), so this function must never reject: an
 * unhandled rejection surfaces as a `pageerror` and, in a real browser, as a
 * red console entry the user can see. A page unloading mid-flight is the
 * common trigger -- the in-flight fetch aborts with "Failed to fetch" -- and a
 * cosmetic badge is never worth an error. Hence the outer try/catch on top of
 * the per-call allSettled, which only covers the two requests and not the
 * DOM writes that follow.
 */
export async function refreshBadges() {
  try {
    // Two independent calls: a failure in one must not blank the other.
    const [matches, counters] = await Promise.allSettled([api.matches(), api.counters()]);

    if (matches.status === 'fulfilled') {
      // Two different counts for two different tabs: Chats carries unread
      // messages, Matches carries matches nobody has spoken to yet.
      currentBadge = matches.value.totalUnread || 0;
      setBadge('[data-badge="chats"]', currentBadge);
      const pending = (matches.value.matches || []).filter((m) => !m.lastMessage).length;
      setBadge('[data-badge="matches"]', pending);
    }
    if (counters.status === 'fulfilled') {
      const { likes = 0, taps = 0 } = counters.value;
      setBadge('[data-badge="likes"]', likes + taps);
    }
  } catch {
    /* badges are decorative: never let them raise into an unhandled rejection */
  }
}

/** Small helper for pages that render an empty state. */
export function emptyState({ icon = '✨', title, message, action }) {
  // `icon` may be an emoji/text or a trusted inline SVG string.
  const iconNode = el('div', {
    class: 'mb-4 grid h-20 w-20 place-items-center rounded-full bg-brand-50 text-4xl text-brand-primary',
    'aria-hidden': 'true'
  });
  if (typeof icon === 'string' && icon.trim().startsWith('<')) iconNode.innerHTML = icon;
  else iconNode.textContent = icon;

  const wrap = el('div', { class: 'flex flex-col items-center justify-center px-8 py-16 text-center' }, [
    iconNode,
    el('h2', { class: 'mb-1.5 text-xl font-bold text-ink', text: title }),
    el('p', { class: 'max-w-xs text-[15px] leading-relaxed text-ink-soft', text: message })
  ]);
  if (action) {
    wrap.append(
      el('a', { href: action.href, class: 'btn-primary mt-6', text: action.label })
    );
  }
  return wrap;
}

export { escapeHtml, $, $$, el };
