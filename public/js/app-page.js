/** app-page.js — page script for app.html (external so the strict CSP allows it). */
import { bootPage, refreshBadges } from '/js/app-shell.js';
import { initDeck } from '/js/deck.js';
import { initSearch } from '/js/search.js';

const me = await bootPage({ socket: true, badges: true });

initDeck({
  stack: '#stack',
  actions: '#actions',
  me,
  onMatch: () => refreshBadges()
});

initSearch({ me, onMatch: () => refreshBadges() });
