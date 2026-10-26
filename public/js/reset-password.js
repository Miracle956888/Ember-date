import { api, ApiError } from '/js/api.js';
import { $, withBusy } from '/js/ui.js';
import { initThemeToggle } from '/js/theme.js';

initThemeToggle();
const form = $('#reset-form');
const password = $('#password');
const confirmPassword = $('#confirm-password');
const error = $('#form-error');
const success = $('#form-success');

const params = new URLSearchParams(location.hash.replace(/^#/, ''));
const token = params.get('token') || '';
// Remove the bearer token from browser history before any form interaction.
history.replaceState(null, '', location.pathname);
if (!/^[a-f0-9]{64}$/i.test(token)) {
  form.hidden = true;
  error.textContent = 'This reset link is invalid or has expired. Request a new one.';
  error.classList.remove('hidden');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.classList.add('hidden');
  success.classList.add('hidden');

  if (password.value.length < 8 || !/[A-Za-z]/.test(password.value) || !/\d/.test(password.value)) {
    error.textContent = 'Use at least 8 characters, including a letter and a number.';
    error.classList.remove('hidden');
    return;
  }
  if (password.value !== confirmPassword.value) {
    error.textContent = 'Those passwords do not match.';
    error.classList.remove('hidden');
    confirmPassword.focus();
    return;
  }

  const restore = withBusy($('#submit'), 'Updating…');
  try {
    const result = await api.resetPassword(token, password.value);
    form.hidden = true;
    success.textContent = result.message || 'Your password has been changed. Sign in with the new password.';
    success.classList.remove('hidden');
  } catch (err) {
    error.textContent = err instanceof ApiError ? err.message : 'Could not update the password. Request a new reset link.';
    error.classList.remove('hidden');
  } finally {
    restore();
    password.value = '';
    confirmPassword.value = '';
  }
});
