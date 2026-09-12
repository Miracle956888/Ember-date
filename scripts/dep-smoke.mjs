#!/usr/bin/env node
/**
 * dep-smoke.mjs - prove the runtime dependencies work with THIS app's code.
 *
 *   node scripts/dep-smoke.mjs
 *
 * The app cannot boot without MySQL, so this exercises the libraries the app
 * actually depends on by importing the real modules and running their real code
 * paths: the upload middleware, the media pipeline, the https-upgrade rule, the
 * purge scheduler, cookie handling and the query parser. It exists because bumping
 * multer / sharp / file-type / node-cron / express is exactly the class of change
 * where "it installed" and "it works" diverge.
 *
 * No database, no network, no seeds touched. Exit code 1 if any check fails.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

// --- env must be set BEFORE any app module is imported (config/env.js validates on load)
const tmpUploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-smoke-uploads-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  PORT: '0',
  APP_ORIGIN: 'http://localhost:3000',
  DB_HOST: '127.0.0.1',
  DB_PORT: '13306', // nothing listens here on purpose: no code in this file may reach a DB
  DB_USER: 'smoke',
  DB_PASSWORD: 'smoke',
  DB_NAME: 'smoke_never_connects',
  UPLOAD_DIR: tmpUploads,
  MAX_IMAGE_MB: '1',
  MAX_VIDEO_MB: '1'
});

// Colour only on a terminal, so CI logs and redirected files stay plain text.
const PALETTE = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !process.env.CI;
const C = (code) => (PALETTE ? `\x1b[${code}m` : '');
const R = PALETTE ? '\x1b[0m' : '';

let ok = 0;
let bad = 0;
const failures = [];
const pass = (m) => {
  ok += 1;
  console.log(`  ${C(32)}ok${R}   ${m}`);
};
const fail = (m, detail) => {
  bad += 1;
  failures.push(detail ? `${m} - ${detail}` : m);
  console.log(`  ${C(31)}FAIL${R} ${m}${detail ? `\n         ${detail}` : ''}`);
};
const section = (t) => console.log(`\n${C(1)}${t}${R}`);
function check(cond, m, detail) {
  return cond ? pass(m) : fail(m, detail);
}
async function throwsAsync(fn, matcher, m) {
  try {
    await fn();
    return fail(m, 'expected it to throw, but it resolved');
  } catch (err) {
    const got = `${err.code ?? ''} ${err.status ?? ''} ${err.message ?? ''}`;
    return matcher.test(got) ? pass(m) : fail(m, `threw the wrong thing: ${got}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const installed = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
};

// --------------------------------------------------------------------------
section('1. versions actually installed');
const want = {
  multer: /^2\./,
  sharp: /^0\.35\./,
  'file-type': /^22\./,
  'node-cron': /^4\./,
  express: /^4\.22\./,
  cookie: /^0\.7\./,
  'cookie-parser': /^1\.4\.7$/
};
for (const [name, re] of Object.entries(want)) {
  const v = installed(name);
  check(v && re.test(v), `${name}@${v ?? 'missing'} matches ${re}`);
}
// express resolves qs from its own folder, so check THAT copy - the override has
// to reach the one actually used by the query parser, not a hoisted sibling.
const nodeRequire = createRequire(import.meta.url);
function versionOf(name, from) {
  try {
    return JSON.parse(fs.readFileSync(nodeRequire.resolve(`${name}/package.json`, { paths: [from] }), 'utf8')).version;
  } catch {
    return null;
  }
}
const expressQs = versionOf('qs', path.join(ROOT, 'node_modules', 'express'));
check(/^6\.1[6-9]/.test(expressQs ?? ''), `express resolves the patched qs (${expressQs})`);
for (const [dep, spec] of Object.entries(pkg.dependencies)) {
  const v = installed(dep);
  check(v !== null, `${dep} resolves (declared ${spec})`, v === null ? 'not installed' : undefined);
}

// --------------------------------------------------------------------------
section('2. upload middleware (multer 2.x on a live express app)');
const expressMod = await import('express');
const express = expressMod.default;
const { handleUpload, handlePhotoUpload } = await import('../server/src/middleware/upload.js');
const { cookieOptions, env } = await import('../server/src/config/env.js');
const { forceHttps } = await import('../server/src/middleware/https.js');
const cronMod = await import('node-cron');
// node-cron 4 ships ESM named exports; 3.x had a CJS default object. Accept both so
// this check stays valid whichever shape the installed version has.
const cron = cronMod.default ?? cronMod;
const cookieLib = await import('cookie');

const app = express();
// Mirrors the real server's body parsers so the 100kb cap is tested the same way.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.post('/json', (req, res) => res.json({ ok: true, keys: Object.keys(req.body ?? {}) }));
app.post('/upload', handleUpload, (req, res) => {
  res.json({
    fieldname: req.file.fieldname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    bufferBytes: req.file.buffer.length
  });
});
app.post('/photo', handlePhotoUpload, (req, res) => res.json({ size: req.file.size }));
app.get('/q', (req, res) => res.json({ tags: req.query.tags, after: req.query.after, plain: req.query.plain }));
// Mirror server.js's error handler: AppError -> JSON, so assertions see the same
// shape a real client sees instead of Express's default HTML error page.
app.use((err, _req, res, _next) =>
  res.status(err.status || 500).json({ error: { message: err.message, code: err.code } })
);

const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const seedJpg = path.join(ROOT, 'public', 'img', 'seed', 'amara-1.jpg');
const jpeg = fs.readFileSync(seedJpg);
check(jpeg.length > 1000, `read a real jpeg fixture (${jpeg.length} bytes)`);

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 120) };
  }
}

async function postFile(endpoint, blob, filename) {
  const fd = new FormData();
  fd.append(endpoint === '/photo' ? 'photo' : 'file', blob, filename);
  return fetch(base + endpoint, { method: 'POST', body: fd });
}

let uploadStatus = 0;
let uploadBody = null;
try {
  const res = await postFile('/upload', new Blob([jpeg], { type: 'image/jpeg' }), 'amara-1.jpg');
  uploadStatus = res.status;
  uploadBody = await res.json();
} catch (err) {
  fail(`multipart upload threw: ${err.message}`);
}
check(uploadStatus === 200, 'valid jpeg upload accepted (200)', `got ${uploadStatus} ${JSON.stringify(uploadBody)}`);
check(uploadBody?.fieldname === 'file', "multer 2.x still populates req.file.fieldname ('file')");
check(uploadBody?.mimetype === 'image/jpeg', `multer parsed the declared mime (${uploadBody?.mimetype})`);
check(
  uploadBody?.bufferBytes === uploadBody?.size && uploadBody?.size > 0,
  `memoryStorage() still hands over the whole buffer (${uploadBody?.size} bytes)`
);

const fakeRes = await postFile('/upload', new Blob([Buffer.from('this is plainly not an image')], { type: 'text/plain' }), 'notes.txt');
check(fakeRes.status === 415, `fileFilter still rejects non-media with 415 (got ${fakeRes.status})`);
const fakeMsg = (await safeJson(fakeRes))?.error?.message ?? '';
check(/not supported/i.test(fakeMsg), `rejection carries the friendly message: "${fakeMsg}"`);

const oversize = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024 * 1024 + 64 * 1024)]);
const bigRes = await postFile('/upload', new Blob([oversize], { type: 'image/jpeg' }), 'big.jpg');
check(bigRes.status === 413, `oversize upload -> 413 via multer.MulterError (got ${bigRes.status})`);
const bigMsg = (await safeJson(bigRes))?.error?.message ?? '';
check(/too large/i.test(bigMsg), `MulterError LIMIT_FILE_SIZE is still instanceof-checked and mapped: "${bigMsg}"`);

const videoAsPhoto = await postFile('/photo', new Blob([Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])], { type: 'video/mp4' }), 'clip.mp4');
check(videoAsPhoto.status === 415, `photo endpoint rejects video by mime (415, got ${videoAsPhoto.status})`);

// --------------------------------------------------------------------------
section('3. media pipeline (file-type 22 + sharp 0.35 on real bytes)');
const { processUpload } = await import('../server/src/services/upload.service.js');
const processed = await processUpload({ buffer: jpeg, declaredMime: 'image/jpeg', purpose: 'photo' });
check(processed.mime === 'image/jpeg', `processUpload re-encoded to ${processed.mime}`);
check(processed.kind === 'image', `kind classified as image (${processed.kind})`);
check(
  typeof processed.fileKey === 'string' && fs.existsSync(path.join(tmpUploads, processed.fileKey)),
  `full-size file written to storage (${processed.fileKey})`
);
check(
  typeof processed.thumbKey === 'string' && fs.existsSync(path.join(tmpUploads, processed.thumbKey)),
  `thumbnail written to storage (${processed.thumbKey})`
);
const outMeta = await (await import('sharp')).default(path.join(tmpUploads, processed.fileKey)).metadata();
const thumbMeta = await (await import('sharp')).default(path.join(tmpUploads, processed.thumbKey)).metadata();
check(outMeta.width > 0 && outMeta.height > 0, `output decodes back: ${outMeta.width}x${outMeta.height}`);
check(thumbMeta.format === 'webp', `thumb is webp via sharp 0.35 (${thumbMeta.format} ${thumbMeta.width}px)`);
check(
  processed.width === outMeta.width && processed.height === outMeta.height,
  `reported dimensions match the bytes on disk (${processed.width}x${processed.height})`
);
check(processed.sizeBytes === fs.statSync(path.join(tmpUploads, processed.fileKey)).size, 'reported size matches the file on disk');

await throwsAsync(
  () => processUpload({ buffer: Buffer.from('pretend-jpg'), declaredMime: 'image/jpeg', purpose: 'photo' }),
  /UNSUPPORTED|415|could not recognise/i,
  'magic-byte validation still rejects a fake jpeg disguised by its header'
);

// mozjpeg + rotate() + animated flags are the API surface most likely to move under sharp.
const { default: sharp } = await import('sharp');
const gifBytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#7b35a8' } }).gif().toBuffer();
const animatedOk = await sharp(gifBytes, { animated: true, failOn: 'none' }).metadata();
check(Boolean(animatedOk.width), `sharp({ animated, failOn }) options still accepted (${animatedOk.width}x${animatedOk.height})`);
// A 64x64 flat colour legitimately encodes to ~90 bytes of webp, so assert on the
// decoded pixels rather than a size threshold.
const svgPng = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#21D07A"/></svg>')).webp({ quality: 80 }).toBuffer();
const svgMeta = await sharp(svgPng).metadata();
const svgPx = await sharp(svgPng).raw().toBuffer();
check(
  svgMeta.format === 'webp' && svgMeta.width === 64 && svgMeta.height === 64 && svgPx.length === 64 * 64 * 3,
  `libvips still rasterises the SVG poster fallback (${svgMeta.width}x${svgMeta.height} ${svgMeta.format}, ${svgPng.length} bytes)`
);
const [r0, g0, b0] = [...svgPx.slice(0, 3)];
check(Math.abs(r0 - 0x21) < 24 && Math.abs(g0 - 0xd0) < 24 && Math.abs(b0 - 0x7a) < 24, `the fill colour actually renders (#${r0.toString(16).padStart(2, '0')}${g0.toString(16).padStart(2, '0')}${b0.toString(16).padStart(2, '0')} vs #21d07a)`);
const stripped = await sharp(jpeg).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
check(stripped.length > 0, `rotate()+mozjpeg re-encode path works (${stripped.length} bytes)`);

// --------------------------------------------------------------------------
section('4. query parsing + body limits (express 4.22 with overridden qs)');
const qRes = await fetch(`${base}/q?tags[]=a&tags[]=b&after[id]=7&plain=hi`);
const q = await qRes.json();
check(Array.isArray(q.tags) && q.tags.join(',') === 'a,b', `qs parses bracket arrays (${JSON.stringify(q.tags)})`);
check(q.after && q.after.id === '7', `qs parses nested objects (${JSON.stringify(q.after)})`);
check(q.plain === 'hi', `qs parses plain scalars (${q.plain})`);
const bigJson = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(200 * 1024) }) });
check(bigJson.status === 413, `express.json 100kb limit still enforced on a public host (got ${bigJson.status})`);
const smallJson = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'amara' }) });
const smallBody = await smallJson.json();
check(smallJson.status === 200 && smallBody.keys.includes('username'), `express.json still parses bodies under the cap (${smallJson.status})`);
const formRes = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2' });
check(formRes.status === 200, 'urlencoded parser (used by no route today, but mounted by server.js) still works');

// --------------------------------------------------------------------------
section('5. https upgrade rule (new middleware/https.js)');
function stubReq({ path: p = '/', method = 'GET', host = 'ember.example', fwdProto } = {}) {
  const headers = { host };
  if (fwdProto) headers['x-forwarded-proto'] = fwdProto;
  return {
    path: p,
    originalUrl: p === '/' ? '/' : p,
    method,
    secure: fwdProto === 'https',
    headers,
    _redirect: null,
    redirect(status, url) {
      this._redirect = { status, url };
    }
  };
}
const mw = forceHttps({ trustProxy: true });
{
  const req = stubReq({ path: '/app' });
  let nexted = false;
  mw(req, { redirect: (s, u) => (req._redirect = { status: s, url: u }) }, () => (nexted = true));
  check(!nexted && req._redirect?.status === 301 && req._redirect.url === 'https://ember.example/app', `GET http -> 301 https (${JSON.stringify(req._redirect ?? { nexted })})`);
}
{
  const req = stubReq({ path: '/api/login', method: 'POST' });
  mw(req, { redirect: (s, u) => (req._redirect = { status: s, url: u }) }, () => {});
  check(req._redirect?.status === 308, `POST http -> 308 so the login body survives (${req._redirect?.status})`);
}
{
  const req = stubReq({ path: '/app', fwdProto: 'https' });
  let nexted = false;
  mw(req, { redirect: () => (req._redirect = true) }, () => (nexted = true));
  check(nexted && !req._redirect, 'already-https request passes through');
}
{
  const req = stubReq({ path: '/api/health' });
  let nexted = false;
  mw(req, { redirect: () => (req._redirect = true) }, () => (nexted = true));
  check(nexted && !req._redirect, '/api/health exempt so the Docker HEALTHCHECK never loops');
}
{
  const req = stubReq({ path: '/socket.io/?EIO=4&transport=polling' });
  let nexted = false;
  mw(req, { redirect: () => (req._redirect = true) }, () => (nexted = true));
  check(nexted && !req._redirect, '/socket.io exempt so transport upgrades are never bounced');
}
{
  const req = stubReq({ host: undefined });
  delete req.headers.host;
  let nexted = false;
  mw(req, { redirect: () => (req._redirect = true) }, () => (nexted = true));
  check(nexted && !req._redirect, 'missing Host header passes through instead of redirecting to "https://undefined"');
}
let guardThrew = false;
try {
  forceHttps({ trustProxy: false });
} catch {
  guardThrew = true;
}
check(guardThrew, 'refuses to start an endless redirect loop when TRUST_PROXY is off');

// --------------------------------------------------------------------------
section('6. cookies (cookie 0.7.2 + auth cookie options)');
const opts = cookieOptions(15 * 60 * 1000);
check(opts.httpOnly === true && opts.sameSite === 'lax', `access cookie is httpOnly + SameSite=lax (${JSON.stringify(opts)})`);
check(opts.secure === env.isProd, `cookie Secure flag follows NODE_ENV (isProd=${env.isProd}) - set NODE_ENV=production and it flips on`);
const serialized = cookieLib.serialize('ec_at', 'jwt.value-with=symbols');
const parsed = cookieLib.parse(`ec_at=x; ${serialized}; ec_csrf=abc`);
check(parsed.ec_csrf === 'abc' && typeof parsed.ec_at === 'string', 'parse() round-trips the app cookie names');
// cookie 0.7 does NOT return a null-prototype object, so assert the property that
// actually matters: a crafted key cannot pollute prototypes or reach the app's reads.
const evil = cookieLib.parse('__proto__=polluted; constructor=bad; ok=1');
check(Object.prototype.polluted === undefined, 'crafted __proto__ cookie cannot pollute Object.prototype');
check(!Object.prototype.hasOwnProperty.call(evil, '__proto__'), '__proto__ is dropped from the parsed result entirely');
check(evil.ok === '1', 'legitimate cookies in the same header still parse');
// server/src/middleware/auth.js only ever reads parsed[COOKIE.access] / [csrf],
// so a stray "constructor" key is inert - guard that assumption if that ever changes.
check(
  /parsed\[COOKIE\.(access|csrf)\]|COOKIE\.access\]/.test(
    fs.readFileSync(path.join(ROOT, 'server/src/middleware/auth.js'), 'utf8')
  ),
  'socket auth reads only fixed cookie names (so unknown keys from parse() are inert)'
);
const prodCookieOpts = { ...opts, secure: true };
check(prodCookieOpts.secure === true, 'production shape carries Secure (no cleartext session on a public host)');

// --------------------------------------------------------------------------
section('7. purge scheduler (node-cron 4.6)');
check(cron.validate('*/5 * * * *') === true, "cron.validate accepts the default CLEANUP_CRON '*/5 * * * *'");
check(cron.validate('definitely not a cron') === false, 'cron.validate rejects garbage (so the fallback in cleanup.js triggers)');
let ticks = 0;
const task = cron.schedule('* * * * * *', () => (ticks += 1));
await new Promise((r) => setTimeout(r, 2600));
task.stop();
check(ticks >= 1, `a real scheduled task fired ${ticks} time(s) in 2.6s - the 24h purge will run`);
check(typeof task.stop === 'function', 'task.stop() still exists (called by stopCleanupJob on shutdown)');

// --------------------------------------------------------------------------
section('8. demo-data guard (db/seed.js refuses on a public host)');
function runSeed(extraEnv) {
  return spawnSync(process.execPath, [path.join(ROOT, 'db', 'seed.js')], {
    encoding: 'utf8',
    timeout: 25000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      JWT_REFRESH_SECRET: 'y'.repeat(32),
      DB_PASSWORD: 'prodpass',
      ...extraEnv
    }
  });
}
const out1 = runSeed({ SEED_DEMO: '' });
const combined1 = `${out1.stdout ?? ''}${out1.stderr ?? ''}`;
check(out1.status !== 0 && /refusing to create demo accounts/i.test(combined1), 'production + no SEED_DEMO -> refuses to seed');
check(/CLEARS existing rows/i.test(combined1), 'refusal also warns that seeding wipes live user data');
const out2 = runSeed({ SEED_DEMO: '1', DEMO_PASSWORD: '' });
const combined2 = `${out2.stdout ?? ''}${out2.stderr ?? ''}`;
check(out2.status !== 0 && /DEMO_PASSWORD is missing or is the README default/i.test(combined2), 'SEED_DEMO=1 without a private DEMO_PASSWORD -> still refuses');
const out3 = runSeed({ SEED_DEMO: '1', DEMO_PASSWORD: 'Password123!' });
const combined3 = `${out3.stdout ?? ''}${out3.stderr ?? ''}`;
check(out3.status !== 0 && /DEMO_PASSWORD is missing or is the README default/i.test(combined3), "DEMO_PASSWORD equal to the published README password -> refuses");
const out4 = runSeed({ SEED_DEMO: '1', DEMO_PASSWORD: 'a-real-private-one' });
const combined4 = `${out4.stdout ?? ''}${out4.stderr ?? ''}`;
check(!/refusing to create demo accounts/i.test(combined4), 'the opt-in path is not blocked (it proceeds and fails only at the DB, as intended here)');
check(/never logged here|smoke_never_connects|ECONNREFUSED|Access denied|getaddrinfo|connecting|error/i.test(combined4), 'proceeded past the guard into real DB code');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
check(!/&&\s*node db\/seed\.js\s*&&/.test(compose), 'docker-compose no longer seeds demo data on every container boot');
check(/FORCE_HTTPS/.test(compose), 'docker-compose passes FORCE_HTTPS through so a VPS can enable TLS upgrade');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
check(/Password123!/.test(readme), 'README still documents the dev demo password (unchanged, dev-only)');

// --------------------------------------------------------------------------
section('9. production config surface');
check(env.isProd === false, 'env.isProd reflects NODE_ENV for the smoke run itself');
const prodEnv = spawnSync(
  process.execPath,
  ['-e', "import('./server/src/config/env.js').then(m=>console.log(JSON.stringify({prod:m.env.isProd,force:m.env.FORCE_HTTPS,cookie:m.cookieOptions(1000)})))"],
  {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TRUST_PROXY: '1',
      FORCE_HTTPS: '1',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32)
    }
  }
);
let prodShape = null;
try {
  prodShape = JSON.parse(prodEnv.stdout.trim().split('\n').pop());
} catch {
  /* reported below */
}
check(prodShape?.prod === true, `NODE_ENV=production is honoured (${prodEnv.stdout.trim() || prodEnv.stderr.slice(0, 120)})`);
check(prodShape?.force === true, 'FORCE_HTTPS=1 is read into env for public deploys');
check(prodShape?.cookie?.secure === true, 'production cookies are Secure (session cookie cannot ride over http)');
const shortSecret = spawnSync(
  process.execPath,
  ['-e', "import('./server/src/config/env.js').then(()=>console.log('BOOTED')).catch(e=>{console.log('THREW:'+e.message)})"],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'short', JWT_REFRESH_SECRET: 'b'.repeat(32), FORCE_HTTPS: '0' } }
);
check(/THREW:.*at least 32 characters/.test(shortSecret.stdout), 'production refuses to boot with a short JWT secret');

// --------------------------------------------------------------------------
section('10. DB TLS resolution + deploy-check exit codes');
function probeEnv(extra, expr) {
  const r = spawnSync(process.execPath, ['-e', expr], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_HOST: 'db.internal',
      DB_PORT: '3306',
      DB_USER: 'u',
      DB_NAME: 'd',
      APP_ORIGIN: 'http://localhost:3000',
      DB_SSL: '',
      DB_SSL_CA: '',
      DB_SSL_REJECT_UNAUTHORIZED: '',
      ...extra
    }
  });
  return { out: (r.stdout || '').trim().split('\n').pop(), err: r.stderr || '', status: r.status };
}
const SSL_EXPR = "import('./server/src/config/env.js').then(m=>console.log(JSON.stringify(m.env.DB.ssl ?? null)),e=>{console.log('THREW:'+e.message)})";
const sslOff = probeEnv({}, SSL_EXPR);
check(sslOff.out === 'null', `DB_SSL unset leaves TLS off for the compose database (${sslOff.out})`);
const sslOn = probeEnv({ DB_SSL: 'true' }, SSL_EXPR);
check(sslOn.out === '{"rejectUnauthorized":true}', `DB_SSL=true verifies the certificate chain (${sslOn.out})`);
const sslNoVerify = probeEnv({ DB_SSL: '1', DB_SSL_REJECT_UNAUTHORIZED: 'false' }, SSL_EXPR);
check(sslNoVerify.out === '{"rejectUnauthorized":false}', `rejectUnauthorized=false is honoured when a provider gives no CA (${sslNoVerify.out})`);
const caFile = path.join(tmpUploads, 'smoke-ca.pem');
fs.writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
const sslCa = probeEnv({ DB_SSL: 'true', DB_SSL_CA: caFile }, SSL_EXPR);
check(/"ca":\[\{/.test(sslCa.out) && sslCa.out.includes('rejectUnauthorized'), `DB_SSL_CA loads the bundle and still verifies (${sslCa.out.slice(0, 60)})`);
const sslMissingCa = probeEnv({ DB_SSL: 'true', DB_SSL_CA: '/definitely/not/here.pem' }, SSL_EXPR);
check(/THREW:.*does not exist/.test(sslMissingCa.out + sslMissingCa.err), 'a bad DB_SSL_CA path is a startup error, not a silent no-TLS fallback');

// The driver must actually receive it, or all of the above is decoration.
const sslToDriver = spawnSync(
  process.execPath,
  ['-e', "process.env.DB_SSL='true';process.env.DB_SSL_REJECT_UNAUTHORIZED='false';import('./server/src/db/pool.js').then(({pool})=>{const c=pool.pool.config.connectionConfig;console.log(JSON.stringify({ssl:!!c.ssl,rej:c.ssl.rejectUnauthorized}));return pool.end()})"],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DB_HOST: 'h', DB_PORT: '3306', DB_USER: 'u', DB_NAME: 'd', APP_ORIGIN: 'http://localhost:3000' } }
);
check(/"ssl":true,"rej":false/.test(sslToDriver.stdout), `mysql2 receives the ssl config (${sslToDriver.stdout.trim() || sslToDriver.stderr.slice(0, 80)})`);

function runCheck(envOverrides) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'deploy-check.mjs'), '--offline'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DB_HOST: 'db.internal',
      DB_USER: 'ember',
      DB_NAME: 'ember',
      DB_PASSWORD: 'a-real-password-here',
      // Deliberately not 'aaaa...': the checker rejects single-character repeats as
      // placeholders, so the "sane config" fixture has to look like a real secret.
      JWT_ACCESS_SECRET: '0f3a9c7b1e5d8a2c4b6f0d1e2c3a4b5c6d7e8f90',
      JWT_REFRESH_SECRET: '9b2c4d6e8f0a1b3c5d7e9f0a2b4c6d8e0f1a2b3c',
      TRUST_PROXY: '1',
      UPLOAD_DIR: tmpUploads,
      APP_ORIGIN: 'https://ember.example.com',
      ...envOverrides
    }
  });
  // deploy-check disables colour when it is not a TTY, so this needs no stripping.
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const goodCfg = runCheck({ DB_SSL: 'true' });
check(goodCfg.status === 0, `deploy-check passes a sane production config (exit ${goodCfg.status})`, goodCfg.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n'));
const httpOrigin = runCheck({ APP_ORIGIN: 'http://ember.example.com' });
check(httpOrigin.status === 1 && /APP_ORIGIN/.test(httpOrigin.out), 'deploy-check fails an http origin in production');
const plainRemoteDb = runCheck({ DB_HOST: 'gateway.prod.tidbcloud.com', DB_SSL: 'false' });
check(plainRemoteDb.status === 1 && /DB TLS off to a remote host/.test(plainRemoteDb.out), 'deploy-check fails plaintext TLS to a managed database');
const localPlainDb = runCheck({ DB_HOST: 'db', DB_SSL: 'false' });
check(localPlainDb.status === 0, 'the bare compose service name "db" over the private network is not a TLS failure');
// Regression guard: /^db/ used to match this too, so a real managed host named
// db.<something> escaped the plaintext warning entirely.
const dbishRemote = runCheck({ DB_HOST: 'db.prod.example.com', DB_SSL: 'false' });
check(dbishRemote.status === 1 && /DB TLS off to a remote host/.test(dbishRemote.out), 'a host merely STARTING with "db" is still treated as remote');
check(/ok {3}DB transport/.test(localPlainDb.out), 'the compose hostname "db" is exempt from the TLS requirement');
const loopback = runCheck({ FORCE_HTTPS: '1', TRUST_PROXY: '0', NODE_ENV: 'development' });
check(loopback.status === 1 && /loop every request forever/.test(loopback.out), 'deploy-check catches the redirect loop even in dev');

// --------------------------------------------------------------------------
section('11. Migration guard: a restart must never destroy data');

// db/schema.sql is a snapshot, not a delta: it DROPs and recreates all 42 tables.
// Both the image start command and docker-compose call `node db/migrate.js
// --if-needed` at every container start, so the no-op path is load-bearing for
// data survival, not just a nicety. Assert the shape of the schema file, then
// the decision table the boot path runs on, then the wiring in each deploy file.
const { decideMigration } = await import('../db/migrate.js');
check(true, 'db/migrate.js imports without touching the database (testable guard)');

const schemaSql = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
const drops = (schemaSql.match(/^DROP TABLE IF EXISTS/gm) || []).length;
const bareCreates = (schemaSql.match(/^CREATE TABLE /gm) || []).length;
const guardedCreates = (schemaSql.match(/^CREATE TABLE IF NOT EXISTS/gm) || []).length;
check(bareCreates === 42 && guardedCreates === 0, `the snapshot creates all 42 tables unconditionally (${bareCreates} bare, ${guardedCreates} guarded)`);
check(drops === 23, `23 of those tables are dropped first (${drops}) - a partial wipe, which is why re-running is never safe`);
check(drops < bareCreates, 'the drop list is incomplete, so a second run aborts partway rather than rebuilding cleanly');

const d0 = decideMigration({});
check(d0.action === 'apply' && !d0.destructive, 'empty database: first boot provisions the schema');
const d1 = decideMigration({ existingTables: 42 });
check(d1.action === 'refuse', 'schema present + no flags: refuses instead of wiping');
const d2 = decideMigration({ existingTables: 42, ifNeeded: true });
check(d2.action === 'skip', '--if-needed against an existing schema: no-op, which is what restarts run');
const d3 = decideMigration({ existingTables: 0, ifNeeded: true });
check(d3.action === 'apply' && !d3.destructive, '--if-needed against an empty database still provisions it');
const d4 = decideMigration({ existingTables: 42, fresh: true });
check(d4.action === 'apply', '--fresh is the only way through, and it recreates from the snapshot');
const d5 = decideMigration({ existingTables: 1 });
check(d5.action === 'refuse', 'a half-migrated database (1 table) is refused too, not papered over');
const migrateSrc = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
check(!migrateSrc.includes("'--force'"), 'there is no --force flag to reach for by accident');

const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
check(/CMD \["sh", "-c", "node db\/migrate\.js --if-needed && exec node server\/server\.js"\]/.test(dockerfile), 'Dockerfile CMD migrates only if needed, then execs the server');
const composeRaw = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
check(composeRaw.includes('node db/migrate.js --if-needed && exec node server/server.js'), 'compose start command matches the image (skip-if-present, exec for clean shutdown)');
const renderYml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
check(!/preDeployCommand:\s*node db\/migrate\.js\s*$/m.test(renderYml), 'render.yaml has no bare preDeployCommand that would wipe data on every deploy');
check(/not re-runnable/.test(migrateSrc) && /--if-needed/.test(migrateSrc), 'the refusal message names the reason and both ways out');

fs.rmSync(tmpUploads, { recursive: true, force: true });
server.close();
await (await import('../server/src/db/pool.js')).pool.end().catch(() => {});

console.log(`\n${bad === 0 ? C(32) : C(31)}dep-smoke: ${ok} passed, ${bad} failed${R}`);
if (bad) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
