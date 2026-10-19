/**
 * Canonical page shells served by the Express app and checked by the route sweep.
 * Keep this list aligned with public/*.html; `404.html` is the fallback, not a
 * routable page shell.
 */
export const PAGE_NAMES = Object.freeze([
  'index', 'login', 'register', 'forgot-password', 'reset-password', 'app', 'matches', 'chats', 'chat', 'call',
  'profile', 'nearby', 'likes', 'settings', 'u', 'moments', 'admin'
]);

/** Broad route-shape check; the API applies the stricter canonical username rules. */
const PUBLIC_HANDLE_ROUTE = /^[A-Za-z0-9._]{3,30}$/;

export function isPublicHandleRouteCandidate(value) {
  return PUBLIC_HANDLE_ROUTE.test(String(value || ''));
}
