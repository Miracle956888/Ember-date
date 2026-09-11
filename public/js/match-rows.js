/**
 * match-rows.js — row/tile builders shared by the Matches and Chats pages.
 *
 * Matches and Chats are two views over the same `api.matches()` payload:
 * Matches shows people you have not spoken to yet, Chats shows conversations
 * with messages in them. The rendering is identical, so it lives here rather
 * than being duplicated in both page scripts.
 */
import { el, escapeHtml, timeAgo, avatarSrc, attachAvatarFallback } from '/js/ui.js';

export function previewText(item) {
  if (!item.lastMessage) return 'Say hello — you matched!';
  const { body, type, fromMe } = item.lastMessage;
  const prefix = fromMe ? 'You: ' : '';
  if (type === 'image') return `${prefix}📷 Photo`;
  if (type === 'video') return `${prefix}🎬 Video`;
  return prefix + (body || '');
}

export function conversationRow(item) {
  const { user } = item;
  const unread = item.unreadCount || 0;
  const li = el('li');
  li.innerHTML = `
    <a href="/chat?c=${encodeURIComponent(item.conversationId)}"
       class="flex items-center gap-3 px-5 py-3.5 transition hover:bg-surface-grey focus-visible:bg-surface-grey">
      <span class="relative shrink-0">
        <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(user))}" alt="" class="avatar h-14 w-14" data-avatar />
        ${user.isOnline ? '<span class="online-dot absolute bottom-0 right-0"></span>' : ''}
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-baseline justify-between gap-2">
          <span class="truncate font-semibold text-ink">${escapeHtml(user.displayName)}</span>
          <span class="shrink-0 text-[12px] ${unread ? 'font-semibold text-brand-primary' : 'text-ink-faint'}">
            ${item.lastMessage ? escapeHtml(timeAgo(item.lastMessage.createdAt)) : escapeHtml(timeAgo(item.matchedAt))}
          </span>
        </span>
        <span class="mt-0.5 flex items-center justify-between gap-2">
          <span class="truncate text-[14px] ${unread ? 'font-medium text-ink' : 'text-ink-soft'}">${escapeHtml(previewText(item))}</span>
          ${unread ? `<span class="badge shrink-0">${unread > 99 ? '99+' : unread}</span>` : ''}
        </span>
      </span>
    </a>`;
  attachAvatarFallback(li.querySelector('[data-avatar]'), user);
  return li;
}

export function newMatchTile(item) {
  const { user } = item;
  const li = el('li', { class: 'shrink-0' });
  li.innerHTML = `
    <a href="/chat?c=${encodeURIComponent(item.conversationId)}" class="block w-[76px] text-center">
      <span class="relative block">
        <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(user))}" alt=""
             class="avatar mx-auto h-[70px] w-[70px] ring-2 ring-brand-primary ring-offset-2" data-avatar />
        ${user.isOnline ? '<span class="online-dot absolute bottom-0.5 right-1.5"></span>' : ''}
      </span>
      <span class="mt-1.5 block truncate text-[12px] font-semibold text-ink">${escapeHtml(user.displayName)}</span>
    </a>`;
  attachAvatarFallback(li.querySelector('[data-avatar]'), user);
  return li;
}

/**
 * A match as a grid tile: photo, name, and whether a conversation has started.
 * Used on /matches, where the point is "who am I matched with", as opposed to
 * /chats, where the point is "what was said last".
 */
export function matchTile(item) {
  const { user } = item;
  const unread = item.unreadCount || 0;
  const li = el('li');
  li.innerHTML = `
    <a href="/chat?c=${encodeURIComponent(item.conversationId)}" class="group block">
      <span class="relative block overflow-hidden rounded-2xl bg-surface-grey">
        <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(user))}" alt=""
             class="aspect-square w-full object-cover transition group-hover:scale-[1.03]" data-avatar />
        ${unread ? `<span class="badge absolute right-1.5 top-1.5">${unread > 99 ? '99+' : unread}</span>` : ''}
        ${user.isOnline ? '<span class="online-dot absolute bottom-1.5 right-1.5 ring-2 ring-white"></span>' : ''}
      </span>
      <span class="mt-1.5 block truncate text-[13px] font-semibold text-ink">${escapeHtml(user.displayName)}</span>
      <span class="block truncate text-[11.5px] text-ink-faint">
        ${item.lastMessage ? escapeHtml(timeAgo(item.lastMessage.createdAt)) : 'New match'}
      </span>
    </a>`;
  attachAvatarFallback(li.querySelector('[data-avatar]'), user);
  return li;
}
