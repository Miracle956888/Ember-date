/**
 * Browser geolocation, wrapped so the rest of the app never touches the raw
 * API. Responsibilities:
 *
 *  - ask for permission at a moment the user understands (never on page load)
 *  - throttle writes: a moving phone fires constantly, the server needs ~1/min
 *  - degrade gracefully: no HTTPS, denied permission and unsupported browsers
 *    all produce a clear message rather than a silent dead end
 *
 * Nothing here caches coordinates in storage — `localStorage` is banned in this
 * codebase, and a stale position is worse than no position.
 */
import { api } from './api.js';
import { toast } from './ui.js';

/** Minimum gap between server writes while watching. */
const MIN_WRITE_MS = 45_000;

/** Ignore jitter: only write if the phone actually moved this far. */
const MIN_MOVE_M = 60;

let watchId = null;
let lastWrite = 0;
let lastPoint = null;

export function isSupported() {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

/**
 * Geolocation requires a secure context. localhost counts as secure, which is
 * why local development works without TLS.
 */
export function isSecure() {
  return typeof window !== 'undefined' && (window.isSecureContext || location.hostname === 'localhost');
}

/** Permission state without triggering a prompt, when the browser supports it. */
export async function permissionState() {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state; // 'granted' | 'prompt' | 'denied'
  } catch {
    return 'unknown';
  }
}

function describeError(err) {
  switch (err?.code) {
    case 1:
      return 'Location permission was denied. You can turn it back on in your browser settings.';
    case 2:
      return 'Your location is unavailable right now. Try again in a moment.';
    case 3:
      return 'Finding your location took too long. Try again.';
    default:
      return 'We could not get your location.';
  }
}

/** One-shot read. Rejects with a human-readable Error. */
export function getPosition({ timeout = 12_000, highAccuracy = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!isSupported()) return reject(new Error('This browser cannot share your location.'));
    if (!isSecure()) return reject(new Error('Location sharing needs a secure (https) connection.'));

    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null
        }),
      (err) => reject(new Error(describeError(err))),
      { enableHighAccuracy: highAccuracy, timeout, maximumAge: 30_000 }
    );
  });
}

/** Metres between two points. Used to suppress pointless writes. */
function movedMetres(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (b.lat - a.lat) * p;
  const dLng = (b.lng - a.lng) * p;
  const x =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

/**
 * Read the position once and push it to the server.
 * @returns the server's response, which reports what was actually stored.
 */
export async function updateOnce({ city = null, silent = false } = {}) {
  const point = await getPosition();
  const result = await api.postLocation({ ...point, city });
  lastPoint = point;
  lastWrite = Date.now();
  if (!silent && result.stored) {
    toast(
      result.approximate
        ? 'Location updated (approximate).'
        : 'Location updated.'
    );
  }
  return result;
}

/**
 * Keep the position fresh while the user is on a location-driven screen.
 * Returns a stop function; always call it on teardown.
 */
export function startWatching({ onUpdate, onError } = {}) {
  if (!isSupported() || !isSecure()) return () => {};
  if (watchId !== null) stopWatching();

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const point = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null
      };

      const tooSoon = Date.now() - lastWrite < MIN_WRITE_MS;
      const tooClose = movedMetres(lastPoint, point) < MIN_MOVE_M;
      if (tooSoon && tooClose) return;

      try {
        const result = await api.postLocation(point);
        lastPoint = point;
        lastWrite = Date.now();
        onUpdate?.(result, point);
      } catch (err) {
        onError?.(err);
      }
    },
    (err) => onError?.(new Error(describeError(err))),
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 }
  );

  return stopWatching;
}

export function stopWatching() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

/**
 * A live location share inside a chat: pushes the sender's position to the
 * conversation until the timer runs out or the user stops it.
 */
export function startLiveShare({ conversationId, messageId, minutes, onTick, onEnd }) {
  const endsAt = Date.now() + minutes * 60_000;
  let id = null;

  const stop = async ({ notifyServer = true } = {}) => {
    if (id !== null) navigator.geolocation.clearWatch(id);
    id = null;
    clearInterval(ticker);
    if (notifyServer) {
      try {
        await api.stopLiveLocation(conversationId, messageId);
      } catch {
        /* the share expires server-side anyway */
      }
    }
    onEnd?.();
  };

  const ticker = setInterval(() => {
    const msLeft = endsAt - Date.now();
    if (msLeft <= 0) return void stop({ notifyServer: true });
    onTick?.(Math.ceil(msLeft / 1000));
  }, 1000);

  id = navigator.geolocation.watchPosition(
    async (pos) => {
      try {
        await api.updateLiveLocation(conversationId, messageId, {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null
        });
      } catch {
        // Expired or stopped elsewhere - shut the watcher down quietly.
        stop({ notifyServer: false });
      }
    },
    () => {},
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 15_000 }
  );

  return stop;
}

/**
 * A static map preview without any third-party tiles: CSP forbids remote
 * images, and a map provider would leak our users' coordinates to them.
 * This draws a simple coordinate card instead, and links out to a map only
 * when the user explicitly chooses to open one.
 */
export function mapPreviewSvg(lat, lng, { live = false } = {}) {
  const accent = live ? '#21D07A' : '#7B35A8';
  // Deterministic pseudo-streets so each location looks distinct.
  const seed = Math.abs(Math.round((lat * 1000 + lng * 1000) % 40));
  const lines = [];
  for (let i = 0; i < 6; i += 1) {
    const y = 14 + ((seed + i * 13) % 60);
    const x = 8 + ((seed + i * 21) % 70);
    lines.push(`<path d="M0 ${y}h120" stroke="#E6E8EA" stroke-width="3"/>`);
    lines.push(`<path d="M${x} 0v80" stroke="#EFF1F2" stroke-width="3"/>`);
  }
  return `<svg viewBox="0 0 120 80" class="absolute inset-0 h-full w-full" role="img" aria-label="Map preview" preserveAspectRatio="xMidYMid slice">
    <rect width="120" height="80" fill="#F7F7F7"/>
    ${lines.join('')}
    <circle cx="60" cy="40" r="13" fill="${accent}" opacity="0.18"/>
    <circle cx="60" cy="40" r="5" fill="${accent}"/>
    ${live ? '<circle cx="60" cy="40" r="9" fill="none" stroke="' + accent + '" stroke-width="1.5" opacity="0.6"/>' : ''}
  </svg>`;
}

/** Link to an external map, opened only on an explicit click. */
export function mapLink(lat, lng) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}
