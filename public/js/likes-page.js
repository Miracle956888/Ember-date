/** likes-page.js — Likes you, Visitors, Taps, Favourites and Top Picks. */
import { bootPage, refreshBadges } from '/js/app-shell.js';
import { initSearch } from '/js/search.js';
import { api, ApiError } from '/js/api.js';
import { $, $$, toast, timeAgo } from '/js/ui.js';
import { renderPeople, wirePeopleActions, matchModal } from '/js/people.js';

const me = await bootPage({ socket: true, badges: true });
initSearch({ me, onMatch: () => refreshBadges() });

const TAP_LABELS = { wave: '👋 waved at you', crush: '💜 has a crush on you', fire: '🔥 likes what they see' };

/**
 * Each tab is described once: how to fetch it, what its meta line says, and
 * what the empty state should read. Adding a sixth list is a new entry here.
 */
const TABS = {
  likes: {
    grid: '#likes-grid',
    fetch: () => api.likesYou(),
    meta: (p) => `${p.likedDirection === 'superlike' ? '⭐ Super liked' : 'Liked you'} · ${timeAgo(p.likedAt)}`,
    empty: { icon: '💜', title: 'No likes yet', message: 'Keep swiping — the more active you are, the more you show up.' }
  },
  visitors: {
    grid: '#visitors-grid',
    fetch: () => api.visitors(),
    meta: (p) => {
      const via = { nearby: 'from Nearby', search: 'from search', deck: 'from the deck', bumped: 'after bumping into you' }[p.viewSource];
      return `Viewed ${timeAgo(p.visitedAt)}${via ? ` ${via}` : ''}${p.viewCount > 1 ? ` · ${p.viewCount}×` : ''}`;
    },
    empty: { icon: '👀', title: 'No visitors yet', message: 'When someone opens your profile, they will appear here.' }
  },
  taps: {
    grid: '#taps-grid',
    fetch: () => api.taps(),
    meta: (p) => `${TAP_LABELS[p.tapKind] || 'Tapped you'} · ${timeAgo(p.tappedAt)}`,
    empty: { icon: '👋', title: 'No taps yet', message: 'A tap is a low-pressure way to say hello. Try sending one.' },
    onLoad: () => api.markTapsSeen().then(() => refreshBadges()).catch(() => {})
  },
  favorites: {
    grid: '#favorites-grid',
    fetch: () => api.favorites(),
    meta: (p) => `Saved ${timeAgo(p.favoritedAt)}`,
    empty: { icon: '⭐', title: 'No favourites yet', message: 'Tap the star on anyone you want to come back to.' }
  },
  picks: {
    grid: '#picks-grid',
    fetch: () => api.topPicks(),
    meta: (p) => p.reason || p.distance || '',
    empty: { icon: '✨', title: 'No picks today', message: 'Add a few interests to your profile and we can do better.' }
  }
};

const loaded = new Set();

for (const [key, config] of Object.entries(TABS)) {
  wirePeopleActions($(config.grid), {
    onMatch: (r) => { matchModal(r); refreshBadges(); },
    onChanged: () => {
      // The favourites list is the one view that must re-fetch after a change.
      if (key !== 'favorites') loaded.delete('favorites');
    }
  });
}

async function loadTab(key) {
  const config = TABS[key];
  const grid = $(config.grid);
  if (loaded.has(key)) return;

  grid.innerHTML = Array.from({ length: 4 })
    .map(() => '<div class="skeleton aspect-[4/5] rounded-3xl"></div>')
    .join('');

  try {
    const data = await config.fetch();
    renderPeople(grid, data.results, {
      source: key === 'picks' ? 'deck' : key,
      metaFor: config.meta,
      emptyIcon: config.empty.icon,
      emptyTitle: config.empty.title,
      emptyMessage: config.empty.message
    });
    loaded.add(key);
    await config.onLoad?.();
  } catch (err) {
    grid.innerHTML = '';
    toast(err instanceof ApiError ? err.message : 'Could not load that list.', { type: 'error' });
  }
}

$$('[role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const key = tab.dataset.tab;
    $$('[role="tab"]').forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    for (const name of Object.keys(TABS)) {
      $(`#panel-${name}`).classList.toggle('hidden', name !== key);
    }
    loadTab(key);
  });
});

await loadTab('likes');
