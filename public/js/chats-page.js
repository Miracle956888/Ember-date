/** chats-page.js — page script for chats.html (external so the strict CSP allows it). */
import { bootPage, emptyState, refreshBadges } from '/js/app-shell.js';
import { api } from '/js/api.js';
import { $, toast } from '/js/ui.js';
import { on } from '/js/socket.js';
import { initSearch } from '/js/search.js';
import { conversationRow } from '/js/match-rows.js';

const me = await bootPage({ socket: true, badges: true });

initSearch({ me, onMatch: () => { refreshBadges(); load(); } });

const convList = $('#conversations');
const emptySlot = $('#empty-slot');

let data = { matches: [] };

function render() {
  // Chats is strictly conversations that have messages. Matches with no
  // messages yet live on /matches, so the two tabs never show the same row.
  const withMessages = data.matches.filter((m) => m.lastMessage);

  convList.replaceChildren(...withMessages.map(conversationRow));

  emptySlot.replaceChildren();
  if (!withMessages.length) {
    const hasMatches = data.matches.length > 0;
    emptySlot.append(emptyState({
      icon: `<svg viewBox="0 0 24 24" class="h-9 w-9 fill-current" aria-hidden="true"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>`,
      title: hasMatches ? 'No conversations yet' : 'No chats yet',
      message: hasMatches
        ? 'You have matches waiting. Say hello and the conversation will appear here.'
        : 'When you match with someone and one of you says hello, the conversation shows up here.',
      action: hasMatches
        ? { label: 'See your matches', href: '/matches' }
        : { label: 'Start swiping', href: '/app' }
    }));
  }
}

async function load() {
  try {
    data = await api.matches();
    render();
  } catch (err) {
    toast(err.message || 'Could not load your chats.', { type: 'error' });
  }
}

// Realtime: refresh on anything that changes the list.
on('chat:message:notify', load);
on('chat:message', load);
on('match:new', () => { load(); refreshBadges(); });
on('match:removed', load);
on('chat:cleared', load);
on('presence:update', ({ userId, isOnline }) => {
  const match = data.matches.find((m) => m.user.id === userId);
  if (match) {
    match.user.isOnline = isOnline;
    render();
  }
});

// Refresh when the tab regains focus (timestamps go stale).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

await load();
