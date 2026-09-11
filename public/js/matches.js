/** matches.js — page script for matches.html (external so the strict CSP allows it). */
import { bootPage, emptyState, refreshBadges } from '/js/app-shell.js';
import { api } from '/js/api.js';
import { $, toast } from '/js/ui.js';
import { matchTile, newMatchTile } from '/js/match-rows.js';
import { on } from '/js/socket.js';
import { initSearch } from '/js/search.js';

const me = await bootPage({ socket: true, badges: true });

initSearch({ me, onMatch: () => { refreshBadges(); load(); } });

const newSection = $('#new-matches-section');
const newList = $('#new-matches');
const convList = $('#conversations');
const emptySlot = $('#empty-slot');

let data = { matches: [], newMatches: [], conversations: [] };

function render() {
  const withMessages = data.matches.filter((m) => m.lastMessage);
  const withoutMessages = data.matches.filter((m) => !m.lastMessage);

  newList.replaceChildren(...withoutMessages.map(newMatchTile));
  newSection.classList.toggle('hidden', withoutMessages.length === 0);

  // Matches is a roster of people; Chats is the list of threads. Showing
  // tiles here rather than message rows keeps the two tabs visibly distinct.
  convList.replaceChildren(...data.matches.map(matchTile));
  $('#conversations-section').classList.toggle('hidden', data.matches.length === 0);
  $('#all-chats-link').classList.toggle('hidden', withMessages.length === 0);
  $('#all-chats-link').classList.toggle('inline-flex', withMessages.length > 0);

  emptySlot.replaceChildren();
  if (!data.matches.length) {
    emptySlot.append(emptyState({
      icon: `<svg viewBox="0 0 24 24" class="h-9 w-9 fill-current" aria-hidden="true"><path d="M16.5 3c-1.7 0-3.3.8-4.5 2.1C10.8 3.8 9.2 3 7.5 3 4.4 3 2 5.5 2 8.5c0 3.9 4 7 9 10.5l1 .7 1-.7c5-3.5 9-6.6 9-10.5C22 5.5 19.6 3 16.5 3z"/></svg>`,
      title: 'No matches yet',
      message: 'When you and someone else both swipe right, they will show up here and you can start talking.',
      action: { label: 'Start swiping', href: '/app' }
    }));
  }
}

async function load() {
  try {
    data = await api.matches();
    render();
  } catch (err) {
    toast(err.message || 'Could not load your matches.', { type: 'error' });
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
