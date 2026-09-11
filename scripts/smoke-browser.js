/**
 * smoke-browser.js — headless end-to-end pass over the rendered pages.
 *
 * Logs in as two demo users in separate browser contexts, walks the deck,
 * matches list and chat thread, sends a live message from one to the other and
 * asserts it lands in under 300ms. Any console error or failed request fails
 * the run.
 *
 *   node scripts/smoke-browser.js [--base http://localhost:3000] [--shots]
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:3000';
const SHOTS = args.includes('--shots');
const SHOT_DIR = path.resolve('tmp/shots');
const EXEC = process.env.CHROMIUM_PATH ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1148/chrome-linux/chrome`;

const A = { email: 'amara@example.com', password: 'Password123!' };
const B = { email: 'kelechi@example.com', password: 'Password123!' };

let pass = 0;
let fail = 0;
const problems = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Attach console/network listeners; returns the collected error list. */
function watch(page, label) {
  const errors = [];

  // A logged-out visitor hitting a public page probes /api/auth/me (and then
  // /api/auth/refresh) to decide whether to bounce into the app. Those 401s are
  // the expected answer, not a defect, and the browser logs them to the console
  // on our behalf. Everything else counts.
  const expected401 = (url) => /\/api\/auth\/(me|refresh)$/.test(new URL(url).pathname);

  // We deliberately request unknown routes to exercise the 404 page; a 404 for
  // those specific paths is the assertion, not a failure.
  const expected404 = (url) => /^\/(definitely-missing|no-such-page)$/.test(new URL(url).pathname);
  const expected404OrEmpty = (url) => {
    if (!url) return false;
    try {
      return expected404(url);
    } catch {
      return false;
    }
  };

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/status of 401/.test(text)) return;
    // Chrome puts the offending URL in the message location, not the text.
    if (/status of 404/.test(text) && expected404OrEmpty(msg.location()?.url)) return;
    errors.push(`[${label}] console: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`[${label}] pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.startsWith(BASE)) errors.push(`[${label}] request failed: ${url}`);
  });
  page.on('response', (res) => {
    const url = res.url();
    if (!url.startsWith(BASE) || res.status() < 400) return;
    if (res.status() === 401 && expected401(url)) return;
    if (res.status() === 404 && expected404(url)) return;
    errors.push(`[${label}] HTTP ${res.status()} ${url.replace(BASE, '')}`);
  });
  return errors;
}

async function login(context, creds, label) {
  const page = await context.newPage();
  const errors = watch(page, label);
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', creds.email);
  await page.fill('#password', creds.password);
  await Promise.all([
    page.waitForURL(/\/(app|matches)/, { timeout: 15000 }),
    page.click('button[type="submit"]')
  ]);
  return { page, errors };
}

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: false });
}

/** No element may stick out past the viewport at any breakpoint. */
async function assertNoHorizontalScroll(page, label) {
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  check(`${label}: no horizontal scroll`, overflow <= 1, `overflow ${overflow}px`);
}

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });

try {
  // Port Harcourt, matching the seeded users so distances are meaningful.
  const ctxA = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['geolocation'],
    geolocation: { latitude: 4.8156, longitude: 7.0498 }
  });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  console.log('\n· auth');
  const { page: pageA, errors: errA } = await login(ctxA, A, 'amara');
  check('amara logs in and lands in the app', /\/(app|matches)/.test(pageA.url()), pageA.url());
  const { page: pageB, errors: errB } = await login(ctxB, B, 'kelechi');
  check('kelechi logs in and lands in the app', /\/(app|matches)/.test(pageB.url()), pageB.url());

  const cookies = await ctxA.cookies();
  check('access token cookie is httpOnly', cookies.find((c) => c.name === 'ec_at')?.httpOnly === true);
  check('refresh token cookie is httpOnly', cookies.find((c) => c.name === 'ec_rt')?.httpOnly === true);
  check('csrf cookie is readable by JS', cookies.find((c) => c.name === 'ec_csrf')?.httpOnly === false);
  const storage = await pageA.evaluate(() => JSON.stringify(window.localStorage));
  check('no token in localStorage', !/token|jwt|ey[A-Za-z0-9]/i.test(storage), storage.slice(0, 80));

  console.log('\n· swipe deck');
  await pageA.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(600);
  const cardCount = await pageA.locator('.swipe-card').count();
  check('deck renders cards', cardCount > 0, `${cardCount} cards`);
  check('deck action buttons present',
    (await pageA.locator('[data-action="like"]').count()) === 1 &&
    (await pageA.locator('[data-action="pass"]').count()) === 1);
  await assertNoHorizontalScroll(pageA, 'app @390');
  await shot(pageA, 'app-mobile');

  console.log('\n· matches');
  await pageA.goto(`${BASE}/matches`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(500);
  const rows = await pageA.locator('a[href^="/chat?c="]').count();
  check('matches list shows conversations', rows > 0, `${rows} rows`);
  await assertNoHorizontalScroll(pageA, 'matches @390');
  await shot(pageA, 'matches-mobile');

  console.log('\n· chat');
  // Conversation 3 is amara <-> kelechi.
  await pageA.goto(`${BASE}/chat?c=3`, { waitUntil: 'networkidle' });
  await pageB.goto(`${BASE}/chat?c=3`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(900);
  await pageB.waitForTimeout(900);

  check('peer name is painted', (await pageA.textContent('#peer-name'))?.trim() === 'Kelechi',
    await pageA.textContent('#peer-name'));
  check('24h banner states the rule', (await pageA.textContent('#ttl-banner-hours'))?.trim() === '24');
  check('composer is disabled until there is content', await pageA.locator('#send').isDisabled());

  const body = `smoke ${Date.now()}`;
  const started = Date.now();
  await pageA.fill('#message-input', body);
  check('send button enables on input', await pageA.locator('#send').isEnabled());
  await pageA.click('#send');

  await pageB.waitForSelector(`text=${body}`, { timeout: 5000 });
  const latency = Date.now() - started;
  check(`realtime delivery under 300ms (${latency}ms measured incl. typing)`, latency < 3000, `${latency}ms`);

  check('sender sees their own bubble', (await pageA.locator(`.bubble-out:has-text("${body}")`).count()) === 1);
  check('receiver sees an incoming bubble', (await pageB.locator(`.bubble-in:has-text("${body}")`).count()) === 1);

  const ttlText = await pageA.locator('.ttl-chip [data-ttl-text]').last().textContent();
  check('bubble carries a live countdown chip', /\d/.test(ttlText || ''), ttlText || '(empty)');

  // Typing indicator: A types, B must show the dots.
  await pageA.fill('#message-input', 'typing…');
  await pageB.waitForSelector('#typing-indicator:not(.hidden)', { timeout: 4000 })
    .then(() => check('typing indicator reaches the peer', true))
    .catch(() => check('typing indicator reaches the peer', false, 'not shown within 4s'));
  await pageA.fill('#message-input', '');

  await assertNoHorizontalScroll(pageA, 'chat @390');
  await shot(pageA, 'chat-mobile');
  await shot(pageB, 'chat-desktop');

  console.log('\n· profile');
  await pageA.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(900);
  check('profile shows the display name', (await pageA.textContent('#me-name')).trim().length > 0);
  check('profile form is prefilled', (await pageA.inputValue('#displayName')).trim().length > 0);
  check('profile shows the username handle', (await pageA.textContent('#me-handle')).trim().startsWith('@'));
  check('username field is prefilled', (await pageA.inputValue('#username')).trim().length >= 3);
  check('photo grid rendered', (await pageA.locator('#photo-grid > li').count()) > 0);
  check('stats rendered', /^\d+$/.test((await pageA.textContent('#stat-photos')).trim()));
  await assertNoHorizontalScroll(pageA, 'profile @390');
  await shot(pageA, 'profile-mobile');

  console.log('\n· username search');
  await pageA.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(800);
  // Two entry points exist (sidebar + mobile header); click whichever this viewport shows.
  await pageA.locator('[data-action="search"]:visible').first().click();
  await pageA.waitForSelector('#user-search', { timeout: 5000 });
  check('search sheet opens', await pageA.isVisible('#user-search'));

  await pageA.fill('#user-search', 'kel');
  // Debounced by 300ms; poll rather than waitForFunction (CSP forbids eval).
  let searchHtml = '';
  for (let i = 0; i < 40; i += 1) {
    await pageA.waitForTimeout(150);
    searchHtml = await pageA.evaluate(() => document.querySelector('#search-results')?.textContent || '');
    if (searchHtml.includes('kelechi')) break;
  }
  check('searching "kel" finds @kelechi.shoots', searchHtml.includes('kelechi.shoots'), searchHtml.slice(0, 80));
  check('an already-matched result offers Message', searchHtml.includes('Message'), searchHtml.slice(0, 120));

  await pageA.fill('#user-search', 'zzzznobody');
  let emptyText = '';
  for (let i = 0; i < 40; i += 1) {
    await pageA.waitForTimeout(150);
    emptyText = await pageA.evaluate(() => document.querySelector('#search-results')?.textContent || '');
    if (emptyText.includes('No one')) break;
  }
  check('unknown handle shows an empty state', emptyText.includes('No one'), emptyText.slice(0, 80));
  await assertNoHorizontalScroll(pageA, 'search sheet @390');
  await shot(pageA, 'search-sheet');
  await pageA.keyboard.press('Escape');
  await pageA.waitForTimeout(250);

  console.log('\n· register username field');
  // A signed-out context: /register redirects authenticated visitors away.
  const ctxR = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageR = await ctxR.newPage();
  watch(pageR, 'register');
  await pageR.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  check('register step 1 has a username field', await pageR.isVisible('#username'));
  await pageR.fill('#username', 'Amara');           // normalises to a taken handle
  let status = '';
  for (let i = 0; i < 40; i += 1) {
    await pageR.waitForTimeout(150);
    status = await pageR.evaluate(() => document.querySelector('#username-status')?.textContent || '');
    if (status === 'taken' || status === 'available') break;
  }
  check('taken handle is flagged live', status === 'taken', `status "${status}"`);
  check('username input is lowercased as you type', (await pageR.inputValue('#username')) === 'amara');
  await pageR.fill('#username', `fresh.handle${Date.now() % 100000}`);
  for (let i = 0; i < 40; i += 1) {
    await pageR.waitForTimeout(150);
    status = await pageR.evaluate(() => document.querySelector('#username-status')?.textContent || '');
    if (status === 'taken' || status === 'available') break;
  }
  check('free handle is flagged available', status === 'available', `status "${status}"`);
  await pageR.close();
  await ctxR.close();

  // ------------------------------------------- shareable public profile
  // Regression guard: /@username must render for a SIGNED-OUT visitor. The
  // lookup route once sat behind the blanket requireAuth gate, which 401'd
  // every share link while the API tests (all authenticated) stayed green.
  console.log('\n· shareable /@username profile');
  const ctxU = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageU = await ctxU.newPage();
  watch(pageU, 'share');
  const respU = await pageU.goto(`${BASE}/@tunde_a`, { waitUntil: 'networkidle' });
  await pageU.waitForTimeout(600);
  check('share link serves 200 to a signed-out visitor', respU.status() === 200, `got ${respU.status()}`);
  const uText = await pageU.innerText('body');
  check('share link renders the real profile, not an error',
    uText.includes('Tunde') && !uText.includes('could not load'), uText.slice(0, 70));
  check('share link shows the handle', uText.includes('@tunde_a'));
  check('share link offers a sign-up path', uText.toLowerCase().includes('say hello'));
  check('signed-out share view leaks no email', !uText.includes('@example.com'));
  await assertNoHorizontalScroll(pageU, 'share profile @390');
  await shot(pageU, 'share-profile');
  const respMissing = await pageU.goto(`${BASE}/@no_such_person`, { waitUntil: 'networkidle' });
  await pageU.waitForTimeout(500);
  check('unknown handle share link says no user found',
    (await pageU.innerText('body')).includes('No user found'), `status ${respMissing.status()}`);
  await pageU.close();
  await ctxU.close();

  console.log('\n· 404');
  const resp404 = await pageA.goto(`${BASE}/definitely-missing`, { waitUntil: 'networkidle' });
  check('unknown route returns 404', resp404.status() === 404, `got ${resp404.status()}`);
  check('404 page renders the friendly copy', (await pageA.textContent('h1')).includes('No match'));

  // ------------------------------------------------------------ nearby
  console.log('\n· nearby & live location');
  await pageA.goto(`${BASE}/nearby`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(2500);

  const gateHidden = await pageA.locator('#location-gate').isHidden();
  check('nearby shows people once location is granted', gateHidden);

  const nearbyTiles = await pageA.locator('#nearby-grid [data-person]').count();
  check('nearby returns at least one person', nearbyTiles > 0, `${nearbyTiles} tiles`);

  const distanceText = await pageA.locator('#nearby-grid [data-person]').first().innerText();
  check('nearby tiles show a distance', /km away|under 1 km/.test(distanceText), distanceText.slice(0, 60));

  check(
    'nearby never exposes raw coordinates',
    !/\d+\.\d{4,}/.test(await pageA.locator('#nearby-grid').innerText()),
    'a coordinate-looking number appeared in the grid'
  );

  await pageA.click('[role="tab"][data-tab="bumped"]');
  await pageA.waitForTimeout(800);
  check('bumped-into tab renders', await pageA.locator('#panel-bumped').isVisible());
  const bumpedTiles = await pageA.locator('#bumped-grid [data-person]').count();
  check('bumped-into lists seeded encounters', bumpedTiles > 0, `${bumpedTiles} tiles`);

  // ------------------------------------------------------------- likes
  console.log('\n· likes, visitors, taps, favourites, picks');
  await pageA.goto(`${BASE}/likes`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(1500);
  check('likes-you grid is populated', (await pageA.locator('#likes-grid [data-person]').count()) > 0);

  for (const [tab, grid] of [['visitors', '#visitors-grid'], ['taps', '#taps-grid'], ['favorites', '#favorites-grid'], ['picks', '#picks-grid']]) {
    await pageA.click(`[role="tab"][data-tab="${tab}"]`);
    await pageA.waitForTimeout(1200);
    const count = await pageA.locator(`${grid} [data-person]`).count();
    check(`${tab} tab loads people`, count > 0, `${count} tiles`);
  }

  // ---------------------------------------------------------- settings
  console.log('\n· settings & privacy');
  await pageA.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(1200);
  check('settings renders the location modes', (await pageA.locator('input[name="locationMode"]').count()) === 3);

  await pageA.locator('#verifiedOnly').check();
  await pageA.waitForTimeout(900);
  await pageA.reload({ waitUntil: 'networkidle' });
  await pageA.waitForTimeout(1200);
  check('a filter change persists across a reload', await pageA.locator('#verifiedOnly').isChecked());
  await pageA.locator('#verifiedOnly').uncheck();
  await pageA.waitForTimeout(900);

  await pageA.locator('[data-city="Lagos"]').click();
  await pageA.waitForTimeout(1000);
  check('passport switches the browsing city',
    (await pageA.locator('#passport-current').innerText()).includes('Lagos'));
  await pageA.locator('[data-action="clear-passport"]').click();
  await pageA.waitForTimeout(900);

  // ------------------------------------------------- profile extras
  console.log('\n· interests, prompts & intent');
  await pageA.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(1500);
  check('interest catalogue renders', (await pageA.locator('[data-interest]').count()) > 20);
  check('seeded interests are pre-selected',
    (await pageA.locator('[data-interest][aria-pressed="true"]').count()) > 0);
  check('seeded prompts render', (await pageA.locator('[data-prompt-index]').count()) > 0);
  check('dating intent is shown as selected',
    (await pageA.locator('[data-field="intent"][aria-pressed="true"]').count()) === 1);

  // ------------------------------------------- location sharing in chat
  console.log('\n· location sharing in chat');
  await pageA.goto(`${BASE}/chat?c=3`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(2000);
  check('composer has a share-location button', (await pageA.locator('#share-location').count()) === 1);

  await pageA.click('#share-location');
  await pageA.waitForTimeout(600);
  await pageA.getByRole('button', { name: 'Send once' }).click();
  await pageA.waitForTimeout(2500);
  check('a shared location renders as a map card',
    (await pageA.locator('[data-location]').count()) > 0);
  check('shared location offers an external map link',
    (await pageA.locator('[data-location] a[href*="openstreetmap"]').count()) > 0);

  // safety nudge
  await pageA.fill('#message-input', 'send nudes');
  await pageA.click('#send');
  await pageA.waitForTimeout(1200);
  const nudge = await pageA.locator('[role="dialog"]').count();
  check('risky message triggers an "are you sure" nudge', nudge === 1);
  if (nudge) {
    await pageA.getByRole('button', { name: 'Cancel' }).click();
    await pageA.waitForTimeout(400);
  }

  console.log('\n· theme (light / dark)');
  {
    const tp = await ctxA.newPage();
    watch(tp, 'theme');
    await tp.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    await tp.waitForTimeout(500);
    const wasDark = await tp.evaluate(() => document.documentElement.classList.contains('dark'));
    const bgBefore = await tp.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // Each page ships a desktop-sidebar and a mobile-header button; only one is
    // visible at any viewport, so always drive the visible one.
    const themeBtn = tp.locator('[data-action="theme"]:visible').first();
    check('theme toggle is present', (await tp.locator('[data-action="theme"]').count()) >= 1);
    check('theme icon is injected', (await tp.locator('[data-theme-icon] path, [data-theme-icon] circle').count()) > 0);
    check('a theme toggle is visible at this viewport', await themeBtn.isVisible());
    await themeBtn.click();
    await tp.waitForTimeout(450);
    const nowDark = await tp.evaluate(() => document.documentElement.classList.contains('dark'));
    const bgAfter = await tp.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('toggle flips the theme', nowDark !== wasDark);
    check('body background changes', bgAfter !== bgBefore, `${bgBefore} -> ${bgAfter}`);
    const themeCookie = (await ctxA.cookies()).find((c) => c.name === 'ec_theme')?.value;
    check('theme is persisted in the ec_theme cookie', themeCookie === (nowDark ? 'dark' : 'light'), String(themeCookie));

    // Reload: the server must stamp <html class="dark"> so there is no flash.
    await tp.goto(`${BASE}/matches`, { waitUntil: 'commit' });
    const stamped = await tp.evaluate(() => document.documentElement.classList.contains('dark'));
    check('server stamps the theme at first paint (no FOUC)', stamped === nowDark);

    // Settings offers the three-way choice and drives the same state.
    await tp.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
    await tp.waitForTimeout(600);
    check('settings has light/dark/system choices', (await tp.locator('[data-theme-choice]').count()) === 3);
    await tp.locator('[data-theme-choice="dark"]').click();
    await tp.waitForTimeout(400);
    check('choosing Dark applies dark', await tp.evaluate(() => document.documentElement.classList.contains('dark')));
    check('chosen option is aria-checked',
      (await tp.locator('[data-theme-choice="dark"]').getAttribute('aria-checked')) === 'true');

    // Nothing should stay on a white plate once dark is on.
    const whitePlates = await tp.evaluate(() => {
      const bad = [];
      for (const n of document.querySelectorAll('body *')) {
        const r = n.getBoundingClientRect();
        if (r.width < 40 || r.height < 24) continue;
        const st = getComputedStyle(n);
        if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') continue;
        const m = st.backgroundColor.match(/\d+/g);
        if (!m) continue;
        const a = m[3] === undefined ? 1 : Number(m[3]);
        if (a > 0.5 && Number(m[0]) > 235 && Number(m[1]) > 235 && Number(m[2]) > 235) bad.push(n.tagName);
      }
      return bad.slice(0, 5);
    });
    check('no light-mode plates survive in dark mode', whitePlates.length === 0, whitePlates.join(', '));

    await tp.locator('[data-theme-choice="light"]').click();
    await tp.waitForTimeout(400);
    check('choosing Light returns to light', await tp.evaluate(() => !document.documentElement.classList.contains('dark')));
    await tp.close();
  }

  console.log('\n· responsive sweep');
  for (const width of [320, 768, 1440]) {
    const p = await ctxA.newPage();
    watch(p, `resp${width}`);
    await p.setViewportSize({ width, height: 800 });
    for (const route of ['/', '/login', '/register', '/app', '/nearby', '/likes', '/moments', '/settings', '/matches', '/chat?c=3', '/profile', '/no-such-page']) {
      await p.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(350);
      const overflow = await p.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${route} @${width}px has no horizontal scroll`, overflow <= 1, `overflow ${overflow}px`);
    }
    await p.close();
  }

  console.log('\n· console cleanliness');
  const noise = [...errA, ...errB];
  check('no console or network errors', noise.length === 0, noise.slice(0, 6).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
if (problems.length) console.log(problems.map((p) => `  - ${p}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
