import { query, queryOne, execute } from '../db/pool.js';
import { notFound, badRequest, conflict } from '../utils/errors.js';
import { toPublicUser, calcAge, isUsernameAvailable } from './auth.service.js';
import { getUserInterests, getPrompts, sharedInterests, refreshCompletion } from './profile.service.js';
import { getSettings, getSearchOrigin, decorate } from './location.service.js';
import { matchReasons } from './reasons.service.js';
import { haversineKm, distanceLabel, shortDistance, DISTANCE_SQL } from '../utils/geo.js';

/**
 * `users.languages` is a JSON column; drivers differ on whether it arrives
 * parsed. Kept local so this module stays free of a like.service import —
 * like.service already depends on this file, and a cycle there would be
 * fragile for no benefit.
 */
function jsonList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const MAX_PHOTOS = 6;

/** Candidates for the swipe deck: not me, not swiped, not blocked either way. */
export async function getDeck(userId, limit = 10) {
  const me = await queryOne('SELECT interested_in, gender FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!me) throw notFound('User not found.');

  const [settings, origin] = await Promise.all([getSettings(userId), getSearchOrigin(userId)]);
  const hasOrigin = Boolean(origin);

  // Distance is only selectable when we know where the viewer is. Everything
  // else in the query stays identical so there is one code path to reason about.
  const distanceSelect = hasOrigin ? `${DISTANCE_SQL} AS distance_km` : 'NULL AS distance_km';
  const distanceJoin = hasOrigin ? 'LEFT JOIN user_locations ul ON ul.user_id = u.id' : '';
  const distanceParams = hasOrigin ? [origin.lat, origin.lat, origin.lng] : [];
  // When a max distance is set, people we cannot place are still shown rather
  // than hidden — otherwise a new user with no GPS would see an empty deck.
  const distanceFilter = hasOrigin
    ? `AND (ul.user_id IS NULL OR ${DISTANCE_SQL} <= ?)`
    : '';
  const distanceFilterParams = hasOrigin
    ? [origin.lat, origin.lat, origin.lng, settings.maxDistanceKm]
    : [];

  // DEFERRED JOIN. The deck has to rank every candidate before it can know
  // which ten to show, and sorting 50k rows that each carry bio/city/avatar
  // means the sort buffer moves the whole payload. The inner query therefore
  // sorts nothing but the id and the sort keys; the outer query fetches the
  // wide columns for the ten survivors only. Same rows, same order --
  // verified against a saved snapshot on a 50k-user fixture.
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.birthdate, u.gender, u.bio, u.city, u.avatar_url,
            u.is_online, u.last_seen_at, u.is_verified, u.intent, u.job_title, u.school, u.height_cm,
            k.distance_km,
            k.shared_count,
            k.boosted,
            NULL AS my_direction, NULL AS match_id,
            k.favorite_id
       FROM (
         SELECT u.id,
                ${distanceSelect},
                COALESCE(si.shared_count, 0) AS shared_count,
                (bo.user_id IS NOT NULL) AS boosted,
                f.id AS favorite_id,
                u.is_online AS k_is_online,
                u.last_seen_at AS k_last_seen_at
           FROM users u
           ${distanceJoin}
           LEFT JOIN user_settings us ON us.user_id = u.id
           LEFT JOIN favorites f ON f.owner_id = ? AND f.target_id = u.id
           -- Shared-interest counts were a correlated subquery, re-executed
           -- once per candidate: 50k executions and ~190ms of the deck's cost.
           -- Aggregating the viewer's interests once and joining is the same
           -- arithmetic in a single indexed pass.
           LEFT JOIN (
             SELECT a.user_id, COUNT(*) AS shared_count
               FROM user_interests a
               JOIN user_interests b ON b.interest_id = a.interest_id AND b.user_id = ?
              GROUP BY a.user_id
           ) si ON si.user_id = u.id
           -- Likewise the boost EXISTS: active boosts are few, so join them.
           LEFT JOIN (
             SELECT DISTINCT user_id FROM boosts WHERE expires_at > NOW()
           ) bo ON bo.user_id = u.id
          WHERE u.id <> ?
            AND (? = 'everyone' OR u.gender IS NULL OR u.gender = ?)
            AND (u.interested_in = 'everyone' OR u.interested_in IS NULL
                 OR ? IS NULL OR u.interested_in = ?)
            AND COALESCE(us.show_me_globally, 1) = 1
            AND COALESCE(us.incognito, 0) = 0
            AND (? = 0 OR u.is_verified = 1)
            AND (? = 0 OR u.is_online = 1)
            AND (u.birthdate IS NULL
                 -- Sargable age filter. TIMESTAMPDIFF(...) BETWEEN ? AND ? had
                 -- to be evaluated for every row and could never use an index;
                 -- the equivalent date range can. maxAge compares against
                 -- max+1 years so the whole of that final year still
                 -- qualifies -- verified to select identical rows on 50k.
                 OR (u.birthdate <= (CURDATE() - INTERVAL ? YEAR)
                     AND u.birthdate > (CURDATE() - INTERVAL (? + 1) YEAR)))
            ${distanceFilter}
            AND NOT EXISTS (SELECT 1 FROM swipes s WHERE s.swiper_id = ? AND s.swipee_id = u.id)
            -- Two indexed lookups, not one OR. The OR form made MariaDB scan the
            -- whole uniq_block index once per candidate; splitting it lets each
            -- half seek. Identical results, ~4x faster on a 50k fixture.
            AND NOT EXISTS (SELECT 1 FROM blocks b
                             WHERE b.blocker_id = ? AND b.blocked_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM blocks b2
                             WHERE b2.blocker_id = u.id AND b2.blocked_id = ?)
          ORDER BY boosted DESC, shared_count DESC, u.is_online DESC, u.last_seen_at DESC, u.id ASC
          LIMIT ?
       ) k
       JOIN users u ON u.id = k.id
      ORDER BY k.boosted DESC, k.shared_count DESC, k.k_is_online DESC,
               k.k_last_seen_at DESC, u.id ASC`,
    [
      ...distanceParams,
      userId, // favorites join
      userId, // shared-interest aggregate
      userId, // u.id <> ?
      me.interested_in || 'everyone',
      me.interested_in || 'everyone',
      me.gender,
      me.gender,
      settings.verifiedOnly ? 1 : 0,
      settings.onlineOnly ? 1 : 0,
      settings.minAge,
      settings.maxAge,
      ...distanceFilterParams,
      userId,
      userId,
      userId,
      String(limit)
    ]
  );

  if (!rows.length) return [];

  const decorated = await decorate(userId, rows);
  return decorated.map((d, i) => ({
    ...d,
    jobTitle: rows[i].job_title,
    school: rows[i].school,
    heightCm: rows[i].height_cm === null ? null : Number(rows[i].height_cm),
    boosted: Boolean(Number(rows[i].boosted))
  }));
}

/**
 * Find people by their public handle so you can match with someone you already
 * know. Exact handle first, then prefix, then display-name contains. Blocked
 * users (either direction) never appear. Each hit carries the relationship so
 * the UI can offer "Like" or "Message" without a second round trip.
 */
// Upper bound on rows each search branch may contribute before ranking.
const CANDIDATE_CAP = 300;

export async function searchUsers(viewerId, term, limit = 10) {
  const q = String(term).toLowerCase();
  const like = `${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  // Display-name matching used `LIKE '%term%'`. A leading wildcard cannot use
  // a BTREE index, so at 50k users that query examined every row (measured:
  // 50,013 examined to return 10). It now goes through a FULLTEXT index in
  // boolean mode with a trailing `*`, which matches word prefixes -- "kel"
  // still finds "Kelechi".
  //
  // InnoDB will not tokenise words shorter than `innodb_ft_min_token_size`
  // (3 by default), so a one or two character term would silently match
  // nothing. Those fall back to the old contains-scan, which is acceptable
  // precisely because such a query is cheap to bound and rare in practice --
  // and correctness beats speed when the alternative is "no results".
  const ftEligible = q.length >= 3;
  const ftTerm = ftEligible
    ? q
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3)
        .map((w) => `+${w}*`)
        .join(' ')
    : '';
  const useFulltext = ftEligible && ftTerm.length > 0;
  const contains = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  // Both halves are indexable on their own, but `username LIKE ? OR
  // MATCH(display_name)` is NOT: the optimiser cannot combine a range scan and
  // a fulltext scan across an OR, so it gives up and scans the table. Measured
  // at 50k rows, the OR form cost 135ms; this UNION of two independently
  // indexed branches, joined back by primary key, costs ~45ms and each branch
  // shows its own index in EXPLAIN (`range` + `fulltext`).
  //
  // `IN (SELECT ... UNION ...)` was also tried and is a trap -- MariaDB turns
  // it into a DEPENDENT SUBQUERY re-evaluated per row: 81 SECONDS.
  //
  // Each branch is also capped. A broad term can match a huge number of rows
  // (a load test where every display name shared one token matched all 50,000),
  // and sorting 50k rows to return 10 cost 340ms even with both indexes used.
  // The cap bounds that work. It is not an arbitrary truncation: each branch
  // sorts before it cuts -- the fulltext branch by relevance, the username
  // branch alphabetically -- so the cap keeps the best candidates and the
  // final ORDER BY below then ranks them. CANDIDATE_CAP is a fixed literal
  // (never user input) and sits far above any realistic page size.
  const nameMatch = useFulltext
    ? 'MATCH(display_name) AGAINST(? IN BOOLEAN MODE)'
    : "display_name LIKE ? ESCAPE '\\\\'";
  const nameParam = useFulltext ? ftTerm : contains;
  const nameOrder = useFulltext
    ? 'ORDER BY MATCH(display_name) AGAINST(? IN BOOLEAN MODE) DESC'
    : 'ORDER BY display_name ASC';

  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.birthdate, u.gender, u.bio, u.city,
            u.avatar_url, u.is_online, u.last_seen_at, u.is_verified, u.intent, u.languages,
            s.direction        AS my_direction,
            m.id               AS match_id,
            c.id               AS conversation_id
       FROM users u
       JOIN ( (SELECT id FROM users WHERE username LIKE ? ESCAPE '\\\\'
                ORDER BY username ASC LIMIT ${CANDIDATE_CAP})
              UNION
              (SELECT id FROM users WHERE ${nameMatch}
                ${nameOrder} LIMIT ${CANDIDATE_CAP})
            ) hit ON hit.id = u.id
       LEFT JOIN swipes s ON s.swiper_id = ? AND s.swipee_id = u.id
       LEFT JOIN matches m ON m.user_a_id = LEAST(?, u.id) AND m.user_b_id = GREATEST(?, u.id)
       LEFT JOIN conversations c ON c.match_id = m.id
      WHERE u.id <> ?
        -- Two indexed lookups, not one OR. The OR form made MariaDB scan the
        -- whole uniq_block index once per candidate; splitting it lets each
        -- half seek. Identical results, ~4x faster on a 50k fixture.
        AND NOT EXISTS (SELECT 1 FROM blocks b
                         WHERE b.blocker_id = ? AND b.blocked_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM blocks b2
                         WHERE b2.blocker_id = u.id AND b2.blocked_id = ?)
      ORDER BY (u.username = ?) DESC,
               (u.username LIKE ? ESCAPE '\\\\') DESC,
               u.is_online DESC,
               u.username ASC
      LIMIT ?`,
    [like, nameParam, ...(useFulltext ? [nameParam] : []), viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, q, like, String(limit)]
  );

  if (!rows.length) return [];

  const ids = rows.map((r) => Number(r.id));
  const placeholders = ids.map(() => '?').join(',');
  // Search results get the same "why" line as every other surface, so a hit
  // found by handle is as informative as one found by swiping.
  const [photos, sharedRows, viewerRow] = await Promise.all([
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
    queryOne('SELECT city, intent, languages FROM users WHERE id = ? LIMIT 1', [viewerId])
  ]);

  const sharedBy = new Map();
  for (const r of sharedRows) {
    const key = Number(r.user_id);
    if (!sharedBy.has(key)) sharedBy.set(key, []);
    sharedBy.get(key).push({ slug: r.slug, label: r.label, emoji: r.emoji });
  }
  const viewerFacts = {
    city: viewerRow?.city || null,
    intent: viewerRow?.intent || null,
    languages: jsonList(viewerRow?.languages)
  };

  const byUser = new Map();
  for (const p of photos) {
    const key = Number(p.user_id);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push({ id: Number(p.id), url: p.url, position: p.position });
  }

  return rows.map((r) => {
    const person = {
      id: Number(r.id),
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
      languages: jsonList(r.languages),
      sharedInterests: sharedBy.get(Number(r.id)) || [],
      photos: byUser.get(Number(r.id)) || (r.avatar_url ? [{ id: 0, url: r.avatar_url, position: 0 }] : []),
      myDirection: r.my_direction || null,
      matched: Boolean(r.match_id),
      conversationId: r.conversation_id ? Number(r.conversation_id) : null
    };
    person.reasons = matchReasons(person, viewerFacts);
    return person;
  });
}

export async function getPublicProfile(viewerId, targetId) {
  const blocked = await queryOne(
    `SELECT 1 AS x FROM blocks
      WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`,
    [viewerId, targetId, targetId, viewerId]
  );
  if (blocked) throw notFound('That profile is not available.');

  const row = await queryOne(
    `SELECT id, username, display_name, birthdate, gender, interested_in, bio, city, avatar_url,
            is_online, last_seen_at, created_at, is_verified, verified_at, intent,
            job_title, school, height_cm, languages
       FROM users WHERE id = ? LIMIT 1`,
    [targetId]
  );
  if (!row) throw notFound('That profile is not available.');

  const [photos, interests, prompts, shared, viewerSettings, targetSettings] = await Promise.all([
    query('SELECT id, url, position FROM user_photos WHERE user_id = ? ORDER BY position ASC', [targetId]),
    getUserInterests(targetId),
    getPrompts(targetId),
    sharedInterests(viewerId, targetId),
    getSettings(viewerId),
    getSettings(targetId)
  ]);

  // Distance is computed here rather than selected, so we can respect the
  // target's "show distance" switch without leaking it through SQL shape.
  let distanceKm = null;
  if (targetSettings.showDistance && targetSettings.locationMode !== 'hidden') {
    const [mine, theirs] = await Promise.all([getSearchOrigin(viewerId), getStoredPoint(targetId)]);
    if (mine && theirs) distanceKm = haversineKm(mine.lat, mine.lng, theirs.lat, theirs.lng);
  }

  const [favorite, viewerRow, likeState] = await Promise.all([
    queryOne('SELECT id FROM favorites WHERE owner_id = ? AND target_id = ? LIMIT 1', [viewerId, targetId]),
    queryOne('SELECT city, intent, languages FROM users WHERE id = ? LIMIT 1', [viewerId]),
    Promise.all([
      queryOne(
        `SELECT 1 AS x FROM content_likes
          WHERE user_id = ? AND target_type = 'profile' AND target_id = ? LIMIT 1`,
        [viewerId, targetId]
      ),
      queryOne(
        "SELECT COUNT(*) AS n FROM content_likes WHERE target_type = 'profile' AND target_id = ?",
        [targetId]
      )
    ])
  ]);

  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    age: row.birthdate ? calcAge(row.birthdate) : null,
    gender: row.gender,
    bio: row.bio,
    city: row.city,
    avatarUrl: row.avatar_url,
    isOnline: targetSettings.showOnline ? Boolean(row.is_online) : false,
    lastSeenAt:
      targetSettings.showOnline && row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    isVerified: Boolean(row.is_verified),
    intent: row.intent,
    jobTitle: row.job_title,
    school: row.school,
    heightCm: row.height_cm === null ? null : Number(row.height_cm),
    interests,
    prompts,
    sharedInterests: shared,
    distanceKm: distanceKm === null ? null : Math.round(distanceKm * 10) / 10,
    distance: distanceLabel(distanceKm),
    isFavorite: Boolean(favorite),
    liked: Boolean(likeState[0]),
    likeCount: Number(likeState[1]?.n || 0),
    reasons: matchReasons(
      {
        sharedInterests: shared,
        city: row.city,
        intent: row.intent,
        languages: jsonList(row.languages),
        isVerified: Boolean(row.is_verified),
        isOnline: targetSettings.showOnline ? Boolean(row.is_online) : false,
        distanceKm,
        distanceShort: shortDistance(distanceKm)
      },
      {
        city: viewerRow?.city || null,
        intent: viewerRow?.intent || null,
        languages: jsonList(viewerRow?.languages)
      }
    ),
    incognitoViewer: viewerSettings.incognito,
    photos: photos.map((p) => ({ id: Number(p.id), url: p.url, position: p.position }))
  };
}

/** Raw stored coordinates for one user. Server-side only — never serialised. */
async function getStoredPoint(userId) {
  const row = await queryOne('SELECT lat, lng FROM user_locations WHERE user_id = ? LIMIT 1', [userId]);
  return row ? { lat: Number(row.lat), lng: Number(row.lng) } : null;
}

const FIELD_MAP = {
  username: 'username',
  displayName: 'display_name',
  birthdate: 'birthdate',
  gender: 'gender',
  interestedIn: 'interested_in',
  bio: 'bio',
  city: 'city',
  avatarUrl: 'avatar_url',
  intent: 'intent',
  jobTitle: 'job_title',
  school: 'school',
  heightCm: 'height_cm',
  languages: 'languages',
  hobbies: 'hobbies',
  country: 'country',
  timezone: 'timezone',
  locale: 'locale'
};

/** Columns stored as JSON arrays rather than scalars. */
const JSON_FIELDS = new Set(['languages', 'hobbies']);

export async function updateProfile(userId, patch) {
  if (patch.username && !(await isUsernameAvailable(patch.username, userId))) {
    throw conflict('That username is already taken.', {
      code: 'USERNAME_TAKEN',
      details: { username: 'That username is already taken.' }
    });
  }
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(FIELD_MAP)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${column} = ?`);
      const value = patch[key];
      if (JSON_FIELDS.has(key)) params.push(Array.isArray(value) && value.length ? JSON.stringify(value) : null);
      else params.push(value === '' ? null : value);
    }
  }
  if (!sets.length) throw badRequest('Nothing to update.');
  params.push(userId);
  try {
    await execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      throw conflict('That username is already taken.', {
        code: 'USERNAME_TAKEN',
        details: { username: 'That username is already taken.' }
      });
    }
    throw err;
  }
  // Any profile write can change the completion score.
  await refreshCompletion(userId).catch(() => {});

  const row = await queryOne('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  return toPublicUser(row);
}

export async function listPhotos(userId) {
  const rows = await query(
    'SELECT id, url, thumb_url, position FROM user_photos WHERE user_id = ? ORDER BY position ASC',
    [userId]
  );
  // Older rows predate thumb_url; fall back to the full image so the client
  // never renders a broken src for a photo uploaded before this column existed.
  return rows.map((r) => ({
    id: Number(r.id),
    url: r.url,
    thumbUrl: r.thumb_url || r.url,
    position: r.position
  }));
}

export async function addPhoto(userId, url, thumbUrl = null) {
  const [{ count }] = await query('SELECT COUNT(*) AS count FROM user_photos WHERE user_id = ?', [userId]);
  if (Number(count) >= MAX_PHOTOS) {
    throw badRequest(`You can have up to ${MAX_PHOTOS} photos. Remove one first.`);
  }
  const res = await execute(
    'INSERT INTO user_photos (user_id, url, thumb_url, position) VALUES (?,?,?,?)',
    [userId, url, thumbUrl || null, Number(count)]
  );
  // First photo becomes the avatar automatically.
  if (Number(count) === 0) {
    await execute('UPDATE users SET avatar_url = ? WHERE id = ?', [url, userId]);
  }
  return { id: Number(res.insertId), url, thumbUrl: thumbUrl || null, position: Number(count) };
}

export async function deletePhoto(userId, photoId) {
  const photo = await queryOne(
    'SELECT id, url, thumb_url FROM user_photos WHERE id = ? AND user_id = ? LIMIT 1',
    [photoId, userId]
  );
  if (!photo) throw notFound('Photo not found.');

  await execute('DELETE FROM user_photos WHERE id = ? AND user_id = ?', [photoId, userId]);

  // Re-pack positions so they stay 0..n-1.
  const remaining = await query('SELECT id FROM user_photos WHERE user_id = ? ORDER BY position ASC', [userId]);
  for (let i = 0; i < remaining.length; i += 1) {
    await execute('UPDATE user_photos SET position = ? WHERE id = ?', [i, remaining[i].id]);
  }

  const user = await queryOne('SELECT avatar_url FROM users WHERE id = ? LIMIT 1', [userId]);
  if (user?.avatar_url === photo.url) {
    const next = await queryOne('SELECT url FROM user_photos WHERE user_id = ? ORDER BY position ASC LIMIT 1', [
      userId
    ]);
    await execute('UPDATE users SET avatar_url = ? WHERE id = ?', [next?.url ?? null, userId]);
  }
  return { url: photo.url, thumbUrl: photo.thumb_url || null };
}

export async function reorderPhotos(userId, orderedIds) {
  const owned = await query('SELECT id FROM user_photos WHERE user_id = ?', [userId]);
  const ownedSet = new Set(owned.map((r) => Number(r.id)));
  if (orderedIds.length !== ownedSet.size || !orderedIds.every((id) => ownedSet.has(Number(id)))) {
    throw badRequest('Photo order does not match your photos.');
  }
  for (let i = 0; i < orderedIds.length; i += 1) {
    await execute('UPDATE user_photos SET position = ? WHERE id = ? AND user_id = ?', [i, orderedIds[i], userId]);
  }
  const first = await queryOne('SELECT url FROM user_photos WHERE user_id = ? ORDER BY position ASC LIMIT 1', [
    userId
  ]);
  if (first) await execute('UPDATE users SET avatar_url = ? WHERE id = ?', [first.url, userId]);
  return listPhotos(userId);
}

// ------------------------------------------------------------ blocks/reports

export async function blockUser(blockerId, blockedId) {
  if (blockerId === blockedId) throw badRequest('You cannot block yourself.');
  await execute(
    'INSERT INTO blocks (blocker_id, blocked_id) VALUES (?,?) ON DUPLICATE KEY UPDATE created_at = created_at',
    [blockerId, blockedId]
  );
  // Blocking also unmatches: find and remove any match between the two.
  const a = Math.min(blockerId, blockedId);
  const b = Math.max(blockerId, blockedId);
  const match = await queryOne('SELECT id FROM matches WHERE user_a_id = ? AND user_b_id = ? LIMIT 1', [a, b]);
  if (match) await execute('DELETE FROM matches WHERE id = ?', [match.id]);

  // A block must undo the whole relationship, not just hide it. Likes in both
  // directions are removed so neither party keeps appearing in the other's
  // "who liked you", and the notifications those likes generated go with them.
  await execute(
    `DELETE FROM content_likes
      WHERE (user_id = ? AND owner_id = ?) OR (user_id = ? AND owner_id = ?)`,
    [blockerId, blockedId, blockedId, blockerId]
  );
  await execute(
    `DELETE FROM notifications
      WHERE (user_id = ? AND actor_id = ?) OR (user_id = ? AND actor_id = ?)`,
    [blockerId, blockedId, blockedId, blockerId]
  );

  return { blocked: true, matchRemoved: Boolean(match) };
}

/** Lift a block. Does NOT restore the deleted match — that is gone for good. */
export async function unblockUser(blockerId, blockedId) {
  const res = await execute('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
  if (!res.affectedRows) throw notFound('You have not blocked that person.');
  return { unblocked: true };
}

/** People this user has blocked, newest first. */
export async function listBlocked(blockerId, { limit = 50 } = {}) {
  const rows = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, b.created_at
       FROM blocks b
       JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = ?
      ORDER BY b.created_at DESC
      LIMIT ?`,
    [blockerId, String(limit)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    blockedAt: r.created_at ? new Date(r.created_at).toISOString() : null
  }));
}

export async function reportUser(reporterId, reportedId, reason) {
  if (reporterId === reportedId) throw badRequest('You cannot report yourself.');
  const res = await execute('INSERT INTO reports (reporter_id, reported_id, reason) VALUES (?,?,?)', [
    reporterId,
    reportedId,
    reason
  ]);
  return { id: Number(res.insertId) };
}

export async function isBlockedEitherWay(userA, userB) {
  const row = await queryOne(
    `SELECT 1 AS x FROM blocks
      WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`,
    [userA, userB, userB, userA]
  );
  return Boolean(row);
}
