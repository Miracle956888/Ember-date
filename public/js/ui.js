/**
 * Shared UI primitives: toasts, modals, time formatting, avatars, nav.
 * No framework - just small composable helpers over the DOM.
 */

import { t, formatDate, formatTime } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Escape user content before it ever touches innerHTML. */
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

export const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ toasts
let toastHost = null;

function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = el('div', {
    class: 'pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-4',
    role: 'status',
    'aria-live': 'polite'
  });
  document.body.append(toastHost);
  return toastHost;
}

export function toast(message, { type = 'info', duration = 3200 } = {}) {
  const host = ensureToastHost();
  const icon = { success: '✓', error: '!', info: 'i' }[type] || 'i';
  const tone =
    type === 'error' ? 'bg-nope' : type === 'success' ? 'bg-like' : 'bg-stage';

  const node = el('div', { class: `toast ${tone} animate-fade-up max-w-[92vw]` }, [
    el('span', {
      class: 'grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/25 text-[11px] font-bold',
      text: icon
    }),
    el('span', { text: message })
  ]);

  host.append(node);
  const remove = () => {
    node.style.transition = 'opacity .25s ease, transform .25s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(-6px)';
    setTimeout(() => node.remove(), 260);
  };
  const timer = setTimeout(remove, duration);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  return remove;
}

// ------------------------------------------------------------------ modals
/**
 * Accessible modal: focus trap, Escape to close, restores focus on exit.
 */
/**
 * Build a detached element from trusted markup, for use as an openModal body.
 * openModal treats a string body as plain text (it escapes it), which is the
 * safe default; pass html(...) when the markup is ours.
 */
export function html(markup) {
  const wrap = document.createElement('div');
  wrap.innerHTML = markup;
  return wrap;
}

export function openModal({ title, body, actions = [], dismissible = true, labelledBy } = {}) {
  const previouslyFocused = document.activeElement;

  const backdrop = el('div', { class: 'backdrop animate-fade-up' });
  const panel = el('div', {
    class: 'sheet animate-pop-in',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': labelledBy ? null : title || 'Dialog'
  });

  if (title) {
    panel.append(el('h2', { class: 'mb-2 text-xl font-bold text-ink', text: title }));
  }
  if (body) {
    panel.append(typeof body === 'string' ? el('p', { class: 'text-[15px] text-ink-soft', text: body }) : body);
  }

  const close = (result) => {
    backdrop.remove();
    panel.remove();
    document.removeEventListener('keydown', onKey, true);
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    if (typeof panel._resolve === 'function') panel._resolve(result);
  };

  if (actions.length) {
    const row = el('div', { class: 'mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end' });
    for (const action of actions) {
      row.append(
        el('button', {
          type: 'button',
          class: `${action.class || 'btn-secondary'} sm:w-auto w-full`,
          text: action.label,
          onClick: async () => {
            if (action.onClick) {
              const result = await action.onClick();
              if (result === false) return;
            }
            close(action.value);
          }
        })
      );
    }
    panel.append(row);
  }

  function onKey(e) {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      close(undefined);
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = $$(
      'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      panel
    ).filter((n) => n.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (dismissible) backdrop.addEventListener('click', () => close(undefined));
  document.addEventListener('keydown', onKey, true);

  document.body.append(backdrop, panel);
  const focusTarget = $('[autofocus]', panel) || $('button,input,textarea', panel);
  if (focusTarget) focusTarget.focus();
  else panel.focus();

  const promise = new Promise((resolve) => {
    panel._resolve = resolve;
  });
  promise.close = close;
  promise.panel = panel;
  return promise;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return openModal({
    title,
    body: message,
    actions: [
      { label: 'Cancel', value: false, class: 'btn-secondary' },
      { label: confirmLabel, value: true, class: danger ? 'btn-danger' : 'btn-primary' }
    ]
  }).then((v) => v === true);
}

// -------------------------------------------------------------------- time
export function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return t('time.now');
  const mins = Math.round(secs / 60);
  if (mins < 60) return t('time.minutes', { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('time.hours', { n: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t('time.days', { n: days });
  // Older than a week: an absolute date, in the viewer's locale AND zone.
  return formatDate(iso);
}

export function clockTime(iso) {
  return formatTime(iso);
}

export function formatDuration(totalSecs) {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Countdown text for the 24h expiry chips.
 * Returns { text, state } where state drives the amber/red styling.
 */
export function formatRemaining(expiresAt, skewMs = 0) {
  const remaining = new Date(expiresAt).getTime() - (Date.now() + skewMs);
  if (remaining <= 0) return { text: 'gone', state: 'urgent', expired: true, ms: 0 };

  const totalSecs = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  let text;
  if (hours >= 1) text = `${hours}h ${mins}m`;
  else if (mins >= 10) text = `${mins}m`;
  else text = `${mins}:${String(secs).padStart(2, '0')}`;

  const state = remaining < 10 * 60 * 1000 ? 'urgent' : remaining < 60 * 60 * 1000 ? 'warn' : 'normal';
  return { text, state, expired: false, ms: remaining };
}

// ------------------------------------------------------------------ avatars
const AVATAR_TONES = ['#7B35A8', '#B03A93', '#21A2FF', '#21D07A', '#9B5CFF', '#FFB800'];

/** Deterministic gradient initial-avatar as a data URI (no network). */
export function initialsAvatar(name, id = 0) {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const tone = AVATAR_TONES[Math.abs(Number(id) || initial.charCodeAt(0)) % AVATAR_TONES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${tone}"/><stop offset="100%" stop-color="#B03A93"/>
    </linearGradient></defs>
    <rect width="200" height="200" fill="url(#g)"/>
    <text x="100" y="100" dy="0.35em" text-anchor="middle" fill="#fff"
      font-family="Poppins,Inter,sans-serif" font-size="88" font-weight="700">${escapeHtml(initial)}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function avatarSrc(user) {
  return user?.avatarUrl || initialsAvatar(user?.displayName, user?.id);
}

/**
 * Build a `srcset`/`sizes` pair for a profile photo.
 *
 * Uploads produce two renditions: the 1600px original and a 400px thumb. A
 * grid tile is ~200px, so without this the browser downloads the 1600px file
 * for every tile. Photos uploaded before `thumb_url` existed fall back to the
 * original, which is correct — just not smaller.
 *
 * `sizes` must describe the tile's *rendered* width, otherwise the browser
 * assumes full viewport width and picks the large file anyway.
 */
export function photoSrcset(photo, sizes = '(max-width: 640px) 45vw, 200px') {
  const full = photo?.url || '';
  const thumb = photo?.thumbUrl || '';
  if (!full) return { src: '', srcset: '', sizes: '' };
  if (!thumb || thumb === full) return { src: full, srcset: '', sizes: '' };
  return { src: full, srcset: `${thumb} 400w, ${full} 1600w`, sizes };
}

/** Swap in a generated avatar if a photo 404s (e.g. after 24h cleanup). */
export function attachAvatarFallback(img, user) {
  img.addEventListener(
    'error',
    () => {
      img.src = initialsAvatar(user?.displayName, user?.id);
    },
    { once: true }
  );
}

// --------------------------------------------------------------- navigation
export function markActiveTab() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  for (const link of $$('[data-nav]')) {
    const target = link.getAttribute('href')?.replace(/\/$/, '') || '/';
    if (target === path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

export function setBadge(selector, count) {
  for (const node of $$(selector)) {
    const show = count > 0;
    if (show) node.textContent = count > 99 ? '99+' : String(count);
    node.classList.toggle('hidden', !show);
    node.hidden = !show;
    node.setAttribute('aria-hidden', show ? 'false' : 'true');
  }
}

/** Buttons that should show a spinner while an async action runs. */
export function withBusy(button, label = 'Working…') {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `<span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"></span><span>${escapeHtml(label)}</span>`;
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = original;
  };
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
