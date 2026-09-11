/** profile.js — page module for profile.html (external so the strict CSP allows it). */
import { bootPage, wireSignOut } from '/js/app-shell.js';
import { api, ApiError } from '/js/api.js';
import {
  $, $$, el, escapeHtml, toast, confirmDialog, openModal, withBusy,
  avatarSrc, attachAvatarFallback, markActiveTab, photoSrcset
} from '/js/ui.js';

await bootPage({ socket: true, badges: true });
markActiveTab();
wireSignOut();

let profile = null;
let photos = [];
let catalogue = [];      // interest vocabulary from the server
let selected = new Set();// slugs the user has picked
let promptCatalogue = [];
let prompts = [];

// ------------------------------------------------------------------ render

function paint() {
  $('#me-name').textContent = profile.displayName || '';
  const bits = [];
  if (profile.age) bits.push(String(profile.age));
  if (profile.city) bits.push(profile.city);
  $('#me-meta').textContent = bits.join(' · ') || 'Add your details below';

  const avatar = $('#me-avatar');
  avatar.src = avatarSrc(profile);
  attachAvatarFallback(avatar, profile);

  $('#stat-photos').textContent = String(photos.length);

  $('#displayName').value = profile.displayName || '';
  $('#username').value = profile.username || '';
  if (profile.username) $('#me-handle').textContent = `@${profile.username}`;
  $('#bio').value = profile.bio || '';
  $('#city').value = profile.city || '';
  $('#birthdate').value = profile.birthdate ? String(profile.birthdate).slice(0, 10) : '';
  $('#bio-count').textContent = String(($('#bio').value || '').length);

  $('#jobTitle').value = profile.jobTitle || '';
  $('#school').value = profile.school || '';
  $('#heightCm').value = profile.heightCm || '';

  setChip('gender', profile.gender);
  setChip('interestedIn', profile.interestedIn || 'everyone');
  setChip('intent', profile.intent);

  paintPhotos();
}

function setChip(field, value) {
  for (const btn of $$(`[data-field="${field}"]`)) {
    btn.setAttribute('aria-pressed', String(btn.dataset.value === value));
  }
}

function getChip(field) {
  const on = $$(`[data-field="${field}"]`).find((b) => b.getAttribute('aria-pressed') === 'true');
  return on ? on.dataset.value : null;
}

function paintPhotos() {
  const grid = $('#photo-grid');
  const tiles = photos.map((photo, index) => {
    const shot = photoSrcset(photo);
    const li = el('li', { class: 'relative aspect-[3/4] overflow-hidden rounded-3xl bg-surface-cool shadow-card' });
    li.innerHTML = `
      <img loading="lazy" decoding="async" src="${escapeHtml(shot.src)}"${shot.srcset ? ` srcset="${escapeHtml(shot.srcset)}" sizes="${escapeHtml(shot.sizes)}"` : ''} alt="Profile photo ${index + 1}" class="h-full w-full object-cover" />
      ${index === 0 ? '<span class="absolute left-2 top-2 rounded-full bg-brand-gradient px-2 py-0.5 text-[11px] font-bold text-white">Main</span>' : ''}
      <button type="button" class="absolute inset-0 h-full w-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-primary/40"
              data-photo-id="${photo.id}" aria-label="Options for photo ${index + 1}"></button>`;
    return li;
  });

  // Trailing "add" tile, while there is room for more.
  if (photos.length < 6) {
    const add = el('li', { class: 'aspect-[3/4]' });
    add.innerHTML = `
      <button type="button" id="add-photo"
              class="grid h-full w-full place-items-center rounded-3xl border-2 border-dashed border-line/[var(--line-a)] text-ink-faint transition hover:border-brand-primary hover:text-brand-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-primary/30"
              aria-label="Add a photo">
        <svg viewBox="0 0 24 24" class="h-8 w-8 fill-current" aria-hidden="true"><path d="M13 5h-2v6H5v2h6v6h2v-6h6v-2h-6z"/></svg>
      </button>`;
    tiles.push(add);
  }

  grid.replaceChildren(...tiles);
  $('#photo-hint').classList.toggle('hidden', photos.length === 0);
}

// ------------------------------------------------------------------ photos

async function pickPhoto() {
  $('#photo-input').click();
}

$('#photo-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = ''; // let the same file be picked again after a failure
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    toast('Photos must be 10 MB or smaller.', { type: 'error' });
    return;
  }

  const wrap = $('#upload-progress');
  const bar = $('#upload-bar');
  wrap.classList.remove('hidden');
  bar.style.width = '8%';

  try {
    const res = await api.uploadPhoto(file);
    photos = res.photos;
    bar.style.width = '100%';
    if (photos.length === 1) profile.avatarUrl = photos[0].url;
    paint();
    toast('Photo added.', { type: 'success' });
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not upload that photo.', { type: 'error' });
  } finally {
    setTimeout(() => {
      wrap.classList.add('hidden');
      bar.style.width = '0%';
    }, 400);
  }
});

/** Tapping a photo opens make-main / remove. */
$('#photo-grid').addEventListener('click', async (event) => {
  if (event.target.closest('#add-photo')) {
    pickPhoto();
    return;
  }
  const trigger = event.target.closest('[data-photo-id]');
  if (!trigger) return;

  const photoId = Number(trigger.dataset.photoId);
  const isMain = photos[0]?.id === photoId;

  const choice = await openModal({
    title: 'Photo options',
    body: 'Choose what to do with this photo.',
    actions: [
      ...(isMain ? [] : [{ label: 'Make main photo', value: 'main', class: 'btn-primary btn-block' }]),
      { label: 'Remove photo', value: 'remove', class: 'btn-danger btn-block' },
      { label: 'Cancel', value: null, class: 'btn-secondary btn-block' }
    ]
  });

  if (choice === 'main') {
    const reordered = [photoId, ...photos.filter((p) => p.id !== photoId).map((p) => p.id)];
    try {
      const res = await api.reorderPhotos(reordered);
      photos = res.photos;
      profile.avatarUrl = photos[0]?.url || null;
      paint();
      toast('Main photo updated.', { type: 'success' });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not reorder photos.', { type: 'error' });
    }
  }

  if (choice === 'remove') {
    const sure = await confirmDialog({
      title: 'Remove this photo?',
      message: 'It will be deleted from your profile straight away.',
      confirmLabel: 'Remove',
      danger: true
    });
    if (!sure) return;
    try {
      const res = await api.deletePhoto(photoId);
      photos = res.photos;
      profile.avatarUrl = photos[0]?.url || null;
      paint();
      toast('Photo removed.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove that photo.', { type: 'error' });
    }
  }
});

$('#change-avatar').addEventListener('click', pickPhoto);

// ------------------------------------------------------------------- chips

for (const btn of $$('[data-field]')) {
  btn.addEventListener('click', () => {
    // interestedIn always keeps a value; gender can be toggled back off.
    const already = btn.getAttribute('aria-pressed') === 'true';
    if (already && btn.dataset.field === 'gender') setChip('gender', null);
    else setChip(btn.dataset.field, btn.dataset.value);
  });
}

// -------------------------------------------------------------------- form

$('#bio').addEventListener('input', (e) => {
  $('#bio-count').textContent = String(e.target.value.length);
});

function showFieldError(name, message) {
  const node = $(`[data-error-for="${name}"]`);
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
  $(`#${name}`)?.setAttribute('aria-invalid', message ? 'true' : 'false');
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._]*[a-z0-9])?$/;

/** Same rules as the server, so we can tell them before they hit save. */
function usernameProblem(value) {
  if (value.length < 3) return 'Username must be at least 3 characters.';
  if (value.length > 30) return 'Username must be at most 30 characters.';
  if (!USERNAME_RE.test(value)) {
    return 'Use letters, numbers, dots or underscores, starting and ending with a letter or number.';
  }
  if (/\.\.|__|\._|_\./.test(value)) return 'No repeated dots or underscores.';
  return null;
}

let usernameTimer = null;

$('#username').addEventListener('input', () => {
  const input = $('#username');
  const cleaned = input.value.toLowerCase().replace(/[^a-z0-9._]/g, '');
  if (cleaned !== input.value) input.value = cleaned;

  clearTimeout(usernameTimer);
  showFieldError('username', '');
  const status = $('#username-status');
  const setStatus = (text, tone) => {
    status.textContent = text;
    status.className = `absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-semibold ${
      tone === 'ok' ? 'text-like' : tone === 'bad' ? 'text-nope' : 'text-ink-faint'
    }`;
    if (text) $('#username-live').textContent = text;
  };

  if (!cleaned || cleaned === profile.username) return setStatus('', 'mute');
  if (usernameProblem(cleaned)) return setStatus('', 'mute');

  setStatus('checking…', 'mute');
  usernameTimer = setTimeout(async () => {
    try {
      const res = await api.usernameAvailable(cleaned);
      if ($('#username').value.trim() !== cleaned) return;
      setStatus(res.available ? 'available' : 'taken', res.available ? 'ok' : 'bad');
    } catch {
      setStatus('', 'mute');
    }
  }, 350);
});

$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  for (const name of ['displayName', 'username', 'bio', 'city', 'birthdate']) showFieldError(name, '');

  const displayName = $('#displayName').value.trim();
  if (displayName.length < 2) {
    showFieldError('displayName', 'Please enter at least 2 characters.');
    $('#displayName').focus();
    return;
  }

  const username = $('#username').value.trim().toLowerCase();
  const usernameIssue = usernameProblem(username);
  if (usernameIssue) {
    showFieldError('username', usernameIssue);
    $('#username').focus();
    return;
  }

  const payload = {
    displayName,
    username,
    bio: $('#bio').value.trim() || null,
    city: $('#city').value.trim() || null,
    birthdate: $('#birthdate').value || null,
    interestedIn: getChip('interestedIn') || 'everyone',
    jobTitle: $('#jobTitle').value.trim() || null,
    school: $('#school').value.trim() || null,
    heightCm: $('#heightCm').value ? Number($('#heightCm').value) : null
  };
  const gender = getChip('gender');
  if (gender) payload.gender = gender;
  const intent = getChip('intent');
  if (intent) payload.intent = intent;

  const done = withBusy($('#save-profile'), 'Saving…');
  try {
    const res = await api.updateProfile(payload);
    profile = { ...profile, ...res.user };
    photos = res.user.photos || photos;
    paint();
    toast('Profile saved.', { type: 'success' });
  } catch (err) {
    if (err instanceof ApiError && err.details?.fieldErrors) {
      for (const [field, messages] of Object.entries(err.details.fieldErrors)) {
        showFieldError(field, Array.isArray(messages) ? messages[0] : String(messages));
      }
      toast('Please check the highlighted fields.', { type: 'error' });
    } else if (err instanceof ApiError && err.code === 'USERNAME_TAKEN') {
      showFieldError('username', 'That username is already taken.');
      $('#username').focus();
      toast('That username is already taken.', { type: 'error' });
    } else {
      toast(err instanceof ApiError ? err.message : 'Could not save your profile.', { type: 'error' });
    }
  } finally {
    done();
  }
});

// ----------------------------------------------------------- delete account

$('#delete-account').addEventListener('click', async () => {
  const sure = await confirmDialog({
    title: 'Delete your account?',
    message:
      'Your profile, photos, matches and messages are deleted immediately. This cannot be undone.',
    confirmLabel: 'Delete everything',
    danger: true
  });
  if (!sure) return;

  try {
    await api.deleteAccount();
    toast('Your account has been deleted.');
    setTimeout(() => location.replace('/'), 600);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not delete your account.', { type: 'error' });
  }
});

// --------------------------------------------------------------- interests

function paintInterests() {
  $('#interest-count').textContent = String(selected.size);

  $('#interest-picker').innerHTML = catalogue
    .map(
      (group) => `
      <div>
        <h4 class="mb-2 text-[12.5px] font-bold uppercase tracking-wide text-ink-faint">${escapeHtml(group.category)}</h4>
        <div class="flex flex-wrap gap-2">
          ${group.items
    .map(
      (item) => `<button type="button" class="chip-option !py-1.5 text-[13px]" data-interest="${escapeHtml(item.slug)}"
                          aria-pressed="${selected.has(item.slug) ? 'true' : 'false'}">
                     ${item.emoji ? `${escapeHtml(item.emoji)} ` : ''}${escapeHtml(item.label)}
                   </button>`
    )
    .join('')}
        </div>
      </div>`
    )
    .join('');
}

$('#interest-picker').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-interest]');
  if (!button) return;
  const slug = button.dataset.interest;

  if (selected.has(slug)) {
    selected.delete(slug);
  } else {
    if (selected.size >= 8) return toast('That is the maximum of 8 interests.', { type: 'error' });
    selected.add(slug);
  }
  button.setAttribute('aria-pressed', selected.has(slug) ? 'true' : 'false');
  $('#interest-count').textContent = String(selected.size);

  try {
    await api.setInterests([...selected]);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not save interests.', { type: 'error' });
  }
});

// ----------------------------------------------------------------- prompts

function paintPrompts() {
  const list = $('#prompt-list');
  if (!prompts.length) {
    list.innerHTML = '<p class="text-[13px] text-ink-soft">No prompts answered yet.</p>';
  } else {
    list.innerHTML = prompts
      .map(
        (p, i) => `
        <div class="rounded-3xl border border-line/[var(--line-a)] p-3.5" data-prompt-index="${i}">
          <p class="text-[12.5px] font-bold text-brand-primary">${escapeHtml(p.question)}</p>
          <p class="mt-1 text-[14px] text-ink">${escapeHtml(p.answer)}</p>
          <button type="button" class="mt-2 text-[12.5px] font-semibold text-nope" data-remove-prompt="${i}">Remove</button>
        </div>`
      )
      .join('');
  }
  $('#add-prompt').classList.toggle('hidden', prompts.length >= 3);
}

async function savePrompts() {
  try {
    const res = await api.setPrompts(prompts.map((p) => ({ key: p.key, answer: p.answer })));
    prompts = res.prompts;
    paintPrompts();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not save prompts.', { type: 'error' });
  }
}

$('#prompt-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-remove-prompt]');
  if (!button) return;
  prompts.splice(Number(button.dataset.removePrompt), 1);
  await savePrompts();
});

$('#add-prompt').addEventListener('click', async () => {
  const used = new Set(prompts.map((p) => p.key));
  const available = promptCatalogue.filter((p) => !used.has(p.key));
  if (!available.length) return;

  const modal = openModal({
    title: 'Choose a prompt',
    body: htmlNode(`
      <div class="text-left">
        <label class="label" for="prompt-key">Prompt</label>
        <select class="field" id="prompt-key">
          ${available.map((p) => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.text)}</option>`).join('')}
        </select>
        <label class="label mt-3" for="prompt-answer">Your answer</label>
        <textarea class="field min-h-[88px] resize-y" id="prompt-answer" maxlength="200"
                  placeholder="Keep it short and specific…"></textarea>
      </div>`),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save', value: 'save', class: 'btn-primary' }
    ]
  });

  const panel = modal.panel;
  const choice = await modal;
  if (choice !== 'save') return;

  const key = panel.querySelector('#prompt-key').value;
  const answer = panel.querySelector('#prompt-answer').value.trim();
  if (!answer) return toast('Write an answer first.', { type: 'error' });

  prompts.push({ key, answer, question: promptCatalogue.find((p) => p.key === key)?.text || key });
  await savePrompts();
});

/** Local helper: openModal escapes string bodies, so pass a node for markup. */
function htmlNode(markup) {
  const wrap = document.createElement('div');
  wrap.innerHTML = markup;
  return wrap;
}

// -------------------------------------------------------------------- load

try {
  const [me1, matchData, interestData, myInterests, promptData] = await Promise.all([
    api.profile(),
    api.matches().catch(() => null),
    api.interestCatalogue().catch(() => ({ categories: [] })),
    api.myInterests().catch(() => ({ interests: [] })),
    api.promptCatalogue().catch(() => ({ prompts: [] }))
  ]);

  profile = me1.user;
  photos = me1.user.photos || [];
  prompts = me1.user.prompts || [];
  catalogue = interestData.categories || [];
  selected = new Set((myInterests.interests || []).map((i) => i.slug));
  promptCatalogue = promptData.prompts || [];

  $('#stat-likes').textContent = String(me1.likesReceived ?? 0);
  $('#stat-matches').textContent = String(matchData?.matches?.length ?? 0);

  paint();
  paintInterests();
  paintPrompts();
} catch {
  toast('Could not load your profile.', { type: 'error' });
}
