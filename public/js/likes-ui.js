/**
 * likes-ui.js — one like button for every likeable thing.
 *
 * Mirrors the server's polymorphic like primitive: any element carrying
 * `data-like-type` and `data-like-id` becomes a working, idempotent like
 * button with a single `wireLikes(container)` call.
 *
 * The optimistic update is deliberately safe. The server is idempotent, so the
 * worst case of a double-fire is a wasted request, never an inflated count —
 * and the authoritative count from the response always overwrites the guess.
 */
import { api, ApiError } from './api.js';
import { escapeHtml, toast } from './ui.js';

/** Heart glyph, filled when liked. Inline SVG keeps the strict CSP happy. */
function heartSvg(filled, size = 'h-5 w-5') {
  return `<svg viewBox="0 0 24 24" class="${size} ${filled ? 'fill-current' : 'fill-none stroke-current stroke-2'}"
               aria-hidden="true">
    <path d="M12 21s-7.5-4.7-9.5-9A5.3 5.3 0 0112 5.7 5.3 5.3 0 0121.5 12c-2 4.3-9.5 9-9.5 9z"/>
  </svg>`;
}

/**
 * Markup for a like button.
 * @param {object} opts
 * @param {string} opts.type   profile | photo | post | moment | comment
 * @param {number} opts.id     target id
 * @param {boolean} opts.liked current state
 * @param {number} opts.count  current count
 * @param {string} opts.label  accessible noun, e.g. "photo"
 */
export function likeButton({ type, id, liked = false, count = 0, label = 'this', size = 'h-5 w-5' } = {}) {
  return `<button type="button"
    class="like-btn inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px] font-semibold
           transition ${liked ? 'text-like' : 'text-ink-soft hover:text-like'}"
    data-like-type="${escapeHtml(type)}" data-like-id="${id}"
    aria-pressed="${liked ? 'true' : 'false'}"
    aria-label="${liked ? 'Unlike' : 'Like'} ${escapeHtml(label)}">
    ${heartSvg(liked, size)}
    <span class="like-count tabular-nums" data-like-count>${count > 0 ? count : ''}</span>
  </button>`;
}

/** Repaint a button from authoritative server state. */
function paint(btn, { liked, count }) {
  const size = btn.dataset.likeSize || 'h-5 w-5';
  const label = btn.getAttribute('aria-label')?.replace(/^(Un)?[Ll]ike /, '') || 'this';
  btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
  btn.setAttribute('aria-label', `${liked ? 'Unlike' : 'Like'} ${label}`);
  btn.classList.toggle('text-like', liked);
  btn.classList.toggle('text-ink-soft', !liked);
  const svg = btn.querySelector('svg');
  if (svg) svg.outerHTML = heartSvg(liked, size);
  const counter = btn.querySelector('[data-like-count]');
  if (counter) counter.textContent = count > 0 ? String(count) : '';
}

/**
 * Delegate like handling for a whole container. Safe to call more than once
 * per element — the guard flag stops duplicate listeners double-firing.
 */
export function wireLikes(container, { onChange } = {}) {
  if (!container || container.dataset.likesWired === '1') return;
  container.dataset.likesWired = '1';

  container.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-like-type][data-like-id]');
    if (!btn || !container.contains(btn)) return;
    event.preventDefault();
    if (btn.disabled) return;

    const type = btn.dataset.likeType;
    const id = Number(btn.dataset.likeId);
    const wasLiked = btn.getAttribute('aria-pressed') === 'true';
    const counter = btn.querySelector('[data-like-count]');
    const wasCount = Number(counter?.textContent || 0);

    // Optimistic: the tap feels instant even on a slow connection.
    btn.disabled = true;
    paint(btn, { liked: !wasLiked, count: Math.max(wasCount + (wasLiked ? -1 : 1), 0) });

    try {
      const result = wasLiked
        ? await api.del(`likes/${type}/${id}`)
        : await api.post('likes', { targetType: type, targetId: id });
      paint(btn, { liked: Boolean(result.liked), count: Number(result.count || 0) });
      onChange?.({ type, id, liked: Boolean(result.liked), count: Number(result.count || 0) });
    } catch (err) {
      paint(btn, { liked: wasLiked, count: wasCount });
      if (err instanceof ApiError && err.status === 404) {
        toast('That content is no longer available.');
      } else if (err instanceof ApiError && err.status === 429) {
        toast('Slow down a moment.');
      } else {
        toast('Could not save that. Try again.');
      }
    } finally {
      btn.disabled = false;
    }
  });
}

/** Fetch current like state for one target — used when rendering server-less HTML. */
export async function likeState(type, id) {
  try {
    return await api.get(`likes/${type}/${id}`);
  } catch {
    return { liked: false, count: 0 };
  }
}
