/** register.js — page script for register.html (external so the strict CSP allows it). */
import { api, setCsrfToken, ApiError } from '/js/api.js';
import { $, $$, toast, withBusy, initialsAvatar } from '/js/ui.js';
import { redirectIfAuthed } from '/js/app-shell.js';
import { initThemeToggle } from '/js/theme.js';

redirectIfAuthed();
initThemeToggle();

const TOTAL_STEPS = 4;
let step = 1;
let pendingPhoto = null;

const state = { gender: null, interestedIn: 'everyone' };
let usernameTaken = null;   // last handle the server told us was unavailable
let usernameTimer = null;

const stepLabel = $('#step-label');
const formError = $('#form-error');

function showFieldError(id, message) {
  const input = $(`#${id}`);
  const node = $(`#${id}-error`);
  if (!node) return;
  if (message) {
    input?.classList.add('field-error');
    input?.setAttribute('aria-invalid', 'true');
    node.textContent = message;
    node.classList.remove('hidden');
  } else {
    input?.classList.remove('field-error');
    input?.removeAttribute('aria-invalid');
    node.classList.add('hidden');
  }
}

function clearErrors() {
  formError.classList.add('hidden');
  for (const node of $$('.error-text')) node.classList.add('hidden');
  for (const node of $$('.field-error')) node.classList.remove('field-error');
}

function render() {
  for (const section of $$('[data-step]')) {
    section.classList.toggle('hidden', Number(section.dataset.step) !== step);
  }
  for (const bar of $$('[data-step-bar]')) {
    const n = Number(bar.dataset.stepBar);
    bar.className = `h-1.5 flex-1 rounded-full transition-all ${n <= step ? 'bg-brand-gradient' : 'bg-surface-cool'}`;
  }
  stepLabel.textContent = `Step ${step} of ${TOTAL_STEPS}`;
  $('#progress').setAttribute('aria-valuenow', String(step));

  $('#back').classList.toggle('hidden', step === 1);
  $('#next').classList.toggle('hidden', step === TOTAL_STEPS);
  $('#finish').classList.toggle('hidden', step !== TOTAL_STEPS);
  $('#next').textContent = 'Continue';

  // Move focus to the new step's heading for screen readers.
  const active = $(`[data-step="${step}"] h1`);
  if (active) {
    active.setAttribute('tabindex', '-1');
    active.focus({ preventScroll: true });
  }
}

// ------------------------------------------------------------- validation
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._]*[a-z0-9])?$/;

/** Mirrors the server rules so we can fail fast without a round trip. */
function usernameProblem(value) {
  if (value.length < 3) return 'Username must be at least 3 characters.';
  if (value.length > 30) return 'Username must be at most 30 characters.';
  if (!USERNAME_RE.test(value)) {
    return 'Use letters, numbers, dots or underscores, starting and ending with a letter or number.';
  }
  if (/\.\.|__|\._|_\./.test(value)) return 'No repeated dots or underscores.';
  return null;
}

function validateStep(n) {
  clearErrors();
  let ok = true;

  if (n === 1) {
    const email = $('#email').value.trim();
    const username = $('#username').value.trim().toLowerCase();
    const password = $('#password').value;
    if (!EMAIL_RE.test(email)) {
      showFieldError('email', 'Enter a valid email address.');
      ok = false;
    }
    const usernameIssue = usernameProblem(username);
    if (usernameIssue) {
      showFieldError('username', usernameIssue);
      ok = false;
    } else if (usernameTaken === username) {
      showFieldError('username', 'That username is already taken.');
      ok = false;
    }
    if (password.length < 8) {
      showFieldError('password', 'Password must be at least 8 characters.');
      ok = false;
    } else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      showFieldError('password', 'Include at least one letter and one number.');
      ok = false;
    }
  }

  if (n === 2) {
    const name = $('#displayName').value.trim();
    const birthdate = $('#birthdate').value;
    if (name.length < 2) {
      showFieldError('displayName', 'Name must be at least 2 characters.');
      ok = false;
    }
    if (!birthdate) {
      showFieldError('birthdate', 'Enter your date of birth.');
      ok = false;
    } else {
      const age = (Date.now() - Date.parse(birthdate)) / (365.25 * 24 * 3600 * 1000);
      if (Number.isNaN(age)) {
        showFieldError('birthdate', 'That date is not valid.');
        ok = false;
      } else if (age < 18) {
        showFieldError('birthdate', 'You must be at least 18 to use Ember.');
        ok = false;
      } else if (age > 120) {
        showFieldError('birthdate', 'Please check your date of birth.');
        ok = false;
      }
    }
    if (!state.gender) {
      $('#gender-error').textContent = 'Choose one so we can show you to the right people.';
      $('#gender-error').classList.remove('hidden');
      ok = false;
    }
  }

  if (n === 3) {
    if ($('#bio').value.length > 500) {
      showFieldError('bio', 'Bio must be at most 500 characters.');
      ok = false;
    }
  }

  return ok;
}

// ---------------------------------------------------------------- controls
$('#next').addEventListener('click', () => {
  if (!validateStep(step)) return;
  step = Math.min(TOTAL_STEPS, step + 1);
  render();
});

$('#back').addEventListener('click', () => {
  clearErrors();
  step = Math.max(1, step - 1);
  render();
});

// Enter advances instead of submitting early.
$('#wizard').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && step < TOTAL_STEPS) {
    e.preventDefault();
    $('#next').click();
  }
});

for (const btn of $$('[data-field]')) {
  btn.addEventListener('click', () => {
    const { field, value } = btn.dataset;
    state[field] = value;
    for (const sibling of $$(`[data-field="${field}"]`)) {
      sibling.setAttribute('aria-pressed', String(sibling === btn));
    }
    if (field === 'gender') $('#gender-error').classList.add('hidden');
  });
}

$('#toggle-password').addEventListener('click', (e) => {
  const input = $('#password');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  e.currentTarget.setAttribute('aria-pressed', String(!showing));
  e.currentTarget.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});

// password strength
$('#password').addEventListener('input', (e) => {
  const v = e.target.value;
  let score = 0;
  if (v.length >= 8) score += 1;
  if (v.length >= 12) score += 1;
  if (/[A-Za-z]/.test(v) && /\d/.test(v)) score += 1;
  if (/[^A-Za-z0-9]/.test(v)) score += 1;

  const colours = ['bg-surface-cool', 'bg-nope', 'bg-rewind', 'bg-rewind', 'bg-like'];
  const labels = ['', 'Weak', 'Okay', 'Good', 'Strong'];
  for (const bar of $$('[data-strength]')) {
    const n = Number(bar.dataset.strength);
    bar.className = `h-1 flex-1 rounded-full ${n <= score ? colours[score] : 'bg-surface-cool'}`;
  }
  $('#strength-label').textContent = labels[score] || '\u00a0';
});

$('#bio').addEventListener('input', (e) => {
  $('#bio-used').textContent = String(e.target.value.length);
});

// photo preview
$('#photo').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  showFieldError('photo', '');
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    showFieldError('photo', 'That image is larger than 10MB.');
    e.target.value = '';
    return;
  }
  pendingPhoto = file;
  const reader = new FileReader();
  reader.onload = () => {
    $('#photo-preview').src = reader.result;
  };
  reader.readAsDataURL(file);
});

// ------------------------------------------------- live username availability
const usernameInput = $('#username');
const usernameStatus = $('#username-status');
const usernameLive = $('#username-live');

function setUsernameStatus(text, tone) {
  usernameStatus.textContent = text;
  usernameStatus.className =
    `absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-semibold ${
      tone === 'ok' ? 'text-like' : tone === 'bad' ? 'text-nope' : 'text-ink-faint'
    }`;
  if (text) usernameLive.textContent = text;
}

usernameInput.addEventListener('input', () => {
  // Normalise as they type so what they see is what gets stored.
  const cleaned = usernameInput.value.toLowerCase().replace(/[^a-z0-9._]/g, '');
  if (cleaned !== usernameInput.value) usernameInput.value = cleaned;

  clearTimeout(usernameTimer);
  usernameTaken = null;
  showFieldError('username', '');

  if (!cleaned) return setUsernameStatus('', 'mute');
  const issue = usernameProblem(cleaned);
  if (issue) return setUsernameStatus('', 'mute');

  setUsernameStatus('checking…', 'mute');
  usernameTimer = setTimeout(async () => {
    try {
      const res = await api.usernameAvailable(cleaned);
      if (usernameInput.value.trim() !== cleaned) return;  // raced ahead
      if (res.available) {
        setUsernameStatus('available', 'ok');
      } else {
        usernameTaken = cleaned;
        setUsernameStatus('taken', 'bad');
      }
    } catch {
      setUsernameStatus('', 'mute');   // availability is a nicety; submit still validates
    }
  }, 350);
});

$('#displayName').addEventListener('input', (e) => {
  if (!pendingPhoto) $('#photo-preview').src = initialsAvatar(e.target.value || '?', 0);
});
$('#photo-preview').src = initialsAvatar('?', 0);

// ------------------------------------------------------------------ submit
$('#wizard').addEventListener('submit', async (e) => {
  e.preventDefault();
  for (let n = 1; n <= 3; n += 1) {
    if (!validateStep(n)) {
      step = n;
      render();
      return;
    }
  }
  clearErrors();

  const payload = {
    email: $('#email').value.trim(),
    username: $('#username').value.trim().toLowerCase(),
    password: $('#password').value,
    displayName: $('#displayName').value.trim(),
    birthdate: $('#birthdate').value,
    gender: state.gender,
    interestedIn: state.interestedIn,
    bio: $('#bio').value.trim() || null,
    city: $('#city').value.trim() || null
  };

  const restore = withBusy($('#finish'), 'Creating…');
  try {
    const data = await api.register(payload);
    setCsrfToken(data.csrfToken);

    if (pendingPhoto) {
      try {
        await api.uploadPhoto(pendingPhoto);
      } catch (photoErr) {
        toast(photoErr.message || 'Your photo could not be uploaded — add it from your profile.', { type: 'error' });
      }
    }
    location.replace('/app');
  } catch (err) {
    restore();
    if (err instanceof ApiError && err.details && Object.keys(err.details).length) {
      let firstStep = TOTAL_STEPS;
      const stepOf = { email: 1, username: 1, password: 1, displayName: 2, birthdate: 2, gender: 2, interestedIn: 2, bio: 3, city: 3 };
      for (const [field, message] of Object.entries(err.details)) {
        showFieldError(field, message);
        firstStep = Math.min(firstStep, stepOf[field] ?? TOTAL_STEPS);
      }
      step = firstStep;
      render();
    }
    formError.textContent = err.message || 'We could not create your account.';
    formError.classList.remove('hidden');
    formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

render();
