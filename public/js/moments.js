/**
 * moments.js — the 24-hour Moments tray and full-screen viewer.
 *
 * Two surfaces:
 *   1. a horizontal rail of authors (your own first, then unseen, then recent)
 *   2. a full-screen viewer with tap-to-advance, reactions and reply-to-DM
 *
 * This is deliberately *not* an Instagram clone: nothing auto-advances, there
 * is no "seen by" pressure on the person watching, and view counts belong to
 * the author alone. You move at your own pace.
 */
import { api, ApiError } from './api.js';
import { toast, timeAgo, escapeHtml, avatarSrc, attachAvatarFallback, openModal, confirmDialog, el } from './ui.js';

const REACTIONS = ['❤️', '🔥', '😂', '😮', '😍', '👏'];

const BACKGROUNDS = {
  ember: 'linear-gradient(135deg,#7B35A8,#B03A93)',
  dusk: 'linear-gradient(135deg,#3B2A6B,#B0537E)',
  ocean: 'linear-gradient(135deg,#0F4C81,#3FA7D6)',
  forest: 'linear-gradient(135deg,#14532D,#4B9460)',
  mono: 'linear-gradient(135deg,#1F2430,#4A5162)'
};

/** Mirrors the server enum in validators.js (contentReportSchema). */
const REPORT_REASONS = [
  ['inappropriate', 'Inappropriate content'],
  ['harassment', 'Harassment or bullying'],
  ['spam', 'Spam'],
  ['scam', 'Scam or fraud'],
  ['fake', 'Fake profile'],
  ['impersonation', 'Impersonation'],
  ['threats', 'Threats or violence'],
  ['ncii', 'Intimate images shared without consent'],
  ['other', 'Something else']
];

const $ = (sel, root = document) => root.querySelector(sel);

let rails = [];
let viewer = { railIndex: 0, momentIndex: 0, open: false };

/* ------------------------------------------------------------------ *
 * Shared: the report sheet, reused by posts and comments
 * ------------------------------------------------------------------ */

export function reportSheet(targetType, targetId, label = 'this') {
  const wrap = el('div', { class: 'flex flex-col gap-1' });
  let chosen = null;

  for (const [value, text] of REPORT_REASONS) {
    const btn = el('button', {
      type: 'button',
      class: 'rounded-2xl px-4 py-3 text-left text-[14.5px] font-medium text-ink transition-colors hover:bg-surface-grey',
      text,
      onClick: () => {
        chosen = value;
        for (const other of wrap.children) {
          other.classList.toggle('bg-brand-50', other === btn);
          other.classList.toggle('text-brand-primary', other === btn);
        }
      }
    });
    wrap.append(btn);
  }

  return openModal({
    title: `Report ${label}`,
    body: wrap,
    actions: [
      { label: 'Cancel', value: null, class: 'btn-secondary' },
      {
        label: 'Report',
        value: 'sent',
        class: 'btn-danger',
        onClick: async () => {
          if (!chosen) {
            toast('Choose a reason first.', { type: 'error' });
            return false; // keeps the sheet open
          }
          try {
            const res = await api.reportContent(targetType, targetId, chosen);
            toast(res.isNew === false ? 'You already reported this.' : 'Thanks — our team will take a look.', {
              type: 'success'
            });
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not send that report.', { type: 'error' });
          }
        }
      }
    ]
  });
}

/* ------------------------------------------------------------------ *
 * Rail
 * ------------------------------------------------------------------ */

function railTile(rail, index) {
  const first = rail.moments[0];
  const ring = rail.isOwn
    ? 'ring-2 ring-brand-primary/40'
    : rail.hasUnseen
      ? 'ring-[3px] ring-brand-primary'
      : 'ring-2 ring-line opacity-70';

  return `
    <button type="button" class="flex w-[76px] shrink-0 flex-col items-center gap-1.5"
            data-rail="${index}" aria-label="Moments from ${escapeHtml(rail.author.displayName)}">
      <span class="relative block rounded-full p-[3px] ${ring}">
        <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(rail.author))}" alt=""
             class="h-16 w-16 rounded-full object-cover" data-fallback="${index}" />
        ${
          rail.moments.length > 1
            ? `<span class="absolute -bottom-0.5 -right-0.5 grid h-5 min-w-[20px] place-items-center rounded-full bg-brand-primary px-1 text-[10px] font-bold text-white">${rail.moments.length}</span>`
            : ''
        }
      </span>
      <span class="w-full truncate text-center text-[11.5px] font-medium text-ink-soft">
        ${rail.isOwn ? 'Your moment' : escapeHtml(first.author?.displayName || rail.author.displayName)}
      </span>
    </button>`;
}

function renderRails() {
  const tray = $('#moments-tray');

  const addTile = `
    <button type="button" class="flex w-[76px] shrink-0 flex-col items-center gap-1.5" data-action="new-moment"
            aria-label="Share a moment">
      <span class="grid h-[70px] w-[70px] place-items-center rounded-full border-2 border-dashed border-line text-ink-faint transition-colors hover:border-brand-primary hover:text-brand-primary">
        <svg viewBox="0 0 24 24" class="h-7 w-7 fill-none stroke-current" stroke-width="2" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke-linecap="round"/>
        </svg>
      </span>
      <span class="w-full truncate text-center text-[11.5px] font-medium text-ink-soft">Add</span>
    </button>`;

  tray.innerHTML = addTile + rails.map((r, i) => railTile(r, i)).join('');
  for (const img of tray.querySelectorAll('[data-fallback]')) {
    attachAvatarFallback(img, rails[Number(img.dataset.fallback)]?.author);
  }

  $('#moments-empty').classList.toggle('hidden', rails.length > 0);

  const own = rails.find((r) => r.isOwn);
  const stat = $('#my-moment-stat');
  if (own) {
    const views = own.moments.reduce((n, m) => n + (m.viewCount || 0), 0);
    stat.textContent = `${own.moments.length} live · ${views} view${views === 1 ? '' : 's'}`;
    stat.classList.remove('hidden');
  } else {
    stat.classList.add('hidden');
  }
}

/* ------------------------------------------------------------------ *
 * Full-screen viewer
 * ------------------------------------------------------------------ */

function currentMoment() {
  return rails[viewer.railIndex]?.moments[viewer.momentIndex] || null;
}

function timeLeftLabel(moment) {
  const secs = Number(moment.secondsLeft || 0);
  const h = Math.floor(secs / 3600);
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.round(secs / 60))}m left`;
}

async function renderViewer() {
  const moment = currentMoment();
  if (!moment) return closeViewer();

  const rail = rails[viewer.railIndex];
  const stage = $('#viewer-stage');

  $('#viewer-pips').innerHTML = rail.moments
    .map((_, i) => `<span class="h-[3px] flex-1 rounded-full ${i <= viewer.momentIndex ? 'bg-white' : 'bg-white/30'}"></span>`)
    .join('');

  const avatar = $('#viewer-avatar');
  avatar.src = avatarSrc(moment.author);
  attachAvatarFallback(avatar, moment.author);
  $('#viewer-name').textContent = moment.author.displayName;
  $('#viewer-meta').textContent = `${timeAgo(moment.createdAt)} · ${timeLeftLabel(moment)}`;
  $('#viewer-handle').href = `/@${moment.author.username}`;

  if (moment.kind === 'text') {
    stage.style.background = BACKGROUNDS[moment.background] || BACKGROUNDS.ember;
    stage.innerHTML = `<p class="max-w-[20ch] px-6 text-center text-[26px] font-extrabold leading-tight text-white">${escapeHtml(moment.body || '')}</p>`;
  } else if (moment.kind === 'video') {
    stage.style.background = '#000';
    stage.innerHTML = `<video src="${escapeHtml(moment.mediaUrl)}" class="max-h-full max-w-full" controls playsinline></video>`;
  } else {
    stage.style.background = '#000';
    stage.innerHTML = `<img src="${escapeHtml(moment.mediaUrl)}" alt="" class="max-h-full max-w-full object-contain" />`;
  }
  if (moment.kind !== 'text' && moment.body) {
    stage.insertAdjacentHTML(
      'beforeend',
      `<p class="pointer-events-none absolute bottom-6 left-4 right-4 rounded-2xl bg-black/55 px-4 py-2.5 text-center text-[15px] font-medium text-white">${escapeHtml(moment.body)}</p>`
    );
  }

  const footer = $('#viewer-footer');
  if (moment.isOwn) {
    // `viewCount` is omitted by the API for non-owners, so its presence is the signal.
    const views = moment.viewCount ?? 0;
    footer.innerHTML = `
      <button type="button" data-action="viewers" class="flex items-center gap-2 rounded-full bg-white/15 px-4 py-2.5 text-[14px] font-semibold text-white backdrop-blur">
        <svg viewBox="0 0 24 24" class="h-4 w-4 fill-current" aria-hidden="true"><path d="M12 5C6.5 5 2.7 9.2 1.5 12c1.2 2.8 5 7 10.5 7s9.3-4.2 10.5-7C21.3 9.2 17.5 5 12 5zm0 11a4 4 0 110-8 4 4 0 010 8z"/></svg>
        ${views} view${views === 1 ? '' : 's'}
      </button>
      <button type="button" data-action="delete-moment" class="rounded-full bg-white/15 px-4 py-2.5 text-[14px] font-semibold text-white backdrop-blur">Delete</button>`;
  } else {
    footer.innerHTML = `
      <div class="flex flex-1 items-center gap-1.5 overflow-x-auto">
        ${REACTIONS.map(
          (e) =>
            `<button type="button" data-react="${e}" aria-label="React with ${e}" aria-pressed="${moment.myReaction === e}"
                     class="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[21px] transition ${
                       moment.myReaction === e ? 'scale-110 bg-white' : 'bg-white/15 hover:bg-white/25'
                     }">${e}</button>`
        ).join('')}
      </div>
      <button type="button" data-action="reply" class="shrink-0 rounded-full bg-white px-4 py-2.5 text-[14px] font-bold text-ink">Reply</button>`;
  }

  const summary = $('#viewer-reactions');
  const list = (moment.reactions || []).filter((r) => r.count > 0);
  summary.innerHTML = list
    .map((r) => `<span class="rounded-full bg-white/15 px-2.5 py-1 text-[13px] text-white">${r.emoji} ${r.count}</span>`)
    .join('');

  // Register the view, then pull the detail payload (reaction breakdown).
  if (!moment.isOwn && !moment._seen) {
    moment._seen = true;
    rail.hasUnseen = rail.moments.some((m) => !m._seen && !m.isOwn);
    try {
      await api.viewMoment(moment.id);
      const fresh = await api.moment(moment.id);
      Object.assign(moment, fresh.moment || fresh, { _seen: true });
      if (currentMoment() === moment) renderViewer();
    } catch {
      /* a failed view ping must never break playback */
    }
  }
}

function openViewer(railIndex, momentIndex = 0) {
  viewer = { railIndex, momentIndex, open: true };
  const layer = $('#viewer');
  layer.classList.remove('hidden');
  layer.classList.add('flex');
  document.body.classList.add('overflow-hidden');
  renderViewer();
  $('#viewer-close').focus();
}

function closeViewer() {
  viewer.open = false;
  const layer = $('#viewer');
  layer.classList.add('hidden');
  layer.classList.remove('flex');
  document.body.classList.remove('overflow-hidden');
  $('#viewer-stage').innerHTML = ''; // stop any playing video
  renderRails();
}

/** Advance within the rail, then across rails, then close. */
function step(delta) {
  const rail = rails[viewer.railIndex];
  if (!rail) return closeViewer();

  const next = viewer.momentIndex + delta;
  if (next >= 0 && next < rail.moments.length) {
    viewer.momentIndex = next;
    return renderViewer();
  }
  const nextRail = viewer.railIndex + delta;
  if (nextRail < 0 || nextRail >= rails.length) return closeViewer();

  viewer.railIndex = nextRail;
  viewer.momentIndex = delta > 0 ? 0 : rails[nextRail].moments.length - 1;
  renderViewer();
}

/* ------------------------------------------------------------------ *
 * Viewer actions
 * ------------------------------------------------------------------ */

async function react(emoji) {
  const moment = currentMoment();
  if (!moment) return;
  const wasMine = moment.myReaction === emoji;
  try {
    const res = wasMine ? await api.unreactToMoment(moment.id) : await api.reactToMoment(moment.id, emoji);
    Object.assign(moment, res.moment || {}, { myReaction: wasMine ? null : emoji });
    renderViewer();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not save that reaction.', { type: 'error' });
  }
}

function replyBox() {
  const moment = currentMoment();
  if (!moment) return;

  const input = el('textarea', {
    id: 'moment-reply',
    class: 'field min-h-[96px] resize-y',
    rows: 3,
    maxlength: 2000,
    placeholder: 'Say something about their moment…'
  });
  const wrap = el('div', { class: 'text-left' }, [
    el('label', { class: 'label', for: 'moment-reply', text: `Message ${moment.author.displayName}` }),
    input,
    el('p', {
      class: 'mt-2 text-[12.5px] text-ink-faint',
      text: 'This lands in your private chat and follows that chat’s disappearing timer.'
    })
  ]);

  openModal({
    title: 'Reply to this moment',
    body: wrap,
    actions: [
      { label: 'Cancel', value: null, class: 'btn-secondary' },
      {
        label: 'Send',
        value: 'sent',
        class: 'btn-primary',
        onClick: async () => {
          const body = input.value.trim();
          if (!body) {
            toast('Write something first.', { type: 'error' });
            return false;
          }
          try {
            await api.replyToMoment(moment.id, body);
            toast('Sent to your chat.', { type: 'success' });
          } catch (err) {
            toast(
              err instanceof ApiError && err.status === 403
                ? 'You can reply once you two have matched.'
                : 'Could not send that reply.',
              { type: 'error' }
            );
          }
        }
      }
    ]
  });
  setTimeout(() => input.focus(), 60);
}

async function showViewers() {
  const moment = currentMoment();
  if (!moment) return;
  try {
    const { viewers } = await api.momentViewers(moment.id);
    let body;
    if (!viewers.length) {
      body = 'Nobody has seen this one yet.';
    } else {
      body = el('div', { class: 'flex max-h-[50vh] flex-col gap-1 overflow-y-auto text-left' });
      body.innerHTML = viewers
        .map(
          (v) => `
        <a href="/@${escapeHtml(v.username)}" class="flex items-center gap-3 rounded-2xl p-2 transition-colors hover:bg-surface-grey">
          <img loading="lazy" decoding="async" src="${escapeHtml(avatarSrc(v))}" alt="" class="h-10 w-10 rounded-full object-cover" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[14.5px] font-semibold text-ink">${escapeHtml(v.displayName)}</span>
            <span class="block text-[12.5px] text-ink-faint">${escapeHtml(timeAgo(v.viewedAt))}</span>
          </span>
          ${v.reaction ? `<span class="text-[18px]">${v.reaction}</span>` : ''}
        </a>`
        )
        .join('');
    }
    openModal({
      title: `Viewers (${viewers.length})`,
      body,
      actions: [{ label: 'Close', value: null, class: 'btn-secondary' }]
    });
  } catch {
    toast('Could not load viewers.', { type: 'error' });
  }
}

async function removeMoment() {
  const moment = currentMoment();
  if (!moment) return;
  const yes = await confirmDialog({
    title: 'Delete this moment?',
    message: 'It disappears for everyone straight away, and any photo is removed from storage.',
    confirmLabel: 'Delete',
    danger: true
  });
  if (!yes) return;
  try {
    await api.deleteMoment(moment.id);
    toast('Moment deleted.', { type: 'success' });
    closeViewer();
    await load();
  } catch {
    toast('Could not delete that moment.', { type: 'error' });
  }
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */

function composer() {
  const wrap = el('div', { class: 'text-left' });
  wrap.innerHTML = `
    <div class="flex flex-col gap-3">
      <div class="flex gap-1 rounded-xl bg-surface-grey p-1" role="tablist" aria-label="Moment type">
        <button type="button" class="seg-tab is-active" data-kind="text" role="tab" aria-selected="true">Text</button>
        <button type="button" class="seg-tab" data-kind="photo" role="tab" aria-selected="false">Photo or video</button>
      </div>

      <div data-panel="text">
        <label class="label" for="moment-body">What is happening right now?</label>
        <textarea id="moment-body" class="field min-h-[104px] resize-y" rows="3" maxlength="500"
                  placeholder="Keep it short and in the moment…"></textarea>
        <span class="label mt-3 block">Background</span>
        <div class="flex flex-wrap gap-2" role="group" aria-label="Background colour">
          ${Object.entries(BACKGROUNDS)
            .map(
              ([key, css], i) =>
                `<button type="button" data-bg="${key}" aria-label="${key}" aria-pressed="${i === 0}"
                         class="h-9 w-9 rounded-full ${i === 0 ? 'ring-2 ring-brand-primary ring-offset-2' : ''}"
                         style="background:${css}"></button>`
            )
            .join('')}
        </div>
      </div>

      <div data-panel="photo" class="hidden">
        <label class="label" for="moment-file">Choose a file</label>
        <input id="moment-file" type="file" accept="image/*,video/*" class="field" />
        <label class="label mt-3" for="moment-caption">Caption (optional)</label>
        <input id="moment-caption" type="text" class="field" maxlength="500" placeholder="Add a caption…" />
      </div>

      <p class="text-[12.5px] leading-relaxed text-ink-faint">
        Moments disappear after 24 hours. Anyone on Ember can watch yours; only people you have matched with can reply.
      </p>
    </div>`;

  let kind = 'text';
  let background = 'ember';

  wrap.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-kind]');
    if (tab) {
      kind = tab.dataset.kind;
      for (const t of wrap.querySelectorAll('[data-kind]')) {
        t.classList.toggle('is-active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      }
      wrap.querySelector('[data-panel="text"]').classList.toggle('hidden', kind !== 'text');
      wrap.querySelector('[data-panel="photo"]').classList.toggle('hidden', kind !== 'photo');
      return;
    }
    const bg = e.target.closest('[data-bg]');
    if (bg) {
      background = bg.dataset.bg;
      for (const b of wrap.querySelectorAll('[data-bg]')) {
        const on = b === bg;
        b.classList.toggle('ring-2', on);
        b.classList.toggle('ring-brand-primary', on);
        b.classList.toggle('ring-offset-2', on);
        b.setAttribute('aria-pressed', String(on));
      }
    }
  });

  openModal({
    title: 'Share a moment',
    body: wrap,
    actions: [
      { label: 'Cancel', value: null, class: 'btn-secondary' },
      {
        label: 'Share',
        value: 'shared',
        class: 'btn-primary',
        onClick: async () => {
          try {
            if (kind === 'text') {
              const body = wrap.querySelector('#moment-body').value.trim();
              if (!body) {
                toast('Write something first.', { type: 'error' });
                return false;
              }
              await api.createMoment({ kind: 'text', body, background });
            } else {
              const file = wrap.querySelector('#moment-file').files?.[0];
              if (!file) {
                toast('Choose a photo or video.', { type: 'error' });
                return false;
              }
              const caption = wrap.querySelector('#moment-caption').value.trim();
              const media = await api.uploadSocial(file);
              await api.createMoment({
                kind: media.kind,
                body: caption || null,
                media: {
                  kind: media.kind,
                  url: media.url,
                  thumbUrl: media.thumbUrl,
                  fileKey: media.fileKey,
                  thumbKey: media.thumbKey
                }
              });
            }
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not share that.', { type: 'error' });
            return false;
          }

          // Saved. A failing feed refresh is not a failed post — see posts.js.
          toast('Your moment is live for 24 hours.', { type: 'success' });
          try {
            await load();
          } catch {
            toast('Shared, but the feed could not refresh. Pull to reload.', { type: 'info' });
          }
        }
      }
    ]
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function load() {
  try {
    const res = await api.momentsFeed();
    rails = res.rails || [];
    renderRails();
  } catch {
    toast('Could not load moments.', { type: 'error' });
  }
}

export function initMoments() {
  $('#moments-tray').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="new-moment"]')) return composer();
    const tile = e.target.closest('[data-rail]');
    if (tile) openViewer(Number(tile.dataset.rail));
  });

  $('#moments-empty')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="new-moment"]')) composer();
  });

  const layer = $('#viewer');
  layer.addEventListener('click', (e) => {
    if (e.target.closest('#viewer-close')) return closeViewer();
    if (e.target.closest('[data-action="reply"]')) return replyBox();
    if (e.target.closest('[data-action="viewers"]')) return showViewers();
    if (e.target.closest('[data-action="delete-moment"]')) return removeMoment();
    if (e.target.closest('[data-action="report-moment"]')) {
      const m = currentMoment();
      if (m) reportSheet('moment', m.id, 'this moment');
      return;
    }
    const emoji = e.target.closest('[data-react]');
    if (emoji) return react(emoji.dataset.react);
    if (e.target.closest('#viewer-prev')) return step(-1);
    if (e.target.closest('#viewer-next')) return step(1);
  });

  document.addEventListener('keydown', (e) => {
    if (!viewer.open) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  });

  window.addEventListener('hashchange', () => {
    openFromHash();
  });

  return load().then(() => openFromHash());
}

/**
 * Notifications link to `/moments#moment-<id>`. A moment is not a scrollable
 * element -- it lives inside a rail and opens in the full-screen viewer -- so
 * the native anchor jump could never work. Find it across the loaded rails and
 * open the viewer at that exact position instead.
 */
async function openFromHash() {
  const m = /^#moment-(\d+)$/.exec(location.hash);
  if (!m) return;
  const wanted = String(m[1]);

  const find = () => {
    for (let r = 0; r < rails.length; r += 1) {
      const i = rails[r].moments.findIndex((mo) => String(mo.id) === wanted);
      if (i !== -1) return { r, i };
    }
    return null;
  };

  let hit = find();
  if (!hit) {
    // The notification may be for a moment posted after this page loaded, so
    // the in-memory rails are simply stale. Refetch once before giving up.
    await load();
    hit = find();
  }
  if (hit) return openViewer(hit.r, hit.i);

  // Moments last 24 hours; a stale notification is normal, not an error.
  toast('That moment is no longer available.');
}
