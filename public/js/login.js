/** login.js — page script for login.html (external so the strict CSP allows it). */
import { api, setCsrfToken, ApiError } from '/js/api.js';
import { $, toast, withBusy } from '/js/ui.js';
import { redirectIfAuthed } from '/js/app-shell.js';
import { initThemeToggle } from '/js/theme.js';

redirectIfAuthed();
initThemeToggle();

const form = $('#login-form');
const formError = $('#form-error');
const emailInput = $('#email');
const passwordInput = $('#password');

function showFieldError(input, id, message) {
  const node = $(`#${id}`);
  if (message) {
    input.classList.add('field-error');
    input.setAttribute('aria-invalid', 'true');
    node.textContent = message;
    node.classList.remove('hidden');
  } else {
    input.classList.remove('field-error');
    input.removeAttribute('aria-invalid');
    node.classList.add('hidden');
  }
}

function clearErrors() {
  formError.classList.add('hidden');
  showFieldError(emailInput, 'email-error', '');
  showFieldError(passwordInput, 'password-error', '');
}

$('#toggle-password').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const showing = passwordInput.type === 'text';
  passwordInput.type = showing ? 'password' : 'text';
  btn.setAttribute('aria-pressed', String(!showing));
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});

for (const btn of document.querySelectorAll('[data-demo]')) {
  btn.addEventListener('click', () => {
    emailInput.value = btn.dataset.demo;
    passwordInput.value = 'Password123!';
    clearErrors();
    passwordInput.focus();
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  let invalid = false;
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    showFieldError(emailInput, 'email-error', 'Enter a valid email address.');
    invalid = true;
  }
  if (!password) {
    showFieldError(passwordInput, 'password-error', 'Enter your password.');
    invalid = true;
  }
  if (invalid) return;

  const restore = withBusy($('#submit'), 'Logging in…');
  try {
    const data = await api.login(email, password);
    setCsrfToken(data.csrfToken);
    const next = new URLSearchParams(location.search).get('next');
    location.replace(next && next.startsWith('/') ? next : '/app');
  } catch (err) {
    restore();
    if (err instanceof ApiError && err.details) {
      for (const [field, message] of Object.entries(err.details)) {
        if (field === 'email') showFieldError(emailInput, 'email-error', message);
        if (field === 'password') showFieldError(passwordInput, 'password-error', message);
      }
    }
    formError.textContent = err.message || 'Could not log you in.';
    formError.classList.remove('hidden');
    if (err.status === 429) toast('Too many attempts. Wait a moment.', { type: 'error' });
  }
});
