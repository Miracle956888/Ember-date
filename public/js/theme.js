/**
 * Light / dark theme.
 *
 * Persistence uses a cookie rather than localStorage for two reasons:
 *  - `no-restricted-globals` bans localStorage/sessionStorage in public/js;
 *  - a cookie is readable by the server, so it can render <html class="dark">
 *    on the very first byte and avoid a white flash on dark-mode reloads.
 *
 * Three states: 'light', 'dark', 'system' (default, follows the OS).
 */

const COOKIE = 'ec_theme';
const MODES = ['light', 'dark', 'system'];
const ONE_YEAR = 60 * 60 * 24 * 365;

const mql = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

function readCookie() {
  const hit = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${COOKIE}=`));
  const value = hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : '';
  return MODES.includes(value) ? value : 'system';
}

function writeCookie(mode) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${encodeURIComponent(mode)}; path=/; max-age=${ONE_YEAR}; SameSite=Lax${secure}`;
}

/** The theme actually painted, once 'system' has been resolved. */
export function resolvedTheme(mode = getTheme()) {
  if (mode === 'dark' || mode === 'light') return mode;
  return mql.matches ? 'dark' : 'light';
}

export function getTheme() {
  return readCookie();
}

function paint(mode) {
  const dark = resolvedTheme(mode) === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  // Keep the browser UI (form controls, scrollbars, address bar) in step.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#1a171e' : '#ffffff');
  for (const fn of listeners) fn(dark ? 'dark' : 'light', mode);
}

export function setTheme(mode) {
  const next = MODES.includes(mode) ? mode : 'system';
  writeCookie(next);
  paint(next);
  return next;
}

/** Cycle for the header button: light -> dark -> light (system stays opt-in). */
export function toggleTheme() {
  return setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const SUN = '<path d="M12 17a5 5 0 100-10 5 5 0 000 10zm0 2.5a1 1 0 011 1V22a1 1 0 11-2 0v-1.5a1 1 0 011-1zm0-19a1 1 0 011 1V3a1 1 0 11-2 0V1.5a1 1 0 011-1zM20.5 12a1 1 0 011-1H23a1 1 0 110 2h-1.5a1 1 0 01-1-1zm-19 0a1 1 0 011-1H4a1 1 0 110 2H2.5a1 1 0 01-1-1zm15.9 6.4a1 1 0 011.4 0l1.1 1.1a1 1 0 01-1.4 1.4l-1.1-1.1a1 1 0 010-1.4zM4.1 4.1a1 1 0 011.4 0l1.1 1.1a1 1 0 11-1.4 1.4L4.1 5.5a1 1 0 010-1.4zm14.7 2.5a1 1 0 010-1.4l1.1-1.1a1 1 0 111.4 1.4l-1.1 1.1a1 1 0 01-1.4 0zM4.1 19.9a1 1 0 010-1.4l1.1-1.1a1 1 0 011.4 1.4l-1.1 1.1a1 1 0 01-1.4 0z"/>';
const MOON = '<path d="M21.3 14.6A9 9 0 019.4 2.7a1 1 0 00-1.3-1.2A11 11 0 1022.5 15.9a1 1 0 00-1.2-1.3z"/>';

/**
 * Mounts every `[data-action="theme"]` button on the page and keeps the icon,
 * label and aria-pressed state in sync with the current theme.
 */
export function initThemeToggle(root = document) {
  const buttons = [...root.querySelectorAll('[data-action="theme"]')];
  if (!buttons.length) return;

  const sync = () => {
    const dark = resolvedTheme() === 'dark';
    for (const btn of buttons) {
      const icon = btn.querySelector('[data-theme-icon]');
      const label = btn.querySelector('[data-theme-label]');
      if (icon) icon.innerHTML = dark ? SUN : MOON;
      if (label) label.textContent = dark ? 'Light mode' : 'Dark mode';
      const text = dark ? 'Switch to light mode' : 'Switch to dark mode';
      btn.setAttribute('aria-label', text);
      btn.setAttribute('title', text);
      btn.setAttribute('aria-pressed', String(dark));
    }
  };

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      toggleTheme();
      sync();
    });
  }
  onThemeChange(sync);
  sync();
}

/**
 * Mounts the three-way Light / Dark / System radio group used on Settings.
 */
export function initThemeChoice(root = document) {
  const options = [...root.querySelectorAll('[data-theme-choice]')];
  if (!options.length) return;

  const sync = () => {
    const mode = getTheme();
    for (const btn of options) {
      const on = btn.dataset.themeChoice === mode;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', String(on));
    }
  };

  for (const btn of options) {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.themeChoice);
      sync();
    });
  }
  onThemeChange(sync);
  sync();
}

/**
 * Applies the stored theme as early as the module runs. The server also stamps
 * <html class="dark"> from the same cookie, so this is really just a
 * belt-and-braces pass for pages served from cache.
 */
export function initTheme() {
  paint(readCookie());
  // Follow the OS only while the user is on 'system'.
  const onSystemChange = () => {
    if (readCookie() === 'system') paint('system');
  };
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSystemChange);
  else if (typeof mql.addListener === 'function') mql.addListener(onSystemChange);

  // Enable colour transitions only after first paint so the initial render
  // doesn't visibly fade in.
  requestAnimationFrame(() => document.documentElement.classList.add('theme-ready'));
}

initTheme();
