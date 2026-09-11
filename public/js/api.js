/**
 * Thin fetch wrapper.
 *
 * Auth is entirely cookie-based (httpOnly access + refresh). Nothing sensitive
 * is ever written to localStorage - the only thing we keep in memory is the
 * CSRF token, which the server also sets as a readable cookie.
 */

let csrfToken = null;
let refreshInFlight = null;

export class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}

export function setCsrfToken(token) {
  if (token) csrfToken = token;
}

export function getCsrfToken() {
  if (csrfToken) return csrfToken;
  const match = document.cookie.match(/(?:^|;\s*)ec_csrf=([^;]+)/);
  if (match) csrfToken = decodeURIComponent(match[1]);
  return csrfToken;
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

async function rawRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  let { body } = options;

  if (body !== undefined && !(body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  if (MUTATING.has(method)) {
    const token = getCsrfToken();
    if (token) headers.set('X-CSRF-Token', token);
  }

  const res = await fetch(path.startsWith('/') ? path : `/api/${path}`, {
    ...options,
    method,
    headers,
    body,
    credentials: 'same-origin'
  });

  return res;
}

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (res.ok) return null;
    throw new ApiError(res.statusText || 'Request failed.', res.status);
  }
  const data = await res.json();
  if (!res.ok) {
    const err = data?.error || {};
    throw new ApiError(err.message || 'Request failed.', res.status, err.code, err.details);
  }
  return data;
}

/**
 * Perform a request, transparently refreshing the access token once on 401.
 * Concurrent 401s share a single refresh call.
 */
export async function request(path, options = {}) {
  let res = await rawRequest(path, options);

  if (res.status === 401 && !options._retried && !path.includes('/auth/refresh')) {
    try {
      if (!refreshInFlight) {
        refreshInFlight = rawRequest('/api/auth/refresh', { method: 'POST' })
          .then(parse)
          .finally(() => {
            refreshInFlight = null;
          });
      }
      const refreshed = await refreshInFlight;
      if (refreshed?.csrfToken) setCsrfToken(refreshed.csrfToken);
      res = await rawRequest(path, { ...options, _retried: true });
    } catch {
      // Refresh failed - the session is genuinely over.
      throw new ApiError('Your session has expired. Please sign in again.', 401, 'SESSION_EXPIRED');
    }
  }

  return parse(res);
}

export const api = {
  get: (p, o) => request(p, { ...o, method: 'GET' }),
  post: (p, body, o) => request(p, { ...o, method: 'POST', body }),
  patch: (p, body, o) => request(p, { ...o, method: 'PATCH', body }),
  del: (p, body, o) => request(p, { ...o, method: 'DELETE', body }),

  // --- auth
  register: (payload) => request('/api/auth/register', { method: 'POST', body: payload }),
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),

  // --- profile & discovery
  deck: (limit = 12) => request(`/api/users/deck?limit=${limit}`),
  profile: () => request('/api/users/me/profile'),
  updateProfile: (payload) => request('/api/users/me', { method: 'PATCH', body: payload }),
  user: (id) => request(`/api/users/${id}`),
  searchUsers: (q, limit = 10) =>
    request(`/api/users/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  usernameAvailable: (username) =>
    request(`/api/auth/username-available?username=${encodeURIComponent(username)}`),
  deleteAccount: () => request('/api/users/me', { method: 'DELETE' }),

  // --- V1 identity
  completion: () => request('/api/users/me/completion'),
  userByUsername: (username) => request(`/api/users/by-username/${encodeURIComponent(username)}`),
  usernameClaimable: (username) =>
    request(`/api/users/me/username-available?username=${encodeURIComponent(username)}`),
  changeUsername: (username) => request('/api/users/me/username', { method: 'PATCH', body: { username } }),
  startVerify: (kind, phone) =>
    request('/api/users/me/verify/start', { method: 'POST', body: phone ? { kind, phone } : { kind } }),
  confirmVerify: (kind, code) =>
    request('/api/users/me/verify/confirm', { method: 'POST', body: { kind, code } }),

  uploadPhoto: (file) => {
    const fd = new FormData();
    fd.append('photo', file);
    return request('/api/users/me/photos', { method: 'POST', body: fd });
  },
  reorderPhotos: (ids) => request('/api/users/me/photos/order', { method: 'PATCH', body: { order: ids } }),
  deletePhoto: (id) => request(`/api/users/me/photos/${id}`, { method: 'DELETE' }),

  // --- swipes & matches
  swipe: (swipeeId, direction) => request('/api/swipes', { method: 'POST', body: { swipeeId, direction } }),
  rewind: () => request('/api/swipes/rewind', { method: 'POST' }),
  likesReceived: () => request('/api/swipes/likes-received'),
  matches: () => request('/api/matches'),
  unmatch: (matchId) => request(`/api/matches/${matchId}`, { method: 'DELETE' }),

  // --- conversations
  conversation: (id) => request(`/api/conversations/${id}`),
  messages: (id, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/conversations/${id}/messages${qs ? `?${qs}` : ''}`);
  },
  sendMessage: (id, payload) => request(`/api/conversations/${id}/messages`, { method: 'POST', body: payload }),
  clearConversation: (id) => request(`/api/conversations/${id}/messages`, { method: 'DELETE' }),
  markRead: (id) => request(`/api/conversations/${id}/read`, { method: 'POST' }),

  // --- end-to-end encryption
  registerDevice: (payload) => request('/api/devices', { method: 'POST', body: payload }),
  myDevices: () => request('/api/devices'),
  revokeDevice: (deviceId) => request(`/api/devices/${deviceId}`, { method: 'DELETE' }),
  conversationDevices: (id) => request(`/api/conversations/${id}/devices`),
  publishKeys: (id, payload) => request(`/api/conversations/${id}/keys`, { method: 'POST', body: payload }),
  myKeys: (id, deviceId) =>
    request(`/api/conversations/${id}/keys?deviceId=${encodeURIComponent(deviceId)}`),
  keyCoverage: (id) => request(`/api/conversations/${id}/keys/coverage`),

  // --- disappearing-message timer
  getTimer: (id) => request(`/api/conversations/${id}/timer`),
  setTimer: (id, ttlHours) => request(`/api/conversations/${id}/timer`, { method: 'PUT', body: { ttlHours } }),

  // --- media
  upload: (file, onProgress) => uploadWithProgress('/api/uploads', file, onProgress),
  uploadSocial: (file, onProgress) => uploadWithProgress('/api/uploads/social', file, onProgress),

  // --- safety
  block: (blockedId) => request('/api/users/blocks', { method: 'POST', body: { blockedId } }),
  blockedList: () => request('/api/users/blocks'),
  unblock: (blockedId) => request(`/api/users/blocks/${blockedId}`, { method: 'DELETE' }),
  report: (reportedId, reason, details = '') =>
    request('/api/users/reports', {
      method: 'POST',
      // The API stores a single reason string; fold optional details into it.
      body: { reportedId, reason: details ? `${reason} — ${details}`.slice(0, 255) : reason }
    }),

  // --- calls
  iceServers: () => request('/api/ice-servers'),

  // --- location & nearby
  postLocation: (payload) => request('/api/discovery/location', { method: 'POST', body: payload }),
  getLocation: () => request('/api/discovery/location'),
  clearLocation: () => request('/api/discovery/location', { method: 'DELETE' }),
  nearby: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/discovery/nearby${qs ? `?${qs}` : ''}`);
  },
  bumpedInto: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/discovery/bumped${qs ? `?${qs}` : ''}`);
  },

  // --- notifications
  // NB: never name these after a bare HTTP verb -- `post`/`get` are the
  // generic request helpers and shadowing them breaks every other call.
  notifications: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/api/notifications${qs ? `?${qs}` : ''}`);
  },
  unreadNotifications: () => request('/api/notifications/unread'),
  markNotificationsRead: (ids = null) =>
    request('/api/notifications/read', { method: 'POST', body: ids ? { ids } : {} }),
  notificationPrefs: () => request('/api/notifications/prefs'),
  updateNotificationPrefs: (prefs) => request('/api/notifications/prefs', { method: 'PUT', body: prefs }),

  // --- moderation (moderator/admin only; 404 for everyone else)
  adminWhoami: () => request('/api/admin/whoami'),
  adminOverview: () => request('/api/admin/overview'),
  adminReports: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')
    ).toString();
    return request(`/api/admin/reports${qs ? `?${qs}` : ''}`);
  },
  adminReport: (id) => request(`/api/admin/reports/${id}`),
  adminResolveReport: (id, body) => request(`/api/admin/reports/${id}/resolve`, { method: 'POST', body }),
  adminUsers: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')
    ).toString();
    return request(`/api/admin/users${qs ? `?${qs}` : ''}`);
  },
  adminUser: (id) => request(`/api/admin/users/${id}`),
  adminSuspend: (id, body) => request(`/api/admin/users/${id}/suspend`, { method: 'POST', body }),
  adminBan: (id, body) => request(`/api/admin/users/${id}/ban`, { method: 'POST', body }),
  adminRestore: (id, body) => request(`/api/admin/users/${id}/restore`, { method: 'POST', body }),
  adminSetRole: (id, role) => request(`/api/admin/users/${id}/role`, { method: 'POST', body: { role } }),
  adminRemoveContent: (body) => request('/api/admin/content/remove', { method: 'POST', body }),
  adminAudit: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')
    ).toString();
    return request(`/api/admin/audit${qs ? `?${qs}` : ''}`);
  },

  // --- attention lists
  likesYou: () => request('/api/discovery/likes-you'),
  visitors: () => request('/api/discovery/visitors'),
  topPicks: () => request('/api/discovery/top-picks'),
  counters: () => request('/api/discovery/counters'),

  favorites: () => request('/api/discovery/favorites'),
  addFavorite: (targetId) => request('/api/discovery/favorites', { method: 'POST', body: { targetId } }),
  removeFavorite: (targetId) => request(`/api/discovery/favorites/${targetId}`, { method: 'DELETE' }),

  taps: () => request('/api/discovery/taps'),
  sendTap: (targetId, kind = 'wave') =>
    request('/api/discovery/taps', { method: 'POST', body: { targetId, kind } }),
  markTapsSeen: () => request('/api/discovery/taps/seen', { method: 'POST' }),

  // --- boost
  boostStatus: () => request('/api/discovery/boost'),
  startBoost: () => request('/api/discovery/boost', { method: 'POST' }),

  // --- settings, filters, passport
  settings: () => request('/api/discovery/settings'),
  updateSettings: (payload) => request('/api/discovery/settings', { method: 'PATCH', body: payload }),
  setPassport: (payload) => request('/api/discovery/passport', { method: 'POST', body: payload }),
  clearPassport: () => request('/api/discovery/passport', { method: 'DELETE' }),

  // --- interests & prompts
  interestCatalogue: () => request('/api/discovery/interests'),
  myInterests: () => request('/api/discovery/me/interests'),
  setInterests: (slugs) => request('/api/discovery/me/interests', { method: 'PUT', body: { slugs } }),
  promptCatalogue: () => request('/api/discovery/prompts'),
  myPrompts: () => request('/api/discovery/me/prompts'),
  setPrompts: (prompts) => request('/api/discovery/me/prompts', { method: 'PUT', body: { prompts } }),

  // --- verification
  verificationStatus: () => request('/api/discovery/verification'),
  verificationChallenge: () => request('/api/discovery/verification/challenge'),
  submitVerification: (gesture, blob) => {
    const fd = new FormData();
    fd.append('gesture', gesture);
    fd.append('photo', blob, 'selfie.jpg');
    return request('/api/discovery/verification', { method: 'POST', body: fd });
  },

  // --- location sharing in chat
  shareLocation: (conversationId, payload) =>
    request(`/api/conversations/${conversationId}/location`, { method: 'POST', body: payload }),
  updateLiveLocation: (conversationId, messageId, payload) =>
    request(`/api/conversations/${conversationId}/location/${messageId}`, { method: 'PATCH', body: payload }),
  stopLiveLocation: (conversationId, messageId) =>
    request(`/api/conversations/${conversationId}/location/${messageId}`, { method: 'DELETE' }),
  checkMessage: (conversationId, body) =>
    request(`/api/conversations/${conversationId}/check`, { method: 'POST', body: { body } }),

  /* ---------------- Moments (24h stories) ---------------- */
  momentsFeed: () => request('/api/moments'),
  moment: (id) => request(`/api/moments/${id}`),
  momentsByUser: (userId) => request(`/api/moments/user/${userId}`),
  createMoment: (payload) => request('/api/moments', { method: 'POST', body: payload }),
  viewMoment: (id) => request(`/api/moments/${id}/view`, { method: 'POST' }),
  momentViewers: (id) => request(`/api/moments/${id}/viewers`),
  reactToMoment: (id, emoji) => request(`/api/moments/${id}/react`, { method: 'POST', body: { emoji } }),
  unreactToMoment: (id) => request(`/api/moments/${id}/react`, { method: 'DELETE' }),
  replyToMoment: (id, body) => request(`/api/moments/${id}/reply`, { method: 'POST', body: { body } }),
  deleteMoment: (id) => request(`/api/moments/${id}`, { method: 'DELETE' }),

  /* ---------------- Posts (24h feed) ---------------- */
  postsFeed: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')
    ).toString();
    return request(`/api/posts${qs ? `?${qs}` : ''}`);
  },
  // Named `getPost`, not `post`: `api.post` is the generic HTTP POST helper.
  getPost: (id) => request(`/api/posts/${id}`),
  createPost: (payload) => request('/api/posts', { method: 'POST', body: payload }),
  deletePost: (id) => request(`/api/posts/${id}`, { method: 'DELETE' }),
  likePost: (id) => request(`/api/posts/${id}/like`, { method: 'POST' }),
  votePoll: (id, optionId) => request(`/api/posts/${id}/vote`, { method: 'POST', body: { optionId } }),

  /* ---------------- Comments ---------------- */
  comments: (postId) => request(`/api/posts/${postId}/comments`),
  commentContext: (commentId) => request(`/api/comments/${commentId}/context`),
  addComment: (postId, body, parentId = null) =>
    request(`/api/posts/${postId}/comments`, { method: 'POST', body: { body, parentId } }),
  likeComment: (id) => request(`/api/comments/${id}/like`, { method: 'POST' }),
  deleteComment: (id) => request(`/api/comments/${id}`, { method: 'DELETE' }),

  /* ---------------- Reporting (every surface) ---------------- */
  reportContent: (targetType, targetId, reason, details = '') =>
    request('/api/reports', { method: 'POST', body: { targetType, targetId, reason, details } }),
  reportStatus: (targetType, targetId) => request(`/api/reports/${targetType}/${targetId}`)
};

/**
 * XHR upload so we can show a real progress bar (fetch cannot report upload
 * progress in browsers today).
 */
export function uploadWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    const token = getCsrfToken();
    if (token) xhr.setRequestHeader('X-CSRF-Token', token);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        const err = data?.error || {};
        reject(new ApiError(err.message || 'Upload failed.', xhr.status, err.code));
      }
    });

    xhr.addEventListener('error', () => reject(new ApiError('Network error during upload.', 0)));
    xhr.addEventListener('abort', () => reject(new ApiError('Upload cancelled.', 0, 'ABORTED')));

    xhr.send(fd);
    if (onProgress) onProgress(0);
  });
}

/** Redirect to login, preserving where the user wanted to go. */
export function requireSession(err) {
  if (err instanceof ApiError && (err.status === 401 || err.code === 'SESSION_EXPIRED')) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`/login?next=${next}`);
    return true;
  }
  return false;
}
