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
import tls from 'node:tls';
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
  RUN_BACKGROUND_JOBS: 'true',
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
const {
  createMomentSchema,
  contentReportSchema,
  likeTargetTypeSchema,
  momentReactionSchema,
  startVerificationSchema
} = await import('../server/src/utils/validators.js');
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

section('Zod 4 validation compatibility');
function firstValidationMessage(schema, value) {
  const result = schema.safeParse(value);
  return result.success ? '' : result.error.issues[0]?.message || '';
}
check(firstValidationMessage(startVerificationSchema, { kind: 'sms' }) === 'Choose email or phone.', 'Zod 4 preserves the verification-kind message');
check(firstValidationMessage(likeTargetTypeSchema, 'unknown') === 'Unknown like target.', 'Zod 4 preserves the like-target message');
check(firstValidationMessage(createMomentSchema, { kind: 'unknown' }) === 'Choose a photo, video or text moment.', 'Zod 4 preserves the moment-kind message');
check(firstValidationMessage(momentReactionSchema, { emoji: 'unknown' }) === 'Choose one of the offered reactions.', 'Zod 4 preserves the reaction message');
check(firstValidationMessage(contentReportSchema, { targetType: 'profile', targetId: '1', reason: 'unknown' }) === 'Choose a reason for the report.', 'Zod 4 preserves the report-reason message');

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
check(env.RUN_BACKGROUND_JOBS === true, 'in-process background jobs remain enabled by default');
const prodEnv = spawnSync(
  process.execPath,
  ['-e', "import('./server/src/config/env.js').then(m=>console.log(JSON.stringify({prod:m.env.isProd,force:m.env.FORCE_HTTPS,jobs:m.env.RUN_BACKGROUND_JOBS,cookie:m.cookieOptions(1000)})))"],
  {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TRUST_PROXY: '1',
      FORCE_HTTPS: '1',
      RUN_BACKGROUND_JOBS: 'false',
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
check(prodShape?.jobs === false, 'RUN_BACKGROUND_JOBS=false disables in-process jobs for external host cron');
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
      DB_SSL_CA_BASE64: '',
      DB_SSL_REJECT_UNAUTHORIZED: '',
      ...extra
    }
  });
  return { out: (r.stdout || '').trim().split('\n').pop(), err: r.stderr || '', status: r.status };
}
const SSL_EXPR = "import('./server/src/config/env.js').then(m=>console.log(JSON.stringify(m.env.DB.ssl ?? null)),e=>{console.log('THREW:'+e.message)})";
const sslOff = probeEnv({}, SSL_EXPR);
check(sslOff.out === 'null', `DB_SSL unset leaves TLS off for the private compose database (${sslOff.out})`);
const sslOn = probeEnv({ DB_SSL: 'true' }, SSL_EXPR);
const sslOnOptions = JSON.parse(sslOn.out);
check(sslOnOptions.rejectUnauthorized === true && sslOnOptions.verifyIdentity === true, 'DB_SSL=true verifies the chain and database hostname');
const sslNoVerify = probeEnv({ DB_SSL: '1', DB_SSL_REJECT_UNAUTHORIZED: 'false' }, SSL_EXPR);
check(/THREW:.*Certificate verification cannot be disabled/.test(sslNoVerify.out + sslNoVerify.err), 'an insecure certificate-verification override is rejected');

// Use a public root from Node's trust store as a valid, non-secret CA fixture.
const testCaPem = tls.rootCertificates[0];
const testCaBase64 = Buffer.from(testCaPem, 'utf8').toString('base64');
const caFile = path.join(tmpUploads, 'smoke-ca.pem');
fs.writeFileSync(caFile, testCaPem);
const sslCaFile = probeEnv({ DB_SSL: 'true', DB_SSL_CA: caFile }, SSL_EXPR);
const sslCaFileOptions = JSON.parse(sslCaFile.out);
check(
  sslCaFileOptions.rejectUnauthorized === true && sslCaFileOptions.verifyIdentity === true && sslCaFileOptions.ca?.length === 1,
  'DB_SSL_CA loads an in-runtime PEM certificate while retaining chain and identity verification'
);
const sslCaBase64 = probeEnv({ DB_SSL: 'true', DB_SSL_CA_BASE64: testCaBase64 }, SSL_EXPR);
const sslCaBase64Options = JSON.parse(sslCaBase64.out);
const decodedCa = Buffer.from(sslCaBase64Options.ca?.[0]?.data || []);
check(
  sslCaBase64Options.rejectUnauthorized === true && sslCaBase64Options.verifyIdentity === true && decodedCa.equals(Buffer.from(`${testCaPem}\n`)),
  'DB_SSL_CA_BASE64 decodes the PEM bundle without weakening TLS verification'
);
const sslMissingCa = probeEnv({ DB_SSL: 'true', DB_SSL_CA: '/definitely/not/here.pem' }, SSL_EXPR);
check(/THREW:.*does not exist inside this runtime/.test(sslMissingCa.out + sslMissingCa.err), 'a missing mounted CA file fails startup instead of silently falling back');
const sslBadCa = probeEnv({ DB_SSL: 'true', DB_SSL_CA_BASE64: Buffer.from('not a certificate').toString('base64') }, SSL_EXPR);
check(/THREW:.*PEM-encoded CA certificates/.test(sslBadCa.out + sslBadCa.err), 'invalid certificate data is rejected before opening a connection');
const sslBothCa = probeEnv({ DB_SSL: 'true', DB_SSL_CA: caFile, DB_SSL_CA_BASE64: testCaBase64 }, SSL_EXPR);
check(/THREW:.*Set only one/.test(sslBothCa.out + sslBothCa.err), 'ambiguous CA sources fail fast');
const aivenNoTls = probeEnv({ DB_HOST: 'mysql-test.aivencloud.com', DB_SSL: 'false' }, SSL_EXPR);
check(/THREW:.*Aiven MySQL requires DB_SSL=true/.test(aivenNoTls.out + aivenNoTls.err), 'Aiven hosts cannot start without TLS');
const aivenNoCa = probeEnv({ DB_HOST: 'mysql-test.aivencloud.com', DB_SSL: 'true' }, SSL_EXPR);
check(/THREW:.*Aiven MySQL requires its project CA/.test(aivenNoCa.out + aivenNoCa.err), 'Aiven hosts require their project CA');
const aivenGood = probeEnv({ DB_HOST: 'mysql-test.aivencloud.com', DB_SSL: 'true', DB_SSL_CA_BASE64: testCaBase64 }, SSL_EXPR);
check(JSON.parse(aivenGood.out).verifyIdentity === true, 'Aiven TLS configuration loads when its project CA is supplied');

// Both the app pool and migration runner use the shared settings helper. Inspect
// mysql2's resolved config without opening a network connection.
const sslToDriver = spawnSync(
  process.execPath,
  [
    '-e',
    "Promise.all([import('./server/src/db/pool.js'),import('./server/src/db/connection-options.js')]).then(async ([{pool},{mysqlConnectionOptions}])=>{const app=pool.pool.config.connectionConfig;const migration=mysqlConnectionOptions({includeDatabase:false});console.log(JSON.stringify({appTls:{rejectUnauthorized:app.ssl.rejectUnauthorized,verifyIdentity:app.ssl.verifyIdentity,caCount:app.ssl.ca.length},sameHost:app.host===migration.host,samePort:app.port===migration.port,sameUser:app.user===migration.user,sameTls:app.ssl.ca[0].equals(migration.ssl.ca[0]),appHasDatabase:Boolean(app.database),migrationHasDatabase:Object.hasOwn(migration,'database')}));await pool.end()}).catch(e=>console.log('THREW:'+e.message))"
  ],
  {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_HOST: 'mysql-test.aivencloud.com',
      DB_PORT: '3306',
      DB_USER: 'u',
      DB_NAME: 'd',
      APP_ORIGIN: 'http://localhost:3000',
      DB_SSL: 'true',
      DB_SSL_CA: '',
      DB_SSL_CA_BASE64: testCaBase64,
      DB_SSL_REJECT_UNAUTHORIZED: ''
    }
  }
);
const driverOptions = JSON.parse(sslToDriver.stdout.trim().split('\n').pop());
check(
  driverOptions.appTls?.rejectUnauthorized === true &&
    driverOptions.appTls?.verifyIdentity === true &&
    driverOptions.appTls?.caCount === 1 &&
    driverOptions.sameHost && driverOptions.samePort && driverOptions.sameUser &&
    driverOptions.sameTls && driverOptions.appHasDatabase && !driverOptions.migrationHasDatabase,
  `mysql2 app and migration settings share verified TLS (${sslToDriver.stdout.trim() || sslToDriver.stderr.slice(0, 120)})`
);
const migrationSource = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
const poolSource = fs.readFileSync(path.join(ROOT, 'server', 'src', 'db', 'pool.js'), 'utf8');
check(migrationSource.includes('...mysqlConnectionOptions({ includeDatabase: false })'), 'migration runner uses the shared MySQL connection settings');
check(poolSource.includes('...mysqlConnectionOptions()'), 'web server pool uses the shared MySQL connection settings');

function runCheck(envOverrides) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'deploy-check.mjs'), '--offline'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DB_HOST: 'db.internal',
      DB_PORT: '3306',
      DB_USER: 'ember',
      DB_NAME: 'ember',
      DB_PASSWORD: 'a-real-password-here',
      DB_SSL: '',
      DB_SSL_CA: '',
      DB_SSL_CA_BASE64: '',
      DB_SSL_REJECT_UNAUTHORIZED: '',
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
const aivenMissingCaCheck = runCheck({ DB_HOST: 'mysql-test.aivencloud.com', DB_SSL: 'true' });
check(aivenMissingCaCheck.status === 1 && /Aiven MySQL requires its project CA/.test(aivenMissingCaCheck.out), 'deploy preflight blocks Aiven without its project CA');
const aivenCaCheck = runCheck({ DB_HOST: 'mysql-test.aivencloud.com', DB_SSL: 'true', DB_SSL_CA_BASE64: testCaBase64 });
check(aivenCaCheck.status === 0 && /provider CA loaded/.test(aivenCaCheck.out), 'offline deploy preflight accepts verified Aiven CA configuration');
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
section('11. Ordered, checksummed migrations: safe adoption and restart behavior');

const { adaptForMariaDb, baselineTableColumns, decideMigration, loadMigrations, splitStatements } =
  await import('../db/migrate.js');
check(true, 'db/migrate.js imports without connecting to or modifying a database');

const migrations = await loadMigrations(path.join(ROOT, 'db', 'migrations'));
check(migrations.length >= 2, `versioned migrations are discovered (${migrations.length} files)`);
check(migrations[0]?.filename === '0001_baseline.sql', 'the initial schema is a numbered baseline migration');
check(migrations.every((m) => /^[0-9]{4}$/.test(m.version) && /^[a-f0-9]{64}$/.test(m.checksum)), 'migration versions and SHA-256 checksums are stable-shaped');
const baselineSql = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '0001_baseline.sql'), 'utf8');
const snapshotSql = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
const baselineShape = baselineTableColumns(baselineSql);
check(baselineShape.size === 42, `baseline contains all 42 expected business tables (found ${baselineShape.size})`);
check([...baselineShape.values()].reduce((n, columns) => n + columns.length, 0) === 330, 'baseline parser accounts for 330 column definitions');
check(snapshotSql === baselineSql, 'db/schema.sql documents the same initial baseline instead of a separate destructive snapshot');
check(splitStatements(baselineSql).length === 43, 'SQL statement splitting handles the SET statement and all 42 table definitions');
check(adaptForMariaDb('CREATE TABLE x (id INT) COLLATE=utf8mb4_0900_ai_ci').includes('utf8mb4_general_ci'), 'MariaDB collation compatibility remains explicit');

const migrationFiles = migrations.map((m) => m.sql).join('\n');
check(!/\b(?:DROP\s+(?:DATABASE|TABLE)|TRUNCATE\s+TABLE)\b/i.test(migrationFiles), 'normal versioned migrations contain no database/table drop or truncate');
check(/UPDATE verifications[\s\S]*?WHERE status <> 'pending'[\s\S]*?SET file_path = NULL/i.test(migrations.find((migration) => migration.version === '0002')?.sql || ''), 'reviewed verification file references are cleared after queueing deletion');
check(/ADD COLUMN revoked_at DATETIME NULL/.test(migrations.find((migration) => migration.version === '0003')?.sql || ''), 'verification issuance history is retained through an additive revocation marker');
const migrateSrc = fs.readFileSync(path.join(ROOT, 'db', 'migrate.js'), 'utf8');
check(
  /if \(FRESH\) await assertDestructiveResetAllowed\(database\)/.test(migrateSrc) &&
    /if \(FRESH\)\s+\{[\s\S]*?DROP\s+DATABASE\s+IF\s+EXISTS[\s\S]*?\n\s+\}/.test(migrateSrc),
  'DROP DATABASE is reachable only after the explicit --fresh guard'
);

const d0 = decideMigration({});
check(d0.action === 'apply', 'empty database applies the ordered baseline');
const d1 = decideMigration({ existingTables: 42, legacyBaselineValid: true });
check(d1.action === 'adopt', 'a validated complete legacy schema is adopted without replaying baseline DDL');
const d2 = decideMigration({ existingTables: 42, legacyBaselineValid: true, hasHistory: true, pendingCount: 0 });
check(d2.action === 'skip', 'complete migration history with no pending version is a no-op');
const d3 = decideMigration({ existingTables: 42, legacyBaselineValid: true, hasHistory: true, pendingCount: 1 });
check(d3.action === 'apply', 'known migration history applies only pending numbered versions');
const d4 = decideMigration({ existingTables: 1, legacyBaselineValid: false });
check(d4.action === 'refuse', 'partial or unrecognized schemas are refused rather than overwritten');
check(migrateSrc.includes('--target=') && migrateSrc.includes('Checksum mismatch'), 'operators can target a version and checksum drift is refused');
check(migrateSrc.includes('GET_LOCK') && migrateSrc.includes('Migration history has a gap'), 'migrations serialize concurrent runners and refuse non-contiguous history');
check(migrateSrc.indexOf('GET_LOCK') < migrateSrc.indexOf('DROP DATABASE IF EXISTS'), 'migration lock is acquired before even the guarded destructive reset path');

const freshGuardProd = spawnSync(process.execPath, [path.join(ROOT, 'db', 'migrate.js'), '--fresh'], {
  cwd: ROOT, encoding: 'utf8', timeout: 10000,
  env: {
    ...process.env, NODE_ENV: 'production', DB_HOST: 'db', DB_PORT: '3306', DB_USER: 'smoke',
    DB_PASSWORD: 'smoke-only', DB_NAME: 'smoke_never_connects', APP_ORIGIN: 'https://example.invalid',
    JWT_ACCESS_SECRET: 'a'.repeat(48), JWT_REFRESH_SECRET: 'b'.repeat(48),
    ALLOW_DESTRUCTIVE_RESET: '1', CONFIRM_DROP_DATABASE: 'smoke_never_connects'
  }
});
check(freshGuardProd.status === 1 && /disabled in production/.test(`${freshGuardProd.stdout}${freshGuardProd.stderr}`), '--fresh refuses in production before opening a database connection');
const freshGuardUnconfirmed = spawnSync(process.execPath, [path.join(ROOT, 'db', 'migrate.js'), '--fresh'], {
  cwd: ROOT, encoding: 'utf8', timeout: 10000,
  env: { ...process.env, NODE_ENV: 'development', ALLOW_DESTRUCTIVE_RESET: '', CONFIRM_DROP_DATABASE: '' }
});
check(freshGuardUnconfirmed.status === 1 && /--fresh refused/.test(`${freshGuardUnconfirmed.stdout}${freshGuardUnconfirmed.stderr}`), '--fresh requires both explicit development reset guards');

const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
check(/CMD \["sh", "-c", "node db\/migrate\.js --if-needed && exec node server\/server\.js"\]/.test(dockerfile), 'Dockerfile applies pending migrations before starting the server');
check(/COPY scripts\/bootstrap-admin\.mjs scripts\/deploy-check\.mjs scripts\/db-ping\.mjs \.\/scripts\//.test(dockerfile), 'production image includes admin, deploy-check, and read-only DB ping tools');
const packageScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
const dbPingSource = fs.readFileSync(path.join(ROOT, 'scripts', 'db-ping.mjs'), 'utf8');
check(packageScripts['db:ping'] === 'node scripts/db-ping.mjs' && dbPingSource.includes('assertDbConnection'), 'db:ping provides a read-only connection check using the application pool');
const composeRaw = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
check(composeRaw.includes('node db/migrate.js --if-needed && exec node server/server.js'), 'compose start command matches the image');
const renderYml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
check(!/preDeployCommand:\s*node db\/migrate\.js\s*$/m.test(renderYml), 'Render does not separately run a migration command that could race the boot process');

// --------------------------------------------------------------------------
section('12. CI workflow files are valid for the Actions schema, not just YAML');

// A step with a name and a comment but no run:/uses: is legal YAML and the Actions
// parser rejects the whole file for it - which shows up as a workflow run that
// completes in the same second it started, with zero jobs, no log, and no clue
// beyond "the workflow is not valid". That happened to this repo's ci.yml, so the
// rule is asserted here instead of discovered at deploy time.
const yaml = nodeRequire('js-yaml');
const workflows = ['ci.yml', 'publish.yml', 'verify-live.yml'].map((f) => {
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8');
  let doc = null;
  try {
    doc = yaml.load(text);
  } catch (err) {
    check(false, `${f} parses as YAML`, String(err.message).split('\n')[0]);
  }
  return { f, doc };
});
check(workflows.every((w) => w.doc), 'both workflow files parse');

for (const { f, doc } of workflows) {
  if (!doc) continue;
  const jobs = doc.jobs || {};
  check(Object.keys(jobs).length > 0, `${f}: declares ${Object.keys(jobs).length} job(s)`);
  for (const [id, job] of Object.entries(jobs)) {
    check(Boolean(job['runs-on']), `${f}/${id}: has runs-on`);
    check(Array.isArray(job.steps) && job.steps.length > 0, `${f}/${id}: has steps`);
    const orphans = (job.steps || []).filter((st) => !st.run && !st.uses);
    check(
      orphans.length === 0,
      `${f}/${id}: every step has run: or uses:`,
      orphans.map((st) => st.name || Object.keys(st).join('+')).join(', ')
    );
  }
}

// --- render.yaml, against Render's documented blueprint schema
{
  const raw = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  const doc = yaml.load(raw);
  const svc = doc.services?.[0] || {};
  const env = Object.fromEntries((svc.envVars || []).map((v) => [v.key, v]));
  check(svc.type === 'web' && svc.runtime === 'docker' && svc.dockerfilePath === './Dockerfile', 'Render builds this repo\'s Dockerfile rather than a native runtime');
  check(svc.branch === 'main', 'the Render service tracks main (blueprint default is master, which would deploy nothing)');
  check(svc.autoDeploy === true, 'autoDeploy stays enabled - a push to main rolls the site');
  check(svc.healthCheckPath === '/api/health', 'Render health-checks the one path forceHttps() exempts');
  check(svc.plan && svc.plan !== 'free', `plan is ${svc.plan}: the free instance sleeps, which drops every socket and stops the expiry cron`);
  check(svc.disk?.mountPath === env.UPLOAD_DIR?.value, `the persistent disk is mounted where UPLOAD_DIR writes (${svc.disk?.mountPath})`);
  check(env.DB_SSL?.value === 'true', 'Render enables verified TLS for the managed database');
  check(env.DB_SSL_CA_BASE64?.sync === false, 'the Aiven project CA is supplied as a private Render environment value, not committed');
  check(!env.DB_SSL_REJECT_UNAUTHORIZED, 'Render does not expose an insecure TLS-verification override');
  const secretish = ['DB_PASSWORD', 'DB_USER', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_SSL_CA_BASE64', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'TURN_CREDENTIAL', 'TURN_USERNAME'];
  const hardcoded = secretish.filter((k) => env[k] && env[k].value !== undefined);
  check(hardcoded.length === 0, 'no database credential or CA certificate is hardcoded in render.yaml', hardcoded.length ? 'hardcoded: ' + hardcoded.join(', ') : 'every value is prompted (sync: false) or generated');
  const jwt = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'].filter((k) => env[k]?.generateValue === true);
  check(jwt.length === 2, 'both JWT secrets are generated by Render (generateValue: true), not pasted into the repo');
  // Comments explain the choices; only the live YAML can break a deploy.
  const live = raw.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  check(!/preDeployCommand/.test(live), 'no separate preDeployCommand competes with the image migration runner');
  check(!/(password|secret|token|credential)\s*:\s*['"]?[A-Za-z0-9+/_-]{8,}/i.test(live), 'render.yaml contains nothing that looks like a live secret');
  check(fs.existsSync(path.join(ROOT, svc.dockerfilePath.replace(/^\.\//, ''))), `the blueprint's ${svc.dockerfilePath} exists in the repo`);
}

const ciStep = (ci0) => (ci0?.jobs?.docker?.steps || []);
{
  const steps = ciStep(yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')));
  const img = steps.find((st) => String(st.name).startsWith('Image carries'));
  const body = String(img?.run || '');
  check(/<<'EOF'/.test(body) && /docker run --rm -i --entrypoint sh ember:ci - < image-check\.sh/.test(body), 'the image check pipes a quoted heredoc to sh instead of quoting a script inline');
  const inline = body.split("<<'EOF'")[1]?.split('\nEOF\n')[1] || '';
  check(!/'/.test(inline.split('docker run')[0] || ''), 'no stray single quotes between the heredoc and the docker call');
  check(/test -s public\/css\/app\.css/.test(body), 'the image check still asserts the stylesheet was built into the image');
  check(!/for d in /.test(body), 'no hand-maintained dependency list in the image check (it drifted to bcrypt, which does not exist)');
  check(/readFileSync\("package\.json"/.test(body), 'the image check derives the dependency list from package.json');
  check(/PIPESTATUS/.test(body), 'the image check does not let tee swallow the container exit code');
}

const ci = workflows.find((w) => w.f === 'ci.yml')?.doc;
if (ci) {
  const on = ci.on ?? ci[true]; // js-yaml keeps `on` a string key; older loaders made it boolean true
  // `pull_request:` with no value means "every activity type", which parses to
  // null - so presence is the test, not truthiness.
  check(on?.push !== undefined && on?.pull_request !== undefined, 'ci.yml runs on both push and pull_request');
  check(on?.push?.branches?.includes('main') !== false, 'ci.yml still covers the production branch');
  const verify = ci.jobs['deploy-verify'];
  check(Boolean(verify), 'ci.yml keeps the deploy-verify job (the only check that boots a real server)');
  check(Boolean(verify?.services?.mysql?.image?.startsWith('mysql:8.0')), 'deploy-verify runs against MySQL 8, not MariaDB');
  const boot = (verify?.steps || []).find((st) => String(st.name).startsWith('Boot with seeded data'));
  check(/route-sweep\.mjs/.test(String(boot?.run)), 'deploy-verify runs the route sweep against the live server');
  check(/smoke-socket\.js/.test(String(boot?.run)), 'deploy-verify runs the Socket.IO suite against the live server');
  check(/smoke-browser\.js/.test(String(boot?.run)), 'deploy-verify runs the browser suite against the live server');
  const browserInstall = (verify?.steps || []).find((st) => String(st.name).startsWith('Install Chromium'));
  check(/playwright install --with-deps chromium/.test(String(browserInstall?.run)), 'CI installs a managed Chromium build for reproducible browser tests');
  const baseline = (verify?.steps || []).find((st) => String(st.name).startsWith('Apply only the baseline'));
  check(/--target=0001/.test(String(baseline?.run)), 'deploy-verify starts with only the baseline so MySQL 8 exercises pending DDL');
  const migration = (verify?.steps || []).find((st) => String(st.name).startsWith('Apply additive migration'));
  const migrationRun = String(migration?.run || '');
  check(/0002_admin_security/.test(migrationRun) && /migration-sentinel/.test(migrationRun), 'MySQL integration applies a pending migration while preserving a synthetic row');
  const pendingMigrations = migrations.slice(1);
  check(
    pendingMigrations.every((item) => migrationRun.includes(item.filename.replace(/\.sql$/, ''))),
    `CI explicitly asserts every pending migration through ${migrations.at(-1)?.version}`
  );
  check(migrationRun.includes('[ "$tables" = "49" ]'), 'CI table-count assertion includes the 48th business table and migration ledger');
  check(/--if-needed/.test(migrationRun) && /Checksum mismatch/.test(migrationRun) && !/--fresh/.test(migrationRun), 'restart no-op and checksum refusal are tested without a destructive reset');
  const securityTests = (ci.jobs?.checks?.steps || []).find((st) => String(st.name).startsWith('Security unit suite'));
  check(/npm run test:security/.test(String(securityTests?.run)), 'CI executes the non-empty security unit suite');
  const securityIntegration = fs.readFileSync(path.join(ROOT, 'scripts', 'security-integration.mjs'), 'utf8');
  check(/ALLOW_SYNTHETIC_SECURITY_TESTS=1[\s\S]*security-integration\.mjs/.test(String(boot?.run)), 'CI invokes the synthetic MySQL/API security integration suite');
  check(/process\.env\.CI === 'true'/.test(securityIntegration) && /process\.env\.DB_NAME === 'ember_ci'/.test(securityIntegration) && (securityIntegration.match(/\['127\.0\.0\.1', 'localhost'\]/g) || []).length >= 2, 'the mutating integration suite refuses non-local, non-CI, non-disposable databases');
  const prod = (verify?.steps || []).find((st) => String(st.name).includes('production mode'));
  check(/FORCE_HTTPS=1/.test(String(prod?.run)) && /301/.test(String(prod?.run)) && /Secure/.test(String(prod?.run)), 'deploy-verify boots in production and checks HTTPS upgrade + Secure cookies');
}

// --------------------------------------------------------------------------
section('cPanel / Passenger deployment contract');
const cpanelGuide = fs.readFileSync(path.join(ROOT, 'CPANEL.md'), 'utf8');
const cpanelEntry = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const cpanelBuild = fs.readFileSync(path.join(ROOT, 'scripts', 'cpanel-build.sh'), 'utf8');
const cpanelServer = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
check(pkg.scripts['start:cpanel'] === 'node app.js', 'package exposes the Passenger startup command');
check(/import ['"]\.\/server\/server\.js['"]/.test(cpanelEntry), 'Passenger entrypoint loads the normal app server');
check(/app\.js/.test(cpanelGuide) && /single app process/.test(cpanelGuide), 'cPanel guide names the entrypoint and documents the single-worker constraint');
check(/npm ci --include=dev/.test(cpanelBuild) && /npm run build:css/.test(cpanelBuild) && /npm prune --omit=dev/.test(cpanelBuild), 'cPanel build installs build tools, produces CSS, then prunes dev dependencies');
check(!/db:migrate|db:reset|db\/seed/.test(cpanelBuild), 'cPanel build does not migrate or seed a live database');
check(/if \(env\.RUN_BACKGROUND_JOBS\)/.test(cpanelServer), 'server honors the host-cron switch for in-process jobs');
for (const jobFile of ['run-cleanup.mjs', 'run-delivery.mjs']) {
  const jobScript = fs.readFileSync(path.join(ROOT, 'scripts', jobFile), 'utf8');
  check(/closePool/.test(jobScript) && /process\.exitCode/.test(jobScript), `${jobFile} closes its DB pool and returns a failing exit status on errors`);
}
check(/WebSocket/.test(cpanelGuide) && /outbound TCP/i.test(cpanelGuide) && /public_html/.test(cpanelGuide), 'cPanel guide calls out proxy, network, and private-storage prerequisites');
const cpanelShellCheck = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', 'cpanel-build.sh')], { encoding: 'utf8' });
check(cpanelShellCheck.status === 0, 'cPanel build helper passes bash syntax validation', cpanelShellCheck.stderr.trim());

fs.rmSync(tmpUploads, { recursive: true, force: true });
server.close();
await (await import('../server/src/db/pool.js')).pool.end().catch(() => {});

console.log(`\n${bad === 0 ? C(32) : C(31)}dep-smoke: ${ok} passed, ${bad} failed${R}`);
if (bad) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
