const HANDLE_RE = /^[a-z0-9](?:[a-z0-9._]*[a-z0-9])?$/;
const VISIT_SOURCES = new Set(['deck', 'search', 'nearby', 'bumped', 'likes', 'visitors', 'favorites']);
const INTERNAL_ORIGIN = 'https://ember-date.invalid';

/** Build the canonical shareable profile route; never fall back to /profile?id=, which edits the viewer's own profile. */
export function publicProfilePath(username, source = 'direct') {
  const handle = String(username || '').trim().toLowerCase();
  if (handle.length < 3 || handle.length > 30 || !HANDLE_RE.test(handle) || /[._]{2,}/.test(handle)) {
    throw new TypeError('Cannot build a profile link for an invalid username.');
  }
  const query = VISIT_SOURCES.has(source) ? `?from=${encodeURIComponent(source)}` : '';
  return `/@${encodeURIComponent(handle)}${query}`;
}

/**
 * Keep login return destinations on this origin. A single leading slash is
 * required; protocol-relative URLs, backslashes and control characters are
 * rejected before the browser can interpret them as an external destination.
 */
export function safeReturnPath(value, fallback = '/app') {
  const hasControlCharacter = typeof value === 'string' && [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') ||
      value.includes('\\') || hasControlCharacter) {
    return fallback;
  }

  try {
    const parsed = new URL(value, INTERNAL_ORIGIN);
    if (parsed.origin !== INTERNAL_ORIGIN) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
