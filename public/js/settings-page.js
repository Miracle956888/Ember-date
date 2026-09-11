/** settings-page.js — discovery filters, location privacy, passport, verification. */
import { bootPage, refreshBadges } from '/js/app-shell.js';
import { initSearch } from '/js/search.js';
import { api, ApiError } from '/js/api.js';
import { $, $$, el, toast, confirmDialog, openModal, html, escapeHtml, avatarSrc, attachAvatarFallback } from '/js/ui.js';
import { verifiedBadge } from '/js/people.js';
import * as geo from '/js/geo.js';
import { initThemeChoice } from '/js/theme.js';

initThemeChoice();

const me = await bootPage({ socket: true, badges: true });
initSearch({ me, onMatch: () => refreshBadges() });

/** Passport destinations. A real deployment would geocode a search box. */
const CITIES = [
  { label: 'Lagos', lat: 6.5244, lng: 3.3792 },
  { label: 'Abuja', lat: 9.0765, lng: 7.3986 },
  { label: 'Port Harcourt', lat: 4.8156, lng: 7.0498 },
  { label: 'Kano', lat: 12.0022, lng: 8.592 },
  { label: 'Accra', lat: 5.6037, lng: -0.187 },
  { label: 'Nairobi', lat: -1.2921, lng: 36.8219 },
  { label: 'London', lat: 51.5072, lng: -0.1276 },
  { label: 'New York', lat: 40.7128, lng: -74.006 }
];

let settings = null;
let saving = false;

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

function paint() {
  $('#minAge').value = settings.minAge;
  $('#maxAge').value = settings.maxAge;
  $('#maxDistanceKm').value = settings.maxDistanceKm;
  $('#age-output').textContent = `${settings.minAge} – ${settings.maxAge}`;
  $('#distance-output').textContent = `${settings.maxDistanceKm} km`;

  for (const key of ['verifiedOnly', 'onlineOnly', 'showDistance', 'showOnline', 'allowBumpedInto', 'incognito', 'showMeGlobally']) {
    const box = $(`#${key}`);
    if (box) box.checked = Boolean(settings[key]);
  }

  const radio = $(`input[name="locationMode"][value="${settings.locationMode}"]`);
  if (radio) radio.checked = true;

  paintPassport();
}

function paintPassport() {
  const current = $('#passport-current');
  const clearBtn = $('[data-action="clear-passport"]');

  if (settings.passport) {
    current.innerHTML = `<div class="flex items-center gap-2 rounded-2xl bg-brand-50 px-4 py-3">
      <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0 fill-brand-primary" aria-hidden="true"><path d="M12 2a7 7 0 00-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z"/></svg>
      <p class="text-[13.5px] font-semibold text-brand-700">Currently browsing ${escapeHtml(settings.passport.label || 'another city')}</p>
    </div>`;
    clearBtn.classList.remove('hidden');
  } else {
    current.innerHTML = '<p class="text-[13px] text-ink-soft">You are browsing from your real location.</p>';
    clearBtn.classList.add('hidden');
  }

  $('#passport-cities').innerHTML = CITIES.map(
    (c) =>
      `<button type="button" class="chip-option !py-1.5 text-[13px]" data-city="${escapeHtml(c.label)}"
               ${settings.passport?.label === c.label ? 'aria-pressed="true"' : ''}>${escapeHtml(c.label)}</button>`
  ).join('');
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

/** Debounced patch so dragging a slider does not fire a request per pixel. */
let pending = {};
let timer = null;

function queueSave(patch) {
  pending = { ...pending, ...patch };
  clearTimeout(timer);
  timer = setTimeout(flush, 400);
}

async function flush() {
  if (saving || !Object.keys(pending).length) return;
  const patch = pending;
  pending = {};
  saving = true;
  try {
    const result = await api.updateSettings(patch);
    settings = result.settings;
    // 'hidden' erases stored coordinates server-side; reflect that immediately.
    if (patch.locationMode === 'hidden') toast('Location sharing off. Stored location erased.');
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not save that.', { type: 'error' });
    await load();
    paint();
  } finally {
    saving = false;
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function wire() {
  const minEl = $('#minAge');
  const maxEl = $('#maxAge');
  const syncAge = () => {
    if (Number(minEl.value) > Number(maxEl.value)) maxEl.value = minEl.value;
    $('#age-output').textContent = `${minEl.value} – ${maxEl.value}`;
    queueSave({ minAge: Number(minEl.value), maxAge: Number(maxEl.value) });
  };
  minEl.addEventListener('input', syncAge);
  maxEl.addEventListener('input', syncAge);

  $('#maxDistanceKm').addEventListener('input', (e) => {
    $('#distance-output').textContent = `${e.target.value} km`;
    queueSave({ maxDistanceKm: Number(e.target.value) });
  });

  for (const key of ['verifiedOnly', 'onlineOnly', 'showDistance', 'showOnline', 'allowBumpedInto', 'incognito', 'showMeGlobally']) {
    $(`#${key}`)?.addEventListener('change', (e) => queueSave({ [key]: e.target.checked }));
  }

  $$('input[name="locationMode"]').forEach((radio) => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      if (radio.value === 'hidden') {
        const ok = await confirmDialog({
          title: 'Turn off location?',
          message: 'Your stored location will be erased and you will disappear from Nearby.',
          confirmLabel: 'Turn it off',
          danger: true
        });
        if (!ok) {
          const previous = $(`input[name="locationMode"][value="${settings.locationMode}"]`);
          if (previous) previous.checked = true;
          return;
        }
      }
      queueSave({ locationMode: radio.value });
      await flush();

      // Switching to a sharing mode is only useful with a fresh position.
      if (radio.value !== 'hidden') {
        try {
          await geo.updateOnce({ silent: true });
          toast(radio.value === 'precise' ? 'Precise location on.' : 'Approximate location on.');
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      }
    });
  });

  $('[data-action="update-location"]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await geo.updateOnce();
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      button.disabled = false;
    }
  });

  $('[data-action="erase-location"]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Erase stored location?',
      message: 'We will delete the position we hold for you. You can turn it back on any time.',
      confirmLabel: 'Erase it',
      danger: true
    });
    if (!ok) return;
    await api.clearLocation();
    toast('Stored location erased.');
  });

  $('#passport-cities').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-city]');
    if (!button) return;
    const city = CITIES.find((c) => c.label === button.dataset.city);
    if (!city) return;
    const result = await api.setPassport({ lat: city.lat, lng: city.lng, label: city.label });
    settings = result.settings;
    paintPassport();
    toast(`Now browsing ${city.label}.`);
  });

  $('[data-action="clear-passport"]').addEventListener('click', async () => {
    const result = await api.clearPassport();
    settings = result.settings;
    paintPassport();
    toast('Back to your real location.');
  });
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

async function paintVerification() {
  const box = $('#verification-state');
  // Fire-and-forget at boot and after every verify step, so this must never
  // reject: navigating away mid-flight aborts the fetch ("Failed to fetch")
  // and an unhandled rejection surfaces as a red console error the user sees.
  let status;
  try {
    status = await api.verificationStatus();
  } catch {
    return;
  }
  if (!box.isConnected) return;

  if (status.isVerified) {
    box.innerHTML = `<div class="flex items-center gap-3 rounded-2xl bg-superlike/10 px-4 py-3">
      ${verifiedBadge('h-6 w-6')}
      <div>
        <p class="text-[14px] font-bold text-ink">You are verified</p>
        <p class="text-[12.5px] text-ink-soft">Your profile shows a blue tick.</p>
      </div>
    </div>`;
    return;
  }

  box.innerHTML = `
    <p class="text-[13px] text-ink-soft">
      Take a selfie copying a pose we choose at random. It is only used to confirm you are real,
      is never shown on your profile, and is deleted once checked.
    </p>
    <button type="button" class="btn-primary mt-3" data-action="verify">Verify my photos</button>`;

  box.querySelector('[data-action="verify"]').addEventListener('click', startVerification);
}

async function startVerification() {
  let challenge;
  try {
    challenge = await api.verificationChallenge();
  } catch (err) {
    return toast(err.message, { type: 'error' });
  }

  const modal = openModal({
    title: 'Photo verification',
    body: html(`
      <div class="text-left">
        <div class="rounded-2xl bg-brand-50 px-4 py-3">
          <p class="text-[13px] font-semibold text-brand-700">Your pose</p>
          <p class="mt-0.5 text-[15px] font-bold text-ink">${escapeHtml(challenge.instruction)}</p>
        </div>
        <div class="mt-3 overflow-hidden rounded-2xl bg-black">
          <video id="verify-video" class="aspect-[3/4] w-full object-cover" autoplay playsinline muted></video>
        </div>
        <canvas id="verify-canvas" class="hidden"></canvas>
        <p class="mt-2 text-[12px] text-ink-faint" id="verify-note">Position yourself in the frame.</p>
      </div>`),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Take photo', value: 'capture', class: 'btn-primary' }
    ]
  });

  const panel = modal.panel;
  const video = panel.querySelector('#verify-video');
  const canvas = panel.querySelector('#verify-canvas');
  const note = panel.querySelector('#verify-note');
  let stream = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    video.srcObject = stream;
  } catch {
    note.textContent = 'We could not open your camera. Check the permission and try again.';
  }

  const stopCamera = () => stream?.getTracks().forEach((t) => t.stop());

  const captureButton = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Take photo');
  captureButton?.addEventListener('click', async (event) => {
    // Intercept: capture and upload before the modal closes.
    event.stopImmediatePropagation();
    if (!stream) return;

    canvas.width = video.videoWidth || 480;
    canvas.height = video.videoHeight || 640;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

    note.textContent = 'Checking…';
    captureButton.disabled = true;

    canvas.toBlob(async (blob) => {
      try {
        await api.submitVerification(challenge.gesture, blob);
        stopCamera();
        modal.close('done');
        toast('You are verified 🎉');
        await paintVerification();
      } catch (err) {
        note.textContent = err instanceof ApiError ? err.message : 'That did not work. Try again.';
        captureButton.disabled = false;
      }
    }, 'image/jpeg', 0.9);
  }, true);

  const result = await modal;
  if (result !== 'done') stopCamera();
}

/* ------------------------------------------------------------------ */
/* Notification preferences                                            */
/* ------------------------------------------------------------------ */

/**
 * These live behind their own endpoint (/api/notifications/prefs), not the
 * general settings object, so they get their own tiny load/save pair rather
 * than being forced through queueSave.
 *
 * Saving is per-toggle and optimistic-with-rollback: the switch moves at once
 * because that is what a switch is for, and it snaps back only if the server
 * rejects it.
 */
const NOTIF_KEYS = ['matches', 'messages', 'likes', 'comments', 'moments', 'posts'];

async function loadNotificationPrefs() {
  try {
    const { prefs } = await api.notificationPrefs();
    for (const key of NOTIF_KEYS) {
      const input = $(`#notif-${key}`);
      if (input) input.checked = prefs[key] !== false;
    }
  } catch {
    // Leave the toggles as they are; a failed read must not silently look
    // like "everything is off".
  }
}

function wireNotificationPrefs() {
  for (const key of NOTIF_KEYS) {
    const input = $(`#notif-${key}`);
    if (!input) continue;
    input.addEventListener('change', async (e) => {
      const value = e.target.checked;
      try {
        await api.updateNotificationPrefs({ [key]: value });
      } catch (err) {
        e.target.checked = !value; // roll back
        toast(err instanceof ApiError ? err.message : 'Could not save that.', { type: 'error' });
      }
    });
  }
}

/* ------------------------------------------------------------------ */

/**
 * Blocked people.
 *
 * The block endpoints existed from Phase 1 but nothing in the UI ever called
 * `GET`/`DELETE /api/users/blocks`, so a block was effectively permanent: the
 * only way out was a manual DB edit. Unblocking is consequential (it makes you
 * discoverable to that person again) and irreversible in one click, so it is
 * confirmed first. Blocking does not restore a deleted match, and the copy
 * says so rather than implying the old conversation comes back.
 */
async function paintBlocked() {
  const host = $('#blocked-list');
  if (!host) return;

  let blocked = [];
  try {
    const res = await api.blockedList();
    blocked = res.blocked || [];
  } catch (err) {
    host.replaceChildren(
      el('p', {
        class: 'text-[13px] text-ink-soft',
        text: err instanceof ApiError ? err.message : 'Could not load your blocked list.'
      })
    );
    return;
  }

  if (!blocked.length) {
    host.replaceChildren(
      el('p', { class: 'text-[13px] text-ink-soft', text: 'You have not blocked anyone.' })
    );
    return;
  }

  const rows = blocked.map((p) => {
    const avatar = el('img', {
      class: 'h-11 w-11 shrink-0 rounded-full object-cover',
      src: avatarSrc(p),
      alt: '',
      loading: 'lazy'
    });
    attachAvatarFallback(avatar, p);

    const button = el('button', {
      type: 'button',
      class: 'btn-ghost !py-1.5 text-[13px]',
      text: 'Unblock',
      'data-unblock': String(p.id),
      'aria-label': `Unblock ${p.displayName || p.username}`
    });

    return el('li', { class: 'flex items-center gap-3 py-2.5' }, [
      avatar,
      el('div', { class: 'min-w-0 flex-1' }, [
        el('p', { class: 'truncate text-[14px] font-semibold text-ink', text: p.displayName || p.username }),
        el('p', {
          class: 'truncate text-[12px] text-ink-soft',
          text: p.username ? `@${p.username}` : 'Account no longer available'
        })
      ]),
      button
    ]);
  });

    host.replaceChildren(el('ul', { class: 'divide-y divide-hairline/[var(--hairline-a)]' }, rows));
}

async function unblockPerson(id, name) {
  const yes = await confirmDialog({
    title: `Unblock ${name}?`,
    message:
      'They will be able to find you in search and message you again. This does not bring back any match or chat you had before.',
    confirmLabel: 'Unblock',
    danger: true
  });
  if (!yes) return;

  try {
    await api.unblock(id);
    toast(`${name} unblocked.`, { type: 'success' });
    await paintBlocked();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not unblock that person.', { type: 'error' });
  }
}

function wireBlocked() {
  const host = $('#blocked-list');
  if (!host) return;
  // Delegated: the list repaints after every unblock.
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-unblock]');
    if (!btn) return;
    const row = btn.closest('li');
    const name = row?.querySelector('p')?.textContent || 'This person';
    unblockPerson(Number(btn.dataset.unblock), name);
  });
}

/* ------------------------------------------------------------------ */

async function load() {
  const result = await api.settings();
  settings = result.settings;
}

// Boot. Navigating away mid-load aborts the in-flight fetches; that rejection
// is not a fault worth showing, so surface real failures as a toast and let a
// teardown pass quietly. Without this the abort escapes as a `pageerror`.
try {
  await load();
  paint();
  wire();
  wireNotificationPrefs();
  wireBlocked();
  await Promise.all([paintVerification(), loadNotificationPrefs(), paintBlocked()]);
} catch (err) {
  if (document.visibilityState !== 'hidden' && !/Failed to fetch|aborted/i.test(String(err?.message))) {
    toast(err instanceof ApiError ? err.message : 'Could not load your settings.', { type: 'error' });
  }
}
