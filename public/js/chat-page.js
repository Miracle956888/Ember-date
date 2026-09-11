/** chat-page.js — page script for chat.html (external so the strict CSP allows it). */
import { bootPage } from '/js/app-shell.js';
import { initChat } from '/js/chat.js';
import { api } from '/js/api.js';
import { $, el, escapeHtml, avatarSrc, attachAvatarFallback } from '/js/ui.js';

const me = await bootPage({ socket: true, badges: false });
await initChat({ user: me });

// Desktop sidebar conversation list.
const currentId = Number(new URLSearchParams(location.search).get('c'));
try {
  const { matches } = await api.matches();
  const list = $('#sidebar-conversations');
  list.replaceChildren(...matches.map((m) => {
    const active = Number(m.conversationId) === currentId;
    const li = el('li');
    li.innerHTML = `
      <a href="/chat?c=${encodeURIComponent(m.conversationId)}"
         class="flex items-center gap-3 px-4 py-3 transition ${active ? 'bg-brand-50' : 'hover:bg-surface-grey'}"
         ${active ? 'aria-current="page"' : ''}>
        <span class="relative shrink-0">
          <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(m.user))}" alt="" class="avatar h-11 w-11" data-avatar />
          ${m.user.isOnline ? '<span class="online-dot absolute bottom-0 right-0"></span>' : ''}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[14px] font-semibold ${active ? 'text-brand-primary' : 'text-ink'}">${escapeHtml(m.user.displayName)}</span>
          <span class="block truncate text-[12.5px] text-ink-soft">${escapeHtml(m.lastMessage ? (m.lastMessage.fromMe ? 'You: ' : '') + (m.lastMessage.type === 'image' ? '📷 Photo' : m.lastMessage.type === 'video' ? '🎬 Video' : m.lastMessage.body || '') : 'New match')}</span>
        </span>
        ${m.unreadCount ? `<span class="badge shrink-0">${m.unreadCount > 99 ? '99+' : m.unreadCount}</span>` : ''}
      </a>`;
    attachAvatarFallback(li.querySelector('[data-avatar]'), m.user);
    return li;
  }));
} catch {
  /* the sidebar is a convenience; the thread still works without it */
}
