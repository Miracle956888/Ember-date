#!/usr/bin/env node
/**
 * route-sweep.mjs - walk a RUNNING deployment and prove it really serves.
 *
 *   node scripts/route-sweep.mjs --base https://ember.example.com [--auth] [--demo]
 *
 * Why a sweep instead of a curl of the homepage: the failure mode of a first
 * deployment is never "the index is blank". It is one page 500ing because a route
 * was not registered, a stylesheet that 404s because public/css was not built in
 * the image, a font path that resolves locally but not under the container's WORKDIR,
 * or an API returning HTML instead of JSON so the client dies on res.json(). Those
 * are invisible until something is actually deployed and poked.
 *
 * Every local asset referenced by every page is fetched too, so a broken path in
 * any one of the 15 pages fails the run rather than surfacing as a missing icon.
 *
 *   --base <url>   target, default http://localhost:3000
 *   --auth         also exercise login, the auth wall, CSRF and the 404 contract
 *   --demo         the app is expected to hold seeded demo data (login + profile)
 *
 * Exits 1 if anything fails. Reads nothing from disk except this file.
 */

const argv = process.argv.slice(2);
const arg = (name, fb) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fb : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const BASE = (arg('base', 'http://localhost:3000') || '').replace(/\/+$/, '');
const WANT_AUTH = flag('auth');
const WANT_DEMO = flag('demo');
const DEMO_EMAIL = 'amara@example.com';
const DEMO_PASSWORD = 'Password123!';

const PAGES = [
  'index', 'login', 'register', 'app', 'matches', 'chats', 'chat', 'call',
  'profile', 'nearby', 'likes', 'settings', 'u', 'moments', 'admin'
];
const API_PREFIXES = [
  '/api/users', '/api/swipes', '/api/matches', '/api/conversations', '/api/uploads',
  '/api/discovery', '/api/likes', '/api/notifications', '/api/devices', '/api/moments',
  '/api/posts', '/api/comments', '/api/reports', '/api/admin'
];

let ok = 0;
let bad = 0;
const failures = [];
const PALETTE = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !process.env.CI;
const C = (n) => (PALETTE ? `\x1b[${n}m` : '');
const R = PALETTE ? '\x1b[0m' : '';
const pass = (m) => { ok += 1; console.log(`  ${C(32)}ok${R}   ${m}`); };
const fail = (m, d) => {
  bad += 1;
  failures.push(d ? `${m} - ${d}` : m);
  console.log(`  ${C(31)}FAIL${R} ${m}${d ? `\n         ${d}` : ''}`);
};
const check = (cond, m, d) => (cond ? pass(m) : fail(m, d));
const section = (t) => console.log(`\n${C(1)}${t}${R}`);

if (!/^https?:\/\//.test(BASE)) {
  console.error(`route-sweep: --base must be an http(s) URL, got "${BASE}"`);
  process.exit(2);
}

const timeoutMs = Number(arg('timeout', '15000'));
async function get(pathname, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + pathname, {
      redirect: 'manual',
      signal: ctrl.signal,
      ...opts
    });
    const body = await res.text().catch(() => '');
    return {
      status: res.status,
      body,
      headers: res.headers,
      type: res.headers.get('content-type') || '',
      location: res.headers.get('location') || ''
    };
  } catch (err) {
    return { status: 0, body: '', headers: new Headers(), type: '', location: '', error: `${err.name}: ${err.message}` };
  } finally {
    clearTimeout(t);
  }
}

console.log(`\n${C(1)}route sweep${R}  ${BASE}`);

// ---------------------------------------------------------------- reachable
section('reachability');
const health = await get('/api/health');
if (health.status === 0) {
  fail(`cannot reach ${BASE}`, health.error || 'no response - is the server running and is the port published?');
  console.log('\nroute-sweep: target unreachable, aborting\n');
  process.exit(1);
}
let healthJson = null;
try {
  healthJson = JSON.parse(health.body);
} catch {
  /* reported below */
}
check(health.status === 200, `GET /api/health -> ${health.status}`);
check(healthJson?.status === 'ok', `health says ok (ttl ${healthJson?.ttlHours}h, uptime ${healthJson?.uptimeSecs}s)`, health.body.slice(0, 160));

const root = await get('/');
check(root.status === 200, `GET / -> ${root.status}`);
check(/<!DOCTYPE html/i.test(root.body), 'the root document is HTML');
const isHttps = BASE.startsWith('https:');

// ---------------------------------------------------------------- all pages
section('every page, every route');
for (const page of PAGES) {
  const path = page === 'index' ? '/' : `/${page}`;
  const res = await get(path);
  const html = /<!DOCTYPE html/i.test(res.body);
  // 200 for the page shell is the contract; auth redirects happen client-side
  // (app-shell.js bounces to /login when /api/auth/me 401s), and 500 here means a
  // template or a server-side include is broken, which is a deploy problem.
  check(res.status === 200 && html, `${path} -> 200 html`, `got ${res.status} ${res.type || res.error || ''} ${res.body.slice(0, 80)}`);
}
const shareable = await get('/@amara');
check(shareable.status === 200 && /<!DOCTYPE html/i.test(shareable.body), `/@username renders the public profile shell (got ${shareable.status})`);
const bogusHandle = await get('/@not-a-handle!');
check(bogusHandle.status === 404, `an invalid handle shape falls through to 404 (got ${bogusHandle.status})`);

// ---------------------------------------------------------------- assets
section('assets referenced by those pages');
const refs = new Set();
for (const page of PAGES) {
  const path = page === 'index' ? '/' : `/${page}`;
  const res = await get(path);
  if (res.status !== 200) continue;
  for (const m of res.body.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = m[1];
    if (!url || url.startsWith('http') || url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('data:')) continue;
    if (!url.startsWith('/')) continue; // relative to the page - skip, ambiguity is not worth a false alarm
    if (/\.(css|js|mjs|woff2?|png|jpe?g|webp|gif|svg|ico|webmanifest)$/.test(url.split('?')[0])) refs.add(url.split('?')[0]);
  }
}
const list = [...refs].sort();
check(list.length > 5, `${list.length} distinct local assets referenced across the 15 pages`);
let broken = 0;
const brokenList = [];
for (const url of list) {
  const res = await get(url);
  if (res.status !== 200) {
    broken += 1;
    brokenList.push(`${url} -> ${res.status || 'unreachable'}`);
  }
}
check(broken === 0, `every referenced asset returns 200 (${list.length - broken}/${list.length})`, brokenList.slice(0, 8).join(', '));

const css = await get('/css/app.css');
check(css.status === 200 && css.body.length > 5000, `/css/app.css is built and served (${css.body.length} bytes)`, 'run `npm run build:css` - the image build does this in stage 1; an empty or missing file means unstyled pages');
const font = await get('/fonts/inter-var.woff2');
check(font.status === 200 && (font.type.includes('font') || font.type === 'application/octet-stream' || font.body.length > 10000), `self-hosted font served (${font.body.length} bytes, ${font.type || 'n/a'})`);

// ---------------------------------------------------------------- hardening
section('response hardening');
const headers = health.headers;
check(headers.get('content-security-policy') !== null, 'CSP header present');
check(headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
check(headers.get('x-powered-by') === null, 'no X-Powered-By leak');
if (isHttps) {
  check(/max-age=\d+/.test(headers.get('strict-transport-security') || ''), `HSTS present over https (${headers.get('strict-transport-security') || 'missing'})`);
} else {
  console.log(`  ${C(90)}skip${R}  HSTS: not applicable on an http target (helmet only sends it in production)`);
}
const noIndexAdmin = await get('/admin');
check(noIndexAdmin.headers.get('content-type')?.includes('text/html'), '/admin serves the page shell (the API is the guarded part)');

// ---------------------------------------------------------------- auth wall
if (WANT_AUTH) {
  section('authentication and authorisation');
  const unauth = await get('/api/auth/me');
  check(unauth.status === 401, `GET /api/auth/me without a session -> 401 (got ${unauth.status})`);
  for (const prefix of API_PREFIXES) {
    const res = await get(`${prefix}/`);
    const guarded = res.status === 401 || res.status === 403 || res.status === 404 || res.status === 405;
    check(guarded, `${prefix} is not world-readable (got ${res.status})`, res.body.slice(0, 100));
  }
  const apiNotFound = await get('/api/definitely-not-a-route');
  check(apiNotFound.status === 404 && apiNotFound.type.includes('json'), `unknown /api/* answers 404 as JSON, not HTML (got ${apiNotFound.status} ${apiNotFound.type})`);
  const pageNotFound = await get('/definitely-not-a-page');
  check(pageNotFound.status === 404 && /<!DOCTYPE html/i.test(pageNotFound.body), 'unknown page falls through to the custom 404 document');

  if (WANT_DEMO) {
    section('a real login + session (seeded demo data)');
    const login = await get('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD })
    });
    let session = null;
    let csrf = null;
    try {
      session = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      csrf = (JSON.parse(login.body).csrfToken) || null;
    } catch {
      /* asserted below */
    }
    check(login.status === 200, `POST /api/auth/login -> ${login.status}`);
    check(Boolean(session && session.includes('ec_at')), 'login sets the httpOnly access cookie');
    check(Boolean(csrf), 'login returns the CSRF token the client must echo');

    if (session) {
      const me = await get('/api/auth/me', { headers: { cookie: session } });
      check(me.status === 200, `authenticated /api/auth/me -> ${me.status}`, me.body.slice(0, 120));
      const deck = await get('/api/users/deck', { headers: { cookie: session } });
      check(deck.status === 200, `authenticated /api/users/deck -> ${deck.status}`, deck.body.slice(0, 120));
      const byName = await get('/api/users/by-username/amara');
      check(byName.status === 200, `public profile lookup works without a session: /api/users/by-username/amara -> ${byName.status}`, byName.body.slice(0, 120));
      check(byName.status === 200 && /"username"/.test(byName.body), 'the public profile payload carries the handle');
      const csrfLess = await get('/api/users/reports', {
        method: 'POST',
        headers: { cookie: session, 'content-type': 'application/json' },
        body: JSON.stringify({ reportedId: 2, reason: 'sweep test' })
      });
      check(csrfLess.status === 403, `session cookie without X-CSRF-Token is rejected (got ${csrfLess.status})`, 'a 201 here means CSRF protection is not applied to this route');
      const adminApi = await get('/api/admin/reports', { headers: { cookie: session } });
      check(adminApi.status === 404, `the moderation surface 404s for a non-moderator rather than 403 (got ${adminApi.status})`, '403 would confirm the endpoint exists to anyone probing');
      const withToken = await get('/api/users/reports', {
        method: 'POST',
        headers: { cookie: session, 'content-type': 'application/json', 'x-csrf-token': csrf || '' },
        body: JSON.stringify({ reportedId: 2, reason: 'sweep test' })
      });
      check(withToken.status === 201 || withToken.status === 200 || withToken.status === 422 || withToken.status === 400,
        `with the CSRF token the same POST is accepted for validation (got ${withToken.status})`, 'a 403 here means the token check cannot see the header');
    }
  }

  section('proxy/TLS assumptions');
  const fwd = await get('/api/health', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' } });
  check(fwd.status === 200, `a proxied request still reaches the app (${fwd.status})`);
  const themeRes = await get('/login', { headers: { cookie: 'ec_theme=dark' } });
  check(/<html lang="en" class="dark">/.test(themeRes.body), 'the no-flash theme paint runs server-side (dark class injected before any JS)');
  const themeLight = await get('/login', { headers: { cookie: 'ec_theme=light' } });
  check(!/class="dark"/.test(themeLight.body), 'and honours light explicitly');
}

// ---------------------------------------------------------------- report
console.log(`\n${bad === 0 ? C(32) : C(31)}route-sweep: ${ok} passed, ${bad} failed${R}  ${BASE}`);
if (bad) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exitCode = 1;
} else {
  console.log('');
}
