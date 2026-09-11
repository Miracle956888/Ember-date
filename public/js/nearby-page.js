/** nearby-page.js — People Nearby + Bumped into. */
import { bootPage, refreshBadges } from '/js/app-shell.js';
import { initSearch } from '/js/search.js';
import { api, ApiError } from '/js/api.js';
import { $, $$, toast, openModal, timeAgo, html } from '/js/ui.js';
import { renderPeople, wirePeopleActions, matchModal } from '/js/people.js';
import * as geo from '/js/geo.js';
import { getSocket } from '/js/socket.js';

const me = await bootPage({ socket: true, badges: true });
initSearch({ me, onMatch: () => refreshBadges() });

const gate = $('#location-gate');
const content = $('#nearby-content');
const grid = $('#nearby-grid');
const bumpedGrid = $('#bumped-grid');
const originLabel = $('#origin-label');
const loadMoreBtn = $('[data-action="load-more"]');
const sentinel = $('#nearby-sentinel');

const PAGE_SIZE = 24;
let nextCursor = null;
let loadingMore = false;
let loadedCount = 0;
let radiusKm = 50;
let stopWatching = null;

wirePeopleActions(grid, { onMatch: (r) => { matchModal(r); refreshBadges(); } });
wirePeopleActions(bumpedGrid, { onMatch: (r) => { matchModal(r); refreshBadges(); } });

/* ------------------------------------------------------------------ */
/* Gate                                                                */
/* ------------------------------------------------------------------ */

function showGate(note) {
  gate.classList.remove('hidden');
  content.classList.add('hidden');
  if (note) $('#gate-note').textContent = note;
}

function showContent() {
  gate.classList.add('hidden');
  content.classList.remove('hidden');
}

/** Decide which view to show, based on settings and whether we have a fix. */
async function boot() {
  if (!geo.isSupported()) {
    showGate('This browser cannot share a location, so Nearby is unavailable.');
    $('[data-action="enable-location"]').disabled = true;
    return;
  }
  if (!geo.isSecure()) {
    showGate('Location needs a secure (https) connection.');
    $('[data-action="enable-location"]').disabled = true;
    return;
  }

  const [{ settings }, { location }] = await Promise.all([api.settings(), api.getLocation()]);
  radiusKm = settings.maxDistanceKm || 50;

  if (settings.locationMode === 'hidden' || !location) {
    // Pre-select whatever mode they already chose.
    const radio = $(`input[name="gate-mode"][value="${settings.locationMode}"]`);
    if (radio) radio.checked = true;
    showGate();
    return;
  }

  showContent();
  await Promise.all([loadNearby(true), loadBumped()]);
  startWatch();
}

$('[data-action="enable-location"]').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const mode = $('input[name="gate-mode"]:checked')?.value || 'approximate';
  button.disabled = true;
  button.textContent = 'Getting your location…';

  try {
    // Save the privacy choice *before* the first write, so the very first
    // position is already stored at the requested precision.
    await api.updateSettings({ locationMode: mode });
    await geo.updateOnce({ silent: true });
    showContent();
    await Promise.all([loadNearby(true), loadBumped()]);
    startWatch();
    toast('Location on. Here is who is around you.');
  } catch (err) {
    toast(err.message || 'We could not get your location.', { type: 'error' });
  } finally {
    button.disabled = false;
    button.textContent = 'Turn on location';
  }
});

function startWatch() {
  stopWatching?.();
  stopWatching = geo.startWatching({
    onUpdate: () => loadNearby(true),
    onError: () => {}
  });
}

window.addEventListener('beforeunload', () => stopWatching?.());

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

const nextCursorPending = (data) => Boolean(data.nextCursor);

async function loadNearby(reset = false) {
  if (reset) nextCursor = null;
  // A second page cannot be requested until the first has answered, otherwise
  // both would send the same cursor and the same rows would render twice.
  if (loadingMore) return;
  if (!reset && !nextCursor) return;
  loadingMore = true;
  try {
    const data = await api.nearby({
      radiusKm,
      limit: PAGE_SIZE,
      ...(reset || !nextCursor
        ? {}
        : { cursorDistanceKm: nextCursor.distanceKm, cursorId: nextCursor.id })
    });

    if (data.needsLocation) return showGate();

    loadedCount = reset ? data.results.length : loadedCount + data.results.length;

    originLabel.textContent = data.origin?.isPassport
      ? `Browsing ${data.origin.label} with Passport`
      : `${loadedCount}${nextCursorPending(data) ? '+' : ''} ${loadedCount === 1 ? 'person' : 'people'} within ${radiusKm} km${data.origin?.label ? ` of ${data.origin.label}` : ''}`;

    if (reset) {
      renderPeople(grid, data.results, {
        source: 'nearby',
        metaFor: (p) => p.distance || p.city || '',
        emptyIcon: '📍',
        emptyTitle: 'Nobody nearby yet',
        emptyMessage: 'Try widening the distance filter, or check back later.'
      });
    } else {
      // Append without disturbing what is already on screen.
      const container = document.createElement('div');
      renderPeople(container, data.results, { source: 'nearby', metaFor: (p) => p.distance || p.city || '' });
      grid.insertAdjacentHTML('beforeend', container.innerHTML);
    }

    nextCursor = data.nextCursor || null;
    loadMoreBtn.classList.toggle('hidden', !nextCursor);
    sentinel?.classList.toggle('hidden', !nextCursor);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not load nearby people.', { type: 'error' });
  } finally {
    loadingMore = false;
  }
}

async function loadBumped() {
  try {
    const data = await api.bumpedInto({ days: 7 });
    renderPeople(bumpedGrid, data.results, {
      source: 'bumped',
      metaFor: (p) =>
        `${p.proximity || 'Nearby'} · ${timeAgo(p.lastMetAt)}${p.timesMet > 1 ? ` · ${p.timesMet}×` : ''}`,
      emptyIcon: '👋',
      emptyTitle: 'No run-ins yet',
      emptyMessage: 'When you cross paths with someone, they will show up here.'
    });
  } catch {
    /* non-critical surface */
  }
}

// Infinite scroll, with the button kept as a keyboard-reachable fallback for
// anyone who cannot trigger an intersection (and for browsers without the API).
loadMoreBtn.addEventListener('click', () => loadNearby(false));
if (sentinel && 'IntersectionObserver' in window) {
  let sentinelVisible = false;
  const fill = async () => {
    while (sentinelVisible && nextCursor && !loadingMore) {
      const before = grid.childElementCount;
      await loadNearby(false);
      // Stop if a page added nothing, so a server that keeps returning a
      // cursor can never spin this into an infinite request loop.
      if (grid.childElementCount === before) break;
    }
  };
  new IntersectionObserver(
    (entries) => {
      sentinelVisible = entries.some((en) => en.isIntersecting);
      if (sentinelVisible) fill();
    },
    { rootMargin: '400px' }
  ).observe(sentinel);
}
$('[data-action="refresh-location"]').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await geo.updateOnce();
    await Promise.all([loadNearby(true), loadBumped()]);
  } catch (err) {
    toast(err.message, { type: 'error' });
  } finally {
    button.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

$$('[role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('[role="tab"]').forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#panel-grid').classList.toggle('hidden', tab.dataset.tab !== 'grid');
    $('#panel-bumped').classList.toggle('hidden', tab.dataset.tab !== 'bumped');
  });
});

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

$('[data-action="open-filters"]').addEventListener('click', async () => {
  const { settings } = await api.settings();

  const modal = openModal({
    title: 'Filters',
    body: html(`
      <div class="space-y-4 text-left">
        <div>
          <div class="flex items-baseline justify-between">
            <label for="f-distance" class="text-[14px] font-semibold text-ink">Distance</label>
            <span class="text-[13px] font-semibold text-brand-primary" id="f-distance-out">${settings.maxDistanceKm} km</span>
          </div>
          <input type="range" id="f-distance" min="1" max="500" value="${settings.maxDistanceKm}" class="mt-2 w-full" />
        </div>
        <div>
          <div class="flex items-baseline justify-between">
            <span class="text-[14px] font-semibold text-ink">Age</span>
            <span class="text-[13px] font-semibold text-brand-primary" id="f-age-out">${settings.minAge} – ${settings.maxAge}</span>
          </div>
          <div class="mt-2 flex gap-3">
            <input type="range" id="f-min" min="18" max="99" value="${settings.minAge}" class="w-full" aria-label="Minimum age" />
            <input type="range" id="f-max" min="18" max="99" value="${settings.maxAge}" class="w-full" aria-label="Maximum age" />
          </div>
        </div>
        <label class="flex items-center justify-between gap-3">
          <span class="text-[14px] font-semibold text-ink">Verified only</span>
          <input type="checkbox" id="f-verified" class="toggle" ${settings.verifiedOnly ? 'checked' : ''} />
        </label>
        <label class="flex items-center justify-between gap-3">
          <span class="text-[14px] font-semibold text-ink">Online now only</span>
          <input type="checkbox" id="f-online" class="toggle" ${settings.onlineOnly ? 'checked' : ''} />
        </label>
      </div>`),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Apply', value: 'apply', class: 'btn-primary' }
    ]
  });

  const panel = modal.panel;
  const dOut = panel.querySelector('#f-distance-out');
  const aOut = panel.querySelector('#f-age-out');
  const dEl = panel.querySelector('#f-distance');
  const minEl = panel.querySelector('#f-min');
  const maxEl = panel.querySelector('#f-max');

  dEl.addEventListener('input', () => { dOut.textContent = `${dEl.value} km`; });
  const syncAge = () => {
    // Keep the two thumbs from crossing over.
    if (Number(minEl.value) > Number(maxEl.value)) maxEl.value = minEl.value;
    aOut.textContent = `${minEl.value} – ${maxEl.value}`;
  };
  minEl.addEventListener('input', syncAge);
  maxEl.addEventListener('input', syncAge);

  const choice = await modal;
  if (choice !== 'apply') return;

  await api.updateSettings({
    maxDistanceKm: Number(dEl.value),
    minAge: Number(minEl.value),
    maxAge: Number(maxEl.value),
    verifiedOnly: panel.querySelector('#f-verified').checked,
    onlineOnly: panel.querySelector('#f-online').checked
  });
  radiusKm = Number(dEl.value);
  toast('Filters updated.');
  await loadNearby(true);
});

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

const socket = getSocket();
socket?.on('nearby:bumped', (payload) => {
  toast(`You just crossed paths with ${payload.user.displayName}`);
  loadBumped();
});

// A navigation mid-flight aborts any in-flight fetch, which would surface as
// an unhandled `TypeError: Failed to fetch` pageerror. Boot is fire-and-forget
// from the module's point of view, so it must never reject.
boot().catch((err) => {
  if (err?.name === 'AbortError' || /Failed to fetch/i.test(err?.message || '')) return;
  console.warn('[nearby] boot failed', err?.message || err);
  showGate('Something went wrong loading people nearby. Please refresh.');
});
