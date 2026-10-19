import { api, ApiError } from '/js/api.js';
import { $, withBusy } from '/js/ui.js';
import { initThemeToggle } from '/js/theme.js';

initThemeToggle();
const form = $('#forgot-form');
const email = $('#email');
const error = $('#form-error');
const success = $('#form-success');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.classList.add('hidden');
  success.classList.add('hidden');

  const address = email.value.trim();
  if (!/^\S+@\S+\.\S+$/.test(address)) {
    error.textContent = 'Enter a valid email address.';
    error.classList.remove('hidden');
    return;
  }

  const restore = withBusy($('#submit'), 'Sending…');
  try {
    const result = await api.forgotPassword(address);
    success.textContent = result.message || 'If that email is registered, a reset link is on its way.';
    success.classList.remove('hidden');
  } catch (err) {
    error.textContent = err instanceof ApiError ? err.message : 'Could not request a reset link. Try again shortly.';
    error.classList.remove('hidden');
  } finally {
    restore();
  }
});
