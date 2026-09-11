#!/usr/bin/env node
/**
 * Seeds 12 demo users (password: Password123!), profile photos, a few swipes,
 * two ready-made matches with conversations, and a handful of live messages so
 * the deck, match list and chat are testable the moment the server boots.
 *
 *   node db/seed.js
 *
 * Placeholder photos are generated locally with sharp (no network required) and
 * written to public/img/seed/, so they are stable, offline and not subject to
 * the 24h uploads purge.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { pool, query, execute } from '../server/src/db/pool.js';
import { env, ROOT_DIR } from '../server/src/config/env.js';

const PASSWORD = 'Password123!';
const SEED_IMG_DIR = path.join(ROOT_DIR, 'public', 'img', 'seed');

const PALETTES = [
  ['#7B35A8', '#B03A93'],
  ['#21A2FF', '#7B61FF'],
  ['#21D07A', '#12B6A0'],
  ['#FFB800', '#B03A93'],
  ['#9B5CFF', '#7B35A8'],
  ['#B03A93', '#FFB800'],
  ['#12B6A0', '#21A2FF'],
  ['#FE3C72', '#9B5CFF'],
  ['#5B6CFF', '#21D07A'],
  ['#FF8A5B', '#7B35A8'],
  ['#00C2A8', '#5B6CFF'],
  ['#FF4D8D', '#FFB800']
];

const USERS = [
  { email: 'amara@example.com', username: 'amara',  name: 'Amara',   gender: 'female', interested: 'male',     city: 'Port Harcourt', birth: '1997-04-12', lat: 4.8156, lng: 7.0498, intent: 'long_term', job: 'Data analyst', school: 'Uniport', height: 165, verified: 1, interests: ['hiking','cooking','table-tennis','afrobeats','travel'], bio: 'Jollof purist, weekend hiker, and I will absolutely beat you at table tennis.' },
  { email: 'tunde@example.com', username: 'tunde_a',  name: 'Tunde',   gender: 'male',   interested: 'female',   city: 'Lagos',         birth: '1994-09-03', lat: 6.5244, lng: 3.3792, intent: 'long_term', job: 'Architect', school: 'UNILAG', height: 182, verified: 1, interests: ['drumming','plants','architecture','afrobeats','cooking'], bio: 'Architect by day, amateur drummer by night. Ask me about my plant collection.' },
  { email: 'zainab@example.com', username: 'zainab.k', name: 'Zainab',  gender: 'female', interested: 'everyone', city: 'Abuja',         birth: '1996-01-27', lat: 9.0765, lng: 7.3986, intent: 'figuring_out', job: 'Curator', school: 'ABU Zaria', height: 170, verified: 0, interests: ['art','coffee','music','travel','photography'], bio: 'Runs on espresso and long playlists. Looking for someone to explore galleries with.' },
  { email: 'chidi@example.com', username: 'chidi_dev',  name: 'Chidi',   gender: 'male',   interested: 'female',   city: 'Enugu',         birth: '1993-06-18', lat: 6.4584, lng: 7.5464, intent: 'long_term', job: 'Backend engineer', school: 'UNN', height: 178, verified: 1, interests: ['cooking','dogs','gaming','football','tech'], bio: 'Backend engineer. I make an unreasonably good egusi. Dog person, obviously.' },
  { email: 'ngozi@example.com', username: 'ngozi',  name: 'Ngozi',   gender: 'female', interested: 'male',     city: 'Port Harcourt', birth: '1998-11-05', lat: 4.8242, lng: 7.0336, intent: 'long_term', job: 'Pharmacist', school: 'Uniport', height: 168, verified: 1, interests: ['running','karaoke','fitness','cooking','travel'], bio: 'Pharmacist, marathon-in-training, terrible at karaoke but I do it anyway.' },
  { email: 'kelechi@example.com', username: 'kelechi.shoots',name: 'Kelechi', gender: 'male',   interested: 'everyone', city: 'Port Harcourt', birth: '1995-02-14', lat: 4.8098, lng: 7.0421, intent: 'short_term', job: 'Photographer', school: null, height: 175, verified: 1, interests: ['photography','art','travel','music','hiking'], bio: 'Photographer chasing golden hour. Will take a great picture of you, promise.' },
  { email: 'aisha@example.com', username: 'aisha_o',  name: 'Aisha',   gender: 'female', interested: 'male',     city: 'Kano',          birth: '1999-07-22', lat: 12.0022, lng: 8.5920, intent: 'figuring_out', job: 'Medical student', school: 'Bayero University', height: 162, verified: 0, interests: ['vinyl','seafood','music','reading','coffee'], bio: 'Med student. Sea food enthusiast. I collect vinyl I cannot afford.' },
  { email: 'emeka@example.com', username: 'emeka',  name: 'Emeka',   gender: 'male',   interested: 'female',   city: 'Owerri',        birth: '1992-12-30', lat: 5.4836, lng: 7.0333, intent: 'long_term', job: 'Sales lead', school: 'FUTO', height: 180, verified: 0, interests: ['football','afrobeats','music','fitness','gaming'], bio: 'Football on Saturdays, Afrobeats always. Looking for a co-conspirator.' },
  { email: 'funmi@example.com', username: 'funmi.design',  name: 'Funmi',   gender: 'female', interested: 'everyone', city: 'Ibadan',        birth: '1997-08-09', lat: 7.3775, lng: 3.9470, intent: 'short_term', job: 'Product designer', school: 'OAU', height: 167, verified: 1, interests: ['art','film','design','coffee','photography'], bio: 'Product designer. I notice your font choices. Let us get suya and argue about films.' },
  { email: 'ibrahim@example.com', username: 'ibrahim_b',name: 'Ibrahim', gender: 'male',   interested: 'female',   city: 'Kaduna',        birth: '1991-03-16', lat: 10.5222, lng: 7.4383, intent: 'long_term', job: 'Civil engineer', school: 'ABU Zaria', height: 185, verified: 0, interests: ['chess','karaoke','football','reading','travel'], bio: 'Civil engineer, chess club regular, and a genuinely dangerous karaoke partner.' },
  { email: 'blessing@example.com', username: 'blessing.bakes',name:'Blessing',gender: 'female', interested: 'male',     city: 'Port Harcourt', birth: '1996-10-01', lat: 4.7935, lng: 7.0122, intent: 'long_term', job: 'Teacher', school: 'Uniport', height: 163, verified: 1, interests: ['baking','cooking','reading','dogs','music'], bio: 'Teacher. I bake when I am stressed, so my neighbours eat very well.' },
  { email: 'seyi@example.com', username: 'djseyi',   name: 'Seyi',    gender: 'other',  interested: 'everyone', city: 'Lagos',         birth: '1998-05-24', lat: 6.4550, lng: 3.4246, intent: 'friends', job: 'DJ / barista', school: null, height: 172, verified: 0, interests: ['music','vinyl','coffee','afrobeats','film'], bio: 'DJ and part-time barista. Send me your favourite song, I will judge it kindly.' }
];

/** Interest vocabulary. Slugs are stable; labels are display copy. */
const INTERESTS = [
  ['hiking', 'Hiking', '\u{1F97E}', 'active'],
  ['running', 'Running', '\u{1F3C3}', 'active'],
  ['fitness', 'Gym & fitness', '\u{1F4AA}', 'active'],
  ['football', 'Football', '\u26BD', 'active'],
  ['table-tennis', 'Table tennis', '\u{1F3D3}', 'active'],
  ['chess', 'Chess', '\u265F\uFE0F', 'games'],
  ['gaming', 'Gaming', '\u{1F3AE}', 'games'],
  ['cooking', 'Cooking', '\u{1F373}', 'food'],
  ['baking', 'Baking', '\u{1F9C1}', 'food'],
  ['coffee', 'Coffee', '\u2615', 'food'],
  ['seafood', 'Seafood', '\u{1F990}', 'food'],
  ['afrobeats', 'Afrobeats', '\u{1F3B6}', 'music'],
  ['music', 'Live music', '\u{1F3A4}', 'music'],
  ['vinyl', 'Vinyl records', '\u{1F4BF}', 'music'],
  ['drumming', 'Drumming', '\u{1F941}', 'music'],
  ['art', 'Art & galleries', '\u{1F3A8}', 'culture'],
  ['film', 'Film', '\u{1F3AC}', 'culture'],
  ['reading', 'Reading', '\u{1F4DA}', 'culture'],
  ['photography', 'Photography', '\u{1F4F7}', 'culture'],
  ['design', 'Design', '\u{1F58A}\uFE0F', 'culture'],
  ['architecture', 'Architecture', '\u{1F3DB}\uFE0F', 'culture'],
  ['travel', 'Travel', '\u2708\uFE0F', 'lifestyle'],
  ['plants', 'Plants', '\u{1FAB4}', 'lifestyle'],
  ['dogs', 'Dogs', '\u{1F415}', 'lifestyle'],
  ['karaoke', 'Karaoke', '\u{1F3A4}', 'nightlife'],
  ['tech', 'Tech', '\u{1F4BB}', 'lifestyle']
];

/** A few filled-in prompt answers so profiles do not look empty. */
const PROMPT_ANSWERS = {
  amara: [['perfect_sunday', 'Long walk, jollof at my mum\u2019s, then absolutely nothing.'],
          ['cook_best', 'Jollof. I will not be taking questions.']],
  tunde_a: [['irrationally_love', 'Correct kerning and terrible puns.'],
            ['first_round', 'you can name three Fela albums.']],
  'zainab.k': [['travel_next', 'Zanzibar, and I already have the playlist ready.']],
  chidi_dev: [['cook_best', 'Egusi. My flatmates have become dependent on it.'],
              ['green_flag', 'Someone who is kind to waiters.']],
  ngozi: [['weekend_plan', 'Running at 6am, regretting it by 7am.'],
          ['make_me_laugh', 'Bad impressions. The worse the better.']],
  'kelechi.shoots': [['perfect_sunday', 'Golden hour somewhere I have never been.']],
  'funmi.design': [['irrationally_love', 'Arguing about film endings.']],
  'blessing.bakes': [['first_round', 'you let me test a new recipe on you.']]
};

/** Deterministic gradient portrait placeholder. */
async function makePhoto(name, index, variant, outPath) {
  const [from, to] = PALETTES[index % PALETTES.length];
  const initial = name.trim().charAt(0).toUpperCase();
  const angle = variant * 37;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${angle} 0.5 0.5)">
        <stop offset="0%" stop-color="${from}"/>
        <stop offset="100%" stop-color="${to}"/>
      </linearGradient>
      <radialGradient id="v" cx="50%" cy="35%" r="75%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.22"/>
      </radialGradient>
    </defs>
    <rect width="800" height="1100" fill="url(#g)"/>
    <circle cx="${180 + variant * 90}" cy="${240 + variant * 60}" r="${150 + variant * 20}" fill="#ffffff" opacity="0.10"/>
    <circle cx="${640 - variant * 70}" cy="${820 - variant * 40}" r="${190 - variant * 15}" fill="#ffffff" opacity="0.08"/>
    <rect width="800" height="1100" fill="url(#v)"/>
    <text x="400" y="600" text-anchor="middle" font-family="Inter, Poppins, Helvetica, Arial, sans-serif"
          font-size="300" font-weight="700" fill="#ffffff" opacity="0.92">${initial}</text>
    <text x="400" y="690" text-anchor="middle" font-family="Inter, Poppins, Helvetica, Arial, sans-serif"
          font-size="46" font-weight="500" fill="#ffffff" opacity="0.75">${name}</text>
  </svg>`;

  await sharp(Buffer.from(svg)).jpeg({ quality: 82, mozjpeg: true }).toFile(outPath);
}

async function ensureDirs() {
  await fs.mkdir(SEED_IMG_DIR, { recursive: true });
  await fs.mkdir(env.UPLOAD_DIR, { recursive: true });
  await fs.mkdir(path.join(env.UPLOAD_DIR, 'thumbs'), { recursive: true });
}

async function clearData() {
  const tables = [
    'message_locations', 'profile_prompts', 'user_interests', 'interests',
    'encounters', 'profile_views', 'favorites', 'taps', 'boosts', 'verifications',
    'user_locations', 'user_settings',
    'reports', 'blocks', 'call_logs', 'attachments', 'messages',
    'conversations', 'matches', 'swipes', 'user_photos', 'refresh_tokens', 'users'
  ];
  await execute('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) {
    await execute(`TRUNCATE TABLE \`${t}\``);
  }
  await execute('SET FOREIGN_KEY_CHECKS = 1');
}

function ttlExpiry(hoursAgoCreated = 0) {
  const created = new Date(Date.now() - hoursAgoCreated * 3600_000);
  const expires = new Date(created.getTime() + env.MESSAGE_TTL_HOURS * 3600_000);
  return { created, expires };
}

/** MySQL DATETIME string in UTC. */
function dt(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function main() {
  console.log('[seed] starting');
  await ensureDirs();
  await clearData();

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const ids = [];

  for (let i = 0; i < USERS.length; i += 1) {
    const u = USERS[i];
    const photoCount = 3;
    const urls = [];
    for (let v = 0; v < photoCount; v += 1) {
      const file = `${u.name.toLowerCase()}-${v + 1}.jpg`;
      await makePhoto(u.name, i, v, path.join(SEED_IMG_DIR, file));
      urls.push(`/img/seed/${file}`);
    }

    const res = await execute(
      `INSERT INTO users
        (email, username, password_hash, display_name, birthdate, gender, interested_in, bio, city,
         avatar_url, is_online, last_seen_at, intent, job_title, school, height_cm, is_verified, verified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        u.email, u.username, passwordHash, u.name, u.birth, u.gender, u.interested,
        u.bio, u.city, urls[0], i % 3 === 0 ? 1 : 0,
        dt(new Date(Date.now() - (i % 5) * 600_000)),
        u.intent, u.job, u.school, u.height, u.verified,
        u.verified ? dt(new Date(Date.now() - 86400_000)) : null
      ]
    );
    const userId = res.insertId;
    ids.push(userId);

    for (let p = 0; p < urls.length; p += 1) {
      await execute('INSERT INTO user_photos (user_id, url, position) VALUES (?,?,?)', [userId, urls[p], p]);
    }
    console.log(`[seed] user ${u.email} @${u.username} -> id ${userId} (${urls.length} photos)`);
  }

  // ---- interests catalogue ----------------------------------------------
  for (const [slug, label, emoji, category] of INTERESTS) {
    await execute('INSERT INTO interests (slug, label, emoji, category) VALUES (?,?,?,?)',
      [slug, label, emoji, category]);
  }
  const interestIdBySlug = new Map(
    (await query('SELECT id, slug FROM interests')).map((r) => [r.slug, Number(r.id)])
  );

  // ---- per-user settings, location, interests, prompts --------------------
  for (let i = 0; i < USERS.length; i += 1) {
    const u = USERS[i];
    const userId = ids[i];

    // Half precise, half approximate, so both privacy paths are represented.
    const mode = i % 2 === 0 ? 'precise' : 'approximate';
    await execute(
      `INSERT INTO user_settings (user_id, location_mode, max_distance_km, min_age, max_age)
       VALUES (?,?,?,?,?)`,
      [userId, mode, 150, 18, 60]
    );

    // Approximate users get their point snapped exactly as the app would.
    const lat = mode === 'approximate' ? Math.round(u.lat / 0.01) * 0.01 : u.lat;
    const lng = mode === 'approximate' ? Math.round(u.lng / 0.01) * 0.01 : u.lng;
    const cell = `${(Math.floor(lat / 0.1) * 0.1).toFixed(2)},${(Math.floor(lng / 0.1) * 0.1).toFixed(2)}`;
    await execute(
      `INSERT INTO user_locations (user_id, lat, lng, accuracy_m, geohash, city, source, updated_at)
       VALUES (?,?,?,?,?,?,'gps',?)`,
      [
        userId, lat.toFixed(6), lng.toFixed(6), mode === 'precise' ? 25 : null, cell, u.city,
        dt(new Date(Date.now() - (i % 6) * 3600_000))
      ]
    );

    for (const slug of u.interests) {
      const interestId = interestIdBySlug.get(slug);
      if (interestId) {
        await execute('INSERT IGNORE INTO user_interests (user_id, interest_id) VALUES (?,?)',
          [userId, interestId]);
      }
    }

    const answers = PROMPT_ANSWERS[u.username] || [];
    for (let a = 0; a < answers.length; a += 1) {
      await execute(
        'INSERT INTO profile_prompts (user_id, prompt_key, answer, position) VALUES (?,?,?,?)',
        [userId, answers[a][0], answers[a][1], a]
      );
    }

    if (u.verified) {
      await execute(
        `INSERT INTO verifications (user_id, gesture, file_path, status, reviewed_at, note)
         VALUES (?,?,?,'approved',NOW(),'Seed data')`,
        [userId, 'peace_left', 'seed/verified.jpg']
      );
    }
  }
  console.log('[seed] settings, locations, interests and prompts written');

  // ---- swipes + matches -------------------------------------------------
  // Amara (0) <-> Tunde (1) and Ngozi (4) <-> Kelechi (5) are mutual likes.
  const mutualPairs = [
    [ids[0], ids[1]], // amara <-> tunde    -> conversation 1
    [ids[4], ids[5]], // ngozi <-> kelechi  -> conversation 2
    [ids[0], ids[5]]  // amara <-> kelechi  -> conversation 3 (used by the test suites)
  ];
  // one-sided likes so demo accounts see "they already liked you" instant matches
  const oneSided = [
    [ids[2], ids[0]],
    [ids[3], ids[0]],
    [ids[6], ids[1]],
    [ids[8], ids[1]],
    [ids[11], ids[4]]
  ];

  for (const [a, b] of mutualPairs) {
    await execute('INSERT INTO swipes (swiper_id, swipee_id, direction) VALUES (?,?,?)', [a, b, 'like']);
    await execute('INSERT INTO swipes (swiper_id, swipee_id, direction) VALUES (?,?,?)', [b, a, 'like']);
  }
  for (const [a, b] of oneSided) {
    await execute('INSERT INTO swipes (swiper_id, swipee_id, direction) VALUES (?,?,?)', [a, b, 'like']);
  }

  const conversationIds = [];
  for (const [a, b] of mutualPairs) {
    const userA = Math.min(a, b);
    const userB = Math.max(a, b);
    const m = await execute('INSERT INTO matches (user_a_id, user_b_id) VALUES (?,?)', [userA, userB]);
    const c = await execute('INSERT INTO conversations (match_id) VALUES (?)', [m.insertId]);
    conversationIds.push({ conversationId: c.insertId, a: userA, b: userB });
    console.log(`[seed] match ${userA}<->${userB} conversation ${c.insertId}`);
  }

  // ---- demo messages (still inside the TTL window) ----------------------
  const script = [
    { fromA: true,  body: "Hey! Your hiking photos are unreal. Which trail was that?", hoursAgo: 3.5 },
    { fromA: false, body: 'Ha, thank you! That was the Obudu ranch trail. Brutal but worth it.', hoursAgo: 3.2 },
    { fromA: true,  body: 'Adding it to the list. Are you free this weekend?', hoursAgo: 1.1 },
    { fromA: false, body: 'Saturday works. Coffee first, then we plan something ambitious 😄', hoursAgo: 0.4 }
  ];

  for (const conv of conversationIds) {
    let last = null;
    for (const line of script) {
      const { created, expires } = ttlExpiry(line.hoursAgo);
      await execute(
        `INSERT INTO messages (conversation_id, sender_id, body, type, client_uuid, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          conv.conversationId,
          line.fromA ? conv.a : conv.b,
          line.body,
          'text',
          crypto.randomUUID(),
          dt(created),
          dt(expires)
        ]
      );
      last = created;
    }
    await execute('UPDATE conversations SET last_message_at = ? WHERE id = ?', [dt(last), conv.conversationId]);
  }

  // A message that is already expired: proves read-filtering hides it instantly.
  const firstConv = conversationIds[0];
  const expiredCreated = new Date(Date.now() - 26 * 3600_000);
  await execute(
    `INSERT INTO messages (conversation_id, sender_id, body, type, client_uuid, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      firstConv.conversationId,
      firstConv.a,
      'THIS MESSAGE IS EXPIRED AND MUST NEVER BE VISIBLE',
      'text',
      crypto.randomUUID(),
      dt(expiredCreated),
      dt(new Date(expiredCreated.getTime() + env.MESSAGE_TTL_HOURS * 3600_000))
    ]
  );

  // ---- social signals: visitors, favourites, taps, encounters, boost -----
  // Amara (ids[0]) is the demo account, so give her something to look at in
  // every new surface.
  const amara = ids[0];
  const visits = [
    [ids[2], amara, 'nearby', 3],
    [ids[3], amara, 'search', 1],
    [ids[7], amara, 'deck', 2],
    [ids[10], amara, 'nearby', 1],
    [ids[5], amara, 'bumped', 4]
  ];
  for (const [viewer, viewed, source, count] of visits) {
    await execute(
      `INSERT INTO profile_views (viewer_id, viewed_id, source, view_count, first_at, last_at)
       VALUES (?,?,?,?,?,?)`,
      [
        viewer, viewed, source, count,
        dt(new Date(Date.now() - 5 * 86400_000)),
        dt(new Date(Date.now() - Math.random() * 2 * 86400_000))
      ]
    );
  }

  const favs = [[amara, ids[5]], [amara, ids[3]], [ids[4], amara], [ids[8], amara]];
  for (const [owner, target] of favs) {
    await execute('INSERT IGNORE INTO favorites (owner_id, target_id) VALUES (?,?)', [owner, target]);
  }

  const tapRows = [[ids[7], amara, 'wave'], [ids[9], amara, 'crush'], [ids[2], amara, 'fire']];
  for (const [sender, target, kind] of tapRows) {
    await execute('INSERT IGNORE INTO taps (sender_id, target_id, kind) VALUES (?,?,?)',
      [sender, target, kind]);
  }

  // "Bumped into": the other Port Harcourt accounts crossed paths with Amara.
  const bumps = [[amara, ids[4], 120, 3], [amara, ids[10], 240, 1], [amara, ids[5], 80, 5]];
  for (const [a, b, metres, times] of bumps) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    await execute(
      `INSERT INTO encounters (user_a_id, user_b_id, met_on, distance_m, times_met, last_met_at, place_label)
       VALUES (?,?,CURDATE(),?,?,?,?)`,
      [lo, hi, metres, times, dt(new Date(Date.now() - times * 3600_000)), 'Near GRA Phase 2']
    );
  }

  // One active boost so the boost UI has a live state to render.
  await execute(
    'INSERT INTO boosts (user_id, expires_at, views_gained, likes_gained) VALUES (?, DATE_ADD(NOW(), INTERVAL 18 MINUTE), ?, ?)',
    [ids[5], 34, 6]
  );
  console.log('[seed] visitors, favourites, taps, encounters and a boost written');

  const [{ total }] = await query('SELECT COUNT(*) AS total FROM users');
  console.log(`\n[seed] done. ${total} users.`);
  console.log('[seed] demo logins (password: Password123!):');
  console.log('       amara@example.com   <- matched with tunde@example.com (has a live chat)');
  console.log('       tunde@example.com');
  console.log('       ngozi@example.com   <- matched with kelechi@example.com');
  console.log('       kelechi@example.com <- also matched with amara (conversation 3)');
  console.log('       + zainab, chidi, aisha, emeka, funmi, ibrahim, blessing, seyi @example.com');
  await pool.end();
}

main().catch(async (err) => {
  console.error('[seed] error:', err);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
