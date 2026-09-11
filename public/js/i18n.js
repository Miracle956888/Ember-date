/**
 * i18n — string catalogue, locale negotiation and locale-aware formatters.
 *
 * Scope note (read before adding strings): this module makes the app
 * TRANSLATABLE. It does not ship a second translation — `en` is the only
 * complete catalogue today. The point is that no new locale requires touching
 * rendering logic: add a catalogue object, and `t()` resolves it.
 *
 * Design rules:
 *  - No region is hard-coded. The active locale comes from the user's saved
 *    preference, else the browser (`navigator.languages`), else 'en'.
 *  - Timestamps are ALWAYS transported as UTC ISO strings and formatted here
 *    through `Intl`, so a user in Lagos and one in São Paulo read the same
 *    instant in their own zone and language.
 *  - Missing keys fall back to the `en` string, then to the key itself, and
 *    warn in dev rather than rendering blank UI.
 */

// ------------------------------------------------------------------ catalogue
// Keys are dotted and grouped by surface. Placeholders use {name}.
const CATALOGUE = {
  en: {
    // time
    'time.now': 'now',
    'time.minutes': '{n}m',
    'time.hours': '{n}h',
    'time.days': '{n}d',
    'time.today': 'Today',
    'time.yesterday': 'Yesterday',
    'time.expiresIn': 'Expires in {duration}',
    'time.expired': 'Expired',

    // generic actions
    'action.save': 'Save',
    'action.cancel': 'Cancel',
    'action.delete': 'Delete',
    'action.remove': 'Remove',
    'action.report': 'Report',
    'action.block': 'Block',
    'action.unblock': 'Unblock',
    'action.retry': 'Try again',
    'action.close': 'Close',

    // empty states
    'empty.matches.title': 'No matches yet',
    'empty.matches.body': 'Keep swiping — your next match is out there.',
    'empty.chats.title': 'No conversations yet',
    'empty.chats.body': 'Match with someone to start chatting.',
    'empty.moments.title': 'No moments yet',
    'empty.moments.body': 'Moments disappear after 24 hours. Post the first one.',
    'empty.search.title': 'No user found',
    'empty.search.body': 'Check the spelling and try again.',

    // chat
    'chat.placeholder': 'Message',
    'chat.send': 'Send',
    'chat.encrypted': 'End-to-end encrypted',
    'chat.ttlChanged': 'Disappearing messages set to {duration}',

    // errors
    'error.generic': 'Something went wrong. Please try again.',
    'error.offline': 'You appear to be offline.',
    'error.rateLimited': 'Too many attempts. Please wait a moment.'
  }
};

const DEFAULT_LOCALE = 'en';

/**
 * Pick the best supported locale. Matches on the full tag first ('pt-BR'),
 * then the base language ('pt'), so a new regional variant degrades gracefully
 * instead of falling all the way back to English.
 */
export function negotiateLocale(preferred, available = Object.keys(CATALOGUE)) {
  const wanted = [preferred, ...(navigator.languages || [navigator.language])].filter(Boolean);
  for (const tag of wanted) {
    if (available.includes(tag)) return tag;
    const base = String(tag).split('-')[0];
    const hit = available.find((a) => a === base || a.split('-')[0] === base);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

let activeLocale = DEFAULT_LOCALE;

/** Set the active locale (call once on boot with the user's saved preference). */
export function setLocale(tag) {
  activeLocale = negotiateLocale(tag);
  // Deliberately NOT persisted client-side: the project bans localStorage, and
  // the preference already has a durable home in `users.locale`, so it follows
  // the account across devices instead of being stranded in one browser.
  document.documentElement.lang = activeLocale;
  return activeLocale;
}

export function getLocale() {
  return activeLocale;
}

/** The locale tag list handed to Intl — always ends in a usable fallback. */
function intlLocales() {
  return [activeLocale, DEFAULT_LOCALE];
}

/**
 * Translate `key`, interpolating {placeholders}.
 * Falls back: active locale -> en -> the key itself.
 */
export function t(key, vars) {
  const table = CATALOGUE[activeLocale] || CATALOGUE[DEFAULT_LOCALE];
  let str = table[key] ?? CATALOGUE[DEFAULT_LOCALE][key];
  if (str === undefined) {
    if (typeof console !== 'undefined') console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (vars) {
    str = str.replace(/\{(\w+)\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
    );
  }
  return str;
}

// ----------------------------------------------------------------- timezone
/**
 * The user's IANA zone. We never guess from an IP or assume a region: the
 * browser knows, and a saved profile preference (for users who travel or fix
 * their zone deliberately) wins over it.
 */
let preferredTimeZone = null;

export function setTimeZone(tz) {
  if (!tz) {
    preferredTimeZone = null;
    return getTimeZone();
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    preferredTimeZone = tz;
  } catch {
    preferredTimeZone = null; // invalid zone: fall back to the browser's
  }
  return getTimeZone();
}

export function getTimeZone() {
  if (preferredTimeZone) return preferredTimeZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function dtf(options) {
  return new Intl.DateTimeFormat(intlLocales(), { timeZone: getTimeZone(), ...options });
}

// ---------------------------------------------------------------- formatters
/** Short date, e.g. "17 Aug" / "Aug 17" depending on locale. */
export function formatDate(iso, options = { month: 'short', day: 'numeric' }) {
  return dtf(options).format(new Date(iso));
}

/** Clock time in the user's zone, 12h/24h chosen by their locale. */
export function formatTime(iso) {
  return dtf({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** Day separator used in the chat transcript. */
export function formatDayLabel(iso) {
  const zone = getTimeZone();
  // Compare calendar days IN THE USER'S ZONE, not the runtime's: near midnight
  // a UTC-based comparison labels today's message "Yesterday" for anyone east
  // of UTC (and tomorrow's for anyone west of it).
  const key = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(d);
  const date = new Date(iso);
  const now = new Date();
  if (key(date) === key(now)) return t('time.today');
  if (key(date) === key(new Date(now.getTime() - 86_400_000))) return t('time.yesterday');
  return dtf({ weekday: 'long', month: 'short', day: 'numeric' }).format(date);
}

/** Locale-aware number, e.g. view counts. */
export function formatNumber(n) {
  return new Intl.NumberFormat(intlLocales()).format(Number(n) || 0);
}

/** Boot helper: restore any persisted locale before first paint. */
export function initI18n(user) {
  // Saved account preference wins; otherwise negotiate from the browser.
  setLocale(user?.locale || null);
  setTimeZone(user?.timezone || null);
  return { locale: getLocale(), timeZone: getTimeZone() };
}

export const __catalogue = CATALOGUE; // exposed for the i18n test suite
