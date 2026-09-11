/** landing.js — page script for index.html (external so the strict CSP allows it). */
import { initThemeToggle } from '/js/theme.js';

initThemeToggle();
document.getElementById('year').textContent = String(new Date().getFullYear());
// Bounce straight into the app if there is already a session.
fetch('/api/auth/me', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { if (d?.user) location.replace('/app'); })
  .catch(() => {});
