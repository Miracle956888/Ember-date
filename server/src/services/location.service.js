import { query, queryOne, execute } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { calcAge } from './auth.service.js';
import { matchReasons } from './reasons.service.js';
import {
  snapToGrid,
  cellKey,
  cellsWithin,
  boundingBox,
  haversineKm,
  distanceLabel,
  shortDistance,
  proximityLabel,
  isValidLat,
  isValidLng,
  DISTANCE_SQL
} from '../utils/geo.js';

/** Positions older than this are treated as stale and hidden from discovery. */
const FRESH_HOURS = 72;

/** Two people within this many metres at roughly the same time "bumped into" each other. */
const BUMP_RADIUS_M = 250;

/** Both positions must be this recent for a bump to count. */
const BUMP_WINDOW_MIN = 30;

/**
 * Write (or clear) the caller's position, honouring their privacy mode.
 * 'hidden' deletes any stored point rather than just flagging it — the safest
 * reading of "stop sharing my location".
 */
export async function updateMyLocation(userId, { lat, lng, accuracy = null, city = null }) {
  if (!isValidLat(lat) || !isValidLng(lng)) throw badRequest('Those coordinates are not valid.');

  const settings = await getSettings(userId);
  if (settings.locationMode === 'hidden') {
    await clearMyLocation(userId);
    return { stored: false, mode: 'hidden' };
  }

  const point =
    settings.locationMode === 'approximate' ? snapToGrid(lat, lng) : { lat: round6(lat), lng: round6(lng) };

  await execute(
    `INSERT INTO user_locations (user_id, lat, lng, accuracy_m, geohash, city, source, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'gps', NOW())
     ON DUPLICATE KEY UPDATE lat = VALUES(lat), lng = VALUES(lng), accuracy_m = VALUES(accuracy_m),
                             geohash = VALUES(geohash), city = COALESCE(VALUES(city), city),
                             source = 'gps', updated_at = NOW()`,
    [
      userId,
      point.lat,
      point.lng,
      settings.locationMode === 'approximate' ? null : accuracy,
      cellKey(point.lat, point.lng),
      city
    ]
  );

  // Keep the free-text city in sync when the client resolved one.
  if (city) await execute('UPDATE users SET city = ? WHERE id = ?', [city, userId]);

  const bumped = settings.allowBumpedInto ? await detectEncounters(userId, point) : [];

  return {
    stored: true,
    mode: settings.locationMode,
    // Echo back what we actually saved so the UI can be honest about precision.
    lat: point.lat,
    lng: point.lng,
    approximate: settings.locationMode === 'approximate',
    newEncounters: bumped.length
  };
}

export async function clearMyLocation(userId) {
  await execute('DELETE FROM user_locations WHERE user_id = ?', [userId]);
  return { cleared: true };
}

export async function getMyLocation(userId) {
  const row = await queryOne(
    `SELECT lat, lng, accuracy_m, city, source, updated_at,
            (updated_at > (NOW() - INTERVAL ? HOUR)) AS is_fresh
       FROM user_locations WHERE user_id = ? LIMIT 1`,
    [FRESH_HOURS, userId]
  );
  if (!row) return null;
  return {
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    city: row.city,
    source: row.source,
    isFresh: Boolean(Number(row.is_fresh)),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

/**
 * The point discovery should search from: the Passport pin when one is set,
 * otherwise the real position.
 */
export async function getSearchOrigin(userId) {
  const settings = await getSettings(userId);
  if (settings.passport && settings.passport.lat !== null) {
    return {
      lat: settings.passport.lat,
      lng: settings.passport.lng,
      label: settings.passport.label,
      isPassport: true
    };
  }
  const own = await getMyLocation(userId);
  if (!own) return null;
  return { lat: own.lat, lng: own.lng, label: own.city, isPassport: false };
}

/**
 * Badoo-style "People Nearby": a browsable grid of people around you, ordered
 * by distance. Unlike the deck this does not consume swipes and shows people
 * you have already passed on.
 */
export async function peopleNearby(
  userId,
  { radiusKm = 50, limit = 30, cursor = null, onlineOnly = false } = {}
) {
  const origin = await getSearchOrigin(userId);
  if (!origin) return { origin: null, results: [], count: 0, needsLocation: true };

  const settings = await getSettings(userId);
  const cells = cellsWithin(origin.lat, origin.lng, radiusKm);
  const box = boundingBox(origin.lat, origin.lng, radiusKm);
  const cellPlaceholders = cells.map(() => '?').join(',');

  // Keyset pagination on (distance_km, id) rather than OFFSET. Nearby is a
  // live list -- people move, go online and drop out of the radius while it is
  // being scrolled -- and OFFSET re-counts from the top on every page, so any
  // shift silently skips or repeats a row. The cursor pins the position to the
  // last row actually seen. `id` is the tiebreaker that makes the order total:
  // without it two people at an identical distance can swap between pages.
  // HAVING, not WHERE: distance_km is a select alias.
  const keyset = cursor?.distanceKm !== undefined && cursor?.id !== undefined;
  const keysetSql = keyset ? ' AND (distance_km > ? OR (distance_km = ? AND u.id > ?))' : '';
  const keysetParams = keyset
    ? [Number(cursor.distanceKm), Number(cursor.distanceKm), Number(cursor.id)]
    : [];

  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.birthdate, u.gender, u.bio, u.city,
            u.avatar_url, u.is_online, u.last_seen_at, u.is_verified, u.intent,
            ul.updated_at AS located_at,
            ${DISTANCE_SQL} AS distance_km,
            s.direction AS my_direction,
            m.id AS match_id,
            f.id AS favorite_id
       FROM user_locations ul
       JOIN users u ON u.id = ul.user_id
       LEFT JOIN user_settings us ON us.user_id = u.id
       LEFT JOIN swipes s ON s.swiper_id = ? AND s.swipee_id = u.id
       LEFT JOIN matches m ON m.user_a_id = LEAST(?, u.id) AND m.user_b_id = GREATEST(?, u.id)
       LEFT JOIN favorites f ON f.owner_id = ? AND f.target_id = u.id
      WHERE u.id <> ?
        AND ul.geohash IN (${cellPlaceholders})
        AND ul.lat BETWEEN ? AND ?
        AND ul.lng BETWEEN ? AND ?
        AND ul.updated_at > (NOW() - INTERVAL ? HOUR)
        AND COALESCE(us.incognito, 0) = 0
        AND COALESCE(us.location_mode, 'approximate') <> 'hidden'
        AND (? = 0 OR u.is_online = 1)
        AND (? = 0 OR u.is_verified = 1)
        AND (u.birthdate IS NULL
             -- Sargable age filter. TIMESTAMPDIFF(...) BETWEEN ? AND ? had to be
             -- evaluated for every row and could never use an index; the
             -- equivalent date range can. maxAge compares against max+1 years
             -- so the whole of that final year still qualifies -- verified
             -- to select identical rows on a 50k fixture.
             OR (u.birthdate <= (CURDATE() - INTERVAL ? YEAR)
                 AND u.birthdate > (CURDATE() - INTERVAL (? + 1) YEAR)))
        -- Two indexed lookups, not one OR. The OR form made MariaDB scan the
        -- whole uniq_block index once per candidate; splitting it lets each
        -- half seek. Identical results, ~4x faster on a 50k fixture.
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE b.blocker_id = ? AND b.blocked_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM blocks b2
                         WHERE b2.blocker_id = u.id AND b2.blocked_id = ?)
     HAVING distance_km <= ?${keysetSql}
      ORDER BY distance_km ASC, u.id ASC
      LIMIT ?`,
    [
      origin.lat, origin.lat, origin.lng,
      userId, userId, userId, userId, userId,
      ...cells,
      box.minLat, box.maxLat, box.minLng, box.maxLng,
      FRESH_HOURS,
      onlineOnly || settings.onlineOnly ? 1 : 0,
      settings.verifiedOnly ? 1 : 0,
      settings.minAge, settings.maxAge,
      userId, userId,
      radiusKm,
      ...keysetParams,
      String(limit)
    ]
  );

  const results = await decorate(userId, rows);
  // The cursor is the sort key of the last row, so the next page resumes
  // exactly where this one stopped. Null once the page is short of `limit`.
  const last = rows.length === Number(limit) ? rows[rows.length - 1] : null;
  return {
    origin: { label: origin.label, isPassport: origin.isPassport },
    results,
    count: results.length,
    radiusKm,
    nextCursor: last ? { distanceKm: Number(last.distance_km), id: Number(last.id) } : null,
    needsLocation: false
  };
}

/**
 * Badoo's "Bumped into": people whose position was close to yours at roughly
 * the same moment. Detection runs on every location write, so this read is a
 * plain lookup of what was already recorded.
 */
async function detectEncounters(userId, point) {
  const cells = cellsWithin(point.lat, point.lng, BUMP_RADIUS_M / 1000);
  const cellPlaceholders = cells.map(() => '?').join(',');
  const box = boundingBox(point.lat, point.lng, BUMP_RADIUS_M / 1000);

  const near = await query(
    `SELECT ul.user_id, ul.lat, ul.lng
       FROM user_locations ul
       LEFT JOIN user_settings us ON us.user_id = ul.user_id
      WHERE ul.user_id <> ?
        AND ul.geohash IN (${cellPlaceholders})
        AND ul.lat BETWEEN ? AND ?
        AND ul.lng BETWEEN ? AND ?
        AND ul.updated_at > (NOW() - INTERVAL ? MINUTE)
        AND COALESCE(us.allow_bumped_into, 1) = 1
        AND COALESCE(us.incognito, 0) = 0
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = ul.user_id)
                                                  OR (b.blocker_id = ul.user_id AND b.blocked_id = ?))
      LIMIT 50`,
    [userId, ...cells, box.minLat, box.maxLat, box.minLng, box.maxLng, BUMP_WINDOW_MIN, userId, userId]
  );

  const fresh = [];
  for (const row of near) {
    const metres = haversineKm(point.lat, point.lng, Number(row.lat), Number(row.lng)) * 1000;
    if (metres > BUMP_RADIUS_M) continue;

    const otherId = Number(row.user_id);
    const a = Math.min(userId, otherId);
    const b = Math.max(userId, otherId);
    const res = await execute(
      `INSERT INTO encounters (user_a_id, user_b_id, met_on, distance_m, last_met_at)
            VALUES (?, ?, CURDATE(), ?, NOW())
       ON DUPLICATE KEY UPDATE times_met = times_met + 1,
                               distance_m = LEAST(distance_m, VALUES(distance_m)),
                               last_met_at = NOW()`,
      [a, b, Math.round(metres)]
    );
    // affectedRows === 1 means a brand new row, 2 means it updated an existing one.
    if (res.affectedRows === 1) fresh.push(otherId);
  }
  return fresh;
}

export async function bumpedInto(userId, { limit = 30, days = 7 } = {}) {
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.birthdate, u.gender, u.bio, u.city,
            u.avatar_url, u.is_online, u.last_seen_at, u.is_verified, u.intent,
            e.distance_m, e.times_met, e.last_met_at, e.place_label,
            s.direction AS my_direction,
            m.id AS match_id,
            f.id AS favorite_id
       FROM encounters e
       JOIN users u ON u.id = IF(e.user_a_id = ?, e.user_b_id, e.user_a_id)
       LEFT JOIN user_settings us ON us.user_id = u.id
       LEFT JOIN swipes s ON s.swiper_id = ? AND s.swipee_id = u.id
       LEFT JOIN matches m ON m.user_a_id = LEAST(?, u.id) AND m.user_b_id = GREATEST(?, u.id)
       LEFT JOIN favorites f ON f.owner_id = ? AND f.target_id = u.id
      WHERE (e.user_a_id = ? OR e.user_b_id = ?)
        AND e.last_met_at > (NOW() - INTERVAL ? DAY)
        AND COALESCE(us.allow_bumped_into, 1) = 1
        AND COALESCE(us.incognito, 0) = 0
        -- Two indexed lookups, not one OR. The OR form made MariaDB scan the
        -- whole uniq_block index once per candidate; splitting it lets each
        -- half seek. Identical results, ~4x faster on a 50k fixture.
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE b.blocker_id = ? AND b.blocked_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM blocks b2
                         WHERE b2.blocker_id = u.id AND b2.blocked_id = ?)
      ORDER BY e.last_met_at DESC
      LIMIT ?`,
    [userId, userId, userId, userId, userId, userId, userId, days, userId, userId, String(limit)]
  );

  const results = await decorate(userId, rows);
  return results.map((r, i) => ({
    ...r,
    timesMet: Number(rows[i].times_met),
    proximity: proximityLabel(Number(rows[i].distance_m)),
    placeLabel: rows[i].place_label,
    lastMetAt: new Date(rows[i].last_met_at).toISOString()
  }));
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SETTINGS_DEFAULTS = {
  minAge: 18,
  maxAge: 55,
  maxDistanceKm: 100,
  verifiedOnly: false,
  onlineOnly: false,
  showMeGlobally: true,
  incognito: false,
  locationMode: 'approximate',
  showDistance: true,
  showOnline: true,
  allowBumpedInto: true,
  passport: null
};

export async function getSettings(userId) {
  const row = await queryOne('SELECT * FROM user_settings WHERE user_id = ? LIMIT 1', [userId]);
  if (!row) return { ...SETTINGS_DEFAULTS };
  return {
    minAge: Number(row.min_age),
    maxAge: Number(row.max_age),
    maxDistanceKm: Number(row.max_distance_km),
    verifiedOnly: Boolean(row.verified_only),
    onlineOnly: Boolean(row.online_only),
    showMeGlobally: Boolean(row.show_me_globally),
    incognito: Boolean(row.incognito),
    locationMode: row.location_mode,
    showDistance: Boolean(row.show_distance),
    showOnline: Boolean(row.show_online),
    allowBumpedInto: Boolean(row.allow_bumped_into),
    passport:
      row.passport_lat === null
        ? null
        : { lat: Number(row.passport_lat), lng: Number(row.passport_lng), label: row.passport_label }
  };
}

const SETTING_COLUMNS = {
  minAge: 'min_age',
  maxAge: 'max_age',
  maxDistanceKm: 'max_distance_km',
  verifiedOnly: 'verified_only',
  onlineOnly: 'online_only',
  showMeGlobally: 'show_me_globally',
  incognito: 'incognito',
  locationMode: 'location_mode',
  showDistance: 'show_distance',
  showOnline: 'show_online',
  allowBumpedInto: 'allow_bumped_into'
};

export async function updateSettings(userId, patch) {
  const current = await getSettings(userId);
  const merged = { ...current, ...patch };
  if (merged.minAge > merged.maxAge) throw badRequest('Minimum age cannot be above the maximum.');

  const cols = [];
  const vals = [];
  for (const [key, column] of Object.entries(SETTING_COLUMNS)) {
    if (patch[key] === undefined) continue;
    cols.push(column);
    vals.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : patch[key]);
  }
  if (!cols.length) return current;

  // Ensure the row exists, then patch only what was sent.
  await execute('INSERT IGNORE INTO user_settings (user_id) VALUES (?)', [userId]);
  await execute(
    `UPDATE user_settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE user_id = ?`,
    [...vals, userId]
  );

  // Turning on 'hidden' must retroactively erase what we already hold.
  if (patch.locationMode === 'hidden') await clearMyLocation(userId);

  return getSettings(userId);
}

/** Tinder Passport: pretend to be somewhere else for discovery. */
export async function setPassport(userId, { lat, lng, label }) {
  if (!isValidLat(lat) || !isValidLng(lng)) throw badRequest('Those coordinates are not valid.');
  await execute('INSERT IGNORE INTO user_settings (user_id) VALUES (?)', [userId]);
  await execute(
    'UPDATE user_settings SET passport_lat = ?, passport_lng = ?, passport_label = ? WHERE user_id = ?',
    [round6(lat), round6(lng), label || null, userId]
  );
  return getSettings(userId);
}

export async function clearPassport(userId) {
  await execute(
    'UPDATE user_settings SET passport_lat = NULL, passport_lng = NULL, passport_label = NULL WHERE user_id = ?',
    [userId]
  );
  return getSettings(userId);
}

/* ------------------------------------------------------------------ */
/* Shared row decoration                                               */
/* ------------------------------------------------------------------ */

/**
 * Attach photos, shared interests and match reasons to a batch of user rows.
 *
 * Every feed in the app funnels through here, so adding reasons at this one
 * point means the deck, Nearby, Likes You, Top Picks and Favourites all show
 * the same explanation for the same pair — with no extra query per row.
 */
export async function decorate(viewerId, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const placeholders = ids.map(() => '?').join(',');

  const [photos, shared, langRows, viewer] = await Promise.all([
    query(
      `SELECT id, user_id, url, position FROM user_photos
        WHERE user_id IN (${placeholders}) ORDER BY user_id, position ASC`,
      ids
    ),
    query(
      `SELECT ui.user_id, i.slug, i.label, i.emoji
         FROM user_interests ui
         JOIN interests i ON i.id = ui.interest_id
        WHERE ui.user_id IN (${placeholders})
          AND ui.interest_id IN (SELECT interest_id FROM user_interests WHERE user_id = ?)`,
      [...ids, viewerId]
    ),
    query(`SELECT id, languages FROM users WHERE id IN (${placeholders})`, ids),
    queryOne('SELECT city, intent, languages FROM users WHERE id = ? LIMIT 1', [viewerId])
  ]);

  const langsBy = new Map();
  for (const r of langRows) langsBy.set(Number(r.id), parseLanguages(r.languages));

  // The viewer's own facts, needed to say what the two of you have in common.
  const viewerFacts = {
    city: viewer?.city || null,
    intent: viewer?.intent || null,
    languages: parseLanguages(viewer?.languages)
  };

  const photosBy = new Map();
  for (const p of photos) {
    const key = Number(p.user_id);
    if (!photosBy.has(key)) photosBy.set(key, []);
    photosBy.get(key).push({ id: Number(p.id), url: p.url, position: p.position });
  }
  const sharedBy = new Map();
  for (const s of shared) {
    const key = Number(s.user_id);
    if (!sharedBy.has(key)) sharedBy.set(key, []);
    sharedBy.get(key).push({ slug: s.slug, label: s.label, emoji: s.emoji });
  }

  return rows.map((r) => {
    const id = Number(r.id);
    const km = r.distance_km === undefined || r.distance_km === null ? null : Number(r.distance_km);
    const person = {
      id,
      username: r.username,
      displayName: r.display_name,
      age: r.birthdate ? calcAge(r.birthdate) : null,
      gender: r.gender,
      bio: r.bio,
      city: r.city,
      avatarUrl: r.avatar_url,
      isOnline: Boolean(r.is_online),
      isVerified: Boolean(r.is_verified),
      intent: r.intent || null,
      photos: photosBy.get(id) || (r.avatar_url ? [{ id: 0, url: r.avatar_url, position: 0 }] : []),
      sharedInterests: sharedBy.get(id) || [],
      distanceKm: km === null ? null : Math.round(km * 10) / 10,
      distance: distanceLabel(km),
      distanceShort: shortDistance(km),
      myDirection: r.my_direction || null,
      matched: Boolean(r.match_id),
      isFavorite: Boolean(r.favorite_id)
    };
    // Reasons are derived purely from fields already on this object, so they
    // can never expose anything the viewer was not already allowed to see.
    person.languages = langsBy.get(id) || [];
    person.reasons = matchReasons(person, viewerFacts);
    return person;
  });
}

/** `users.languages` is JSON; MySQL and MariaDB disagree on whether it parses. */
function parseLanguages(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function round6(n) {
  return Number(Number(n).toFixed(6));
}

/* ------------------------------------------------------------------ */
/* Location sharing inside a chat                                      */
/* ------------------------------------------------------------------ */

/**
 * Attach a place to a message. Live shares carry an expiry of their own but can
 * never outlive the message's 24h TTL.
 */
export async function attachLocationToMessage(
  { messageId, senderId, lat, lng, accuracy, label, liveMinutes, expiresAt }
) {
  if (!isValidLat(lat) || !isValidLng(lng)) throw badRequest('Those coordinates are not valid.');
  const isLive = Number.isFinite(liveMinutes) && liveMinutes > 0;

  await execute(
    `INSERT INTO message_locations
       (message_id, sender_id, lat, lng, accuracy_m, label, is_live, live_until, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${isLive ? 'LEAST(? , ?)' : 'NULL'}, ?)`,
    isLive
      ? [
        messageId, senderId, round6(lat), round6(lng), accuracy ?? null, label || null, 1,
        new Date(Date.now() + liveMinutes * 60000), expiresAt, expiresAt
      ]
      : [messageId, senderId, round6(lat), round6(lng), accuracy ?? null, label || null, 0, expiresAt]
  );
}

/** Move a live share. Only the sender may, and only while it is still live. */
export async function updateLiveLocation(userId, messageId, { lat, lng, accuracy }) {
  if (!isValidLat(lat) || !isValidLng(lng)) throw badRequest('Those coordinates are not valid.');
  const row = await queryOne(
    `SELECT id, sender_id, is_live, live_until FROM message_locations
      WHERE message_id = ? AND expires_at > NOW() LIMIT 1`,
    [messageId]
  );
  if (!row) throw notFound('That location share has expired.');
  if (Number(row.sender_id) !== userId) throw forbidden('That is not your location share.');
  if (!row.is_live || new Date(row.live_until) < new Date()) throw badRequest('That share is no longer live.');

  await execute(
    'UPDATE message_locations SET lat = ?, lng = ?, accuracy_m = ?, updated_at = NOW() WHERE id = ?',
    [round6(lat), round6(lng), accuracy ?? null, row.id]
  );
  return { lat: round6(lat), lng: round6(lng), updatedAt: new Date().toISOString() };
}

/** Stop a live share early without deleting the message. */
export async function stopLiveLocation(userId, messageId) {
  const row = await queryOne(
    'SELECT id, sender_id FROM message_locations WHERE message_id = ? LIMIT 1',
    [messageId]
  );
  if (!row) throw notFound('That location share no longer exists.');
  if (Number(row.sender_id) !== userId) throw forbidden('That is not your location share.');
  await execute('UPDATE message_locations SET is_live = 0, live_until = NOW() WHERE id = ?', [row.id]);
  return { stopped: true };
}

/** Locations for a batch of messages, keyed by message id. */
export async function locationsForMessages(messageIds) {
  if (!messageIds.length) return new Map();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await query(
    `SELECT message_id, lat, lng, accuracy_m, label, is_live, live_until, updated_at
       FROM message_locations
      WHERE message_id IN (${placeholders}) AND expires_at > NOW()`,
    messageIds
  );
  const map = new Map();
  for (const r of rows) {
    const live = Boolean(r.is_live) && r.live_until && new Date(r.live_until) > new Date();
    map.set(Number(r.message_id), {
      lat: Number(r.lat),
      lng: Number(r.lng),
      accuracyM: r.accuracy_m === null ? null : Number(r.accuracy_m),
      label: r.label,
      isLive: live,
      liveUntil: r.live_until ? new Date(r.live_until).toISOString() : null,
      updatedAt: new Date(r.updated_at).toISOString()
    });
  }
  return map;
}
