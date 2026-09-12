#!/usr/bin/env node
/**
 * deploy-check.mjs - pre-flight check for running Ember somewhere public.
 *
 *   npm run deploy:check                  # checks the current environment
 *   NODE_ENV=production ... npm run deploy:check -- --offline
 *
 * Every check maps to a failure mode that is invisible in the code and obvious in
 * production: an http:// APP_ORIGIN silently kills the session cookie, an
 * UPLOAD_DIR inside public/ serves private photos to anyone who guesses a URL,
 * FORCE_HTTPS without TRUST_PROXY loops the redirect forever. Fixing those from a
 * browser symptom takes an afternoon; this takes a second.
 *
 * --offline skips the checks that need a database (used by CI).
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const OFFLINE = process.argv.includes('--offline');

const results = [];
const add = (level, name, detail, hint) => results.push({ level, name, detail, hint });
const ok = (n, d) => add('ok', n, d);
const warn = (n, d, h) => add('warn', n, d, h);
const bad = (n, d, h) => add('fail', n, d, h);

/**
 * Colour only for a human at a terminal. Piping into a log, a file or CI gives you
 * plain text with no escape codes to strip - which is also why the smoke test can
 * assert on this output directly.
 */
const PALETTE = process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;
const C = (code) => (PALETTE ? `\x1b[${code}m` : '');
const COLOR = { ok: C(32), warn: C(33), fail: C(31), skip: C(90) };
const LABEL = { ok: ' ok ', warn: 'warn', fail: 'FAIL', skip: 'skip' };

console.log(`\n${C(1)}Ember deploy check${C(0)}${OFFLINE ? ' (offline: DB checks skipped)' : ''}`);

// ------------------------------------------------------------------ config load
/**
 * Mirror of the parts of config/env.js this script reads, used only when env.js
 * refuses to load. The server correctly dies on the FIRST missing variable; a
 * pre-flight tool that does the same is useless, because you fix that one thing,
 * rerun, and hit the next. So: real config when it loads, faithful fallback when
 * it does not, and the refusal itself is reported as a FAIL line below.
 */
function fallbackConfig() {
  const int = (name, fb) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fb;
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? fb : n;
  };
  const bool = (name) => process.env[name] === '1' || process.env[name] === 'true';
  const uploadDirRaw = process.env.UPLOAD_DIR || './uploads';
  return {
    NODE_ENV: process.env.NODE_ENV || 'development',
    isProd: process.env.NODE_ENV === 'production',
    PORT: int('PORT', 3000),
    APP_ORIGIN: process.env.APP_ORIGIN ?? '',
    TRUST_PROXY: bool('TRUST_PROXY'),
    FORCE_HTTPS: bool('FORCE_HTTPS'),
    JWT: {
      accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
      refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
      accessTtl: process.env.JWT_ACCESS_TTL || '15m',
      refreshTtl: process.env.JWT_REFRESH_TTL || '7d'
    },
    DB: {
      host: process.env.DB_HOST ?? '',
      port: int('DB_PORT', 3306),
      user: process.env.DB_USER ?? '',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_NAME ?? ''
    },
    MESSAGE_TTL_HOURS: int('MESSAGE_TTL_HOURS', 24),
    MAX_IMAGE_MB: int('MAX_IMAGE_MB', 10),
    MAX_VIDEO_MB: int('MAX_VIDEO_MB', 50),
    UPLOAD_DIR: path.isAbsolute(uploadDirRaw) ? uploadDirRaw : path.resolve(ROOT, uploadDirRaw),
    PUBLIC_DIR: path.join(ROOT, 'public'),
    TURN: {
      url: process.env.TURN_URL || '',
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    },
    CLEANUP_CRON: process.env.CLEANUP_CRON || '*/5 * * * *'
  };
}

let env = null;
try {
  ({ env } = await import('../server/src/config/env.js'));
} catch (err) {
  env = fallbackConfig();
  add('fail', 'config/env.js refused to boot', String(err.message).replace(/^\[env\]\s*/, ''), 'every line below is still checked against this same broken config, so you see all of it at once');
}

const prod = env.isProd;
const usedFallback = results.some((r) => r.name.startsWith('config/env.js'));
if (!usedFallback) {
  ok(`config loaded from ${fs.existsSync(path.join(ROOT, '.env')) ? '.env + process env' : 'process env'}`, `NODE_ENV=${env.NODE_ENV}`);
}

// ------------------------------------------------------------------ node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`node ${process.versions.node}`, 'meets engines.node >=20');
else bad(`node ${process.versions.node}`, 'below engines.node >=20', 'the app uses undici/fetch and structuredClone features from 20+');

// ------------------------------------------------------------------ origin + tls
let originUrl = null;
try {
  originUrl = new URL(env.APP_ORIGIN);
} catch {
  bad('APP_ORIGIN', `not a valid URL: "${env.APP_ORIGIN}"`, 'must be the exact public origin, e.g. https://ember.example.com');
}
if (originUrl) {
  if (originUrl.protocol === 'https:') {
    ok('APP_ORIGIN scheme', 'https - Secure cookies and HSTS are meaningful here');
  } else if (prod) {
    bad('APP_ORIGIN https', `${originUrl.protocol}// in production`, 'cookies are Secure in production, so an http origin means nobody can ever log in');
  } else {
    warn('APP_ORIGIN scheme', 'http while NODE_ENV is not production', 'fine on a laptop; the deployed host must be https');
  }
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(originUrl.host) && prod) {
    bad('APP_ORIGIN host', `points at ${originUrl.host} in production`, 'browsers will send the API requests to themselves, not your server');
  } else {
    ok('APP_ORIGIN host', originUrl.host);
  }
  if (originUrl.port && prod) warn('APP_ORIGIN port', `non-standard port ${originUrl.port}`, 'behind Caddy/Nginx/Traefik the public port should be 443 and omitted');
  if (originUrl.pathname !== '/' && originUrl.pathname !== '') {
    bad('APP_ORIGIN path', `has a path ("${originUrl.pathname}")`, 'must be an origin only - a path here breaks the CORS match for every request');
  }
}

// ------------------------------------------------------------------ secrets
function judgeSecret(name, value) {
  if (!value) return prod ? bad(name, 'missing in production', 'generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"') : warn(name, 'unset (a random one is generated per boot)', 'every restart logs everyone out; set it for anything long-lived');
  if (value.length < 32) return bad(name, `${value.length} chars`, 'env.js refuses to boot in production below 32; use 32 random bytes hex');
  if (/^(.)\1+$/.test(value)) return bad(name, 'one repeated character', 'looks like a placeholder - generate a real secret');
  if (/your|changeme|secret|replace|dev|test/i.test(value) && !prod) return warn(name, 'looks like a placeholder', 'do not ship this to a public host');
  if (/your|changeme|secret|replace/i.test(value)) return bad(name, 'looks like a placeholder', 'tokens could be forged by anyone who reads the docs');
  return ok(name, `${value.length} chars`);
}
judgeSecret('JWT_ACCESS_SECRET', env.JWT.accessSecret);
judgeSecret('JWT_REFRESH_SECRET', env.JWT.refreshSecret);
if (env.JWT.accessSecret && env.JWT.accessSecret === env.JWT.refreshSecret) {
  bad('JWT secret reuse', 'access and refresh secrets are identical', 'a refresh token becomes a valid access token; use two different secrets');
} else if (env.JWT.accessSecret) {
  ok('JWT secret separation', 'access and refresh differ');
}
if (prod && !env.DB.password) bad('DB_PASSWORD', 'empty in production', 'a public MySQL without a password is an open database');
if (!prod && !env.DB.password) warn('DB_PASSWORD', 'empty (dev default)', 'set one for any host that can be reached from outside');

// ------------------------------------------------------------------ proxy / https
if (env.FORCE_HTTPS) {
  if (!(env.TRUST_PROXY || prod)) {
    bad('FORCE_HTTPS without TRUST_PROXY', 'would loop every request forever', 'the app cannot see the upstream TLS termination; set TRUST_PROXY=1 or drop FORCE_HTTPS');
  } else {
    ok('FORCE_HTTPS', 'http requests will be upgraded (301 GET / 308 other), /api/health and /socket.io exempt');
  }
} else {
  warn('FORCE_HTTPS off', 'plain http is served as-is', 'harmless if your proxy already redirects; otherwise set FORCE_HTTPS=1 so passwords never travel unencrypted');
}
if (env.TRUST_PROXY || prod) ok('trust proxy', 'X-Forwarded-* honoured - rate limiting sees real client IPs, not the proxy');
else warn('trust proxy off', 'rate limits will count the proxy IP as one client', 'set TRUST_PROXY=1 behind any reverse proxy');
if (prod) {
  ok('cookies', `httpOnly + SameSite=lax + Secure (production) - access ${env.JWT.accessTtl}, refresh ${env.JWT.refreshTtl}`);
} else {
  warn('cookies', `Secure flag is off while NODE_ENV=${env.NODE_ENV}`, 'expected on a laptop; a public host must run NODE_ENV=production or sessions are sent in the clear');
}

// ------------------------------------------------------------------ uploads
const uploadInsidePublic = path.resolve(env.UPLOAD_DIR).startsWith(path.resolve(env.PUBLIC_DIR) + path.sep);
if (uploadInsidePublic) {
  bad('UPLOAD_DIR inside public/', env.UPLOAD_DIR, 'private media would be served by the static handler, skipping the owner-or-participant check in serveMedia');
} else {
  ok('UPLOAD_DIR isolated', `${env.UPLOAD_DIR} is not under ${env.PUBLIC_DIR}`);
}
try {
  fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
  fs.accessSync(env.UPLOAD_DIR, fs.constants.W_OK);
  const probe = path.join(env.UPLOAD_DIR, `.deploy-check-${process.pid}`);
  fs.writeFileSync(probe, 'x');
  fs.rmSync(probe, { force: true });
  ok('UPLOAD_DIR writable', env.UPLOAD_DIR);
} catch (err) {
  bad('UPLOAD_DIR not writable', err.message, 'the container runs as node (uid 1000): chown the volume, or mount a volume at /app/uploads');
}
if (prod && fs.existsSync(path.join(env.UPLOAD_DIR, '..', '.git'))) {
  warn('uploads dir next to repo root', 'consider a dedicated volume', 'uploads are the only stateful path; a rebuild without a volume deletes every file');
}
if (env.MAX_IMAGE_MB > 25 || env.MAX_VIDEO_MB > 200) {
  warn('upload caps', `image ${env.MAX_IMAGE_MB}MB / video ${env.MAX_VIDEO_MB}MB`, 'large caps on a public host invite storage abuse; your proxy must also accept that body size');
} else {
  ok('upload caps', `image ${env.MAX_IMAGE_MB}MB / video ${env.MAX_VIDEO_MB}MB`);
}

// ------------------------------------------------------------------ ttl + cron
if (!Number.isFinite(env.MESSAGE_TTL_HOURS) || env.MESSAGE_TTL_HOURS <= 0) {
  bad('MESSAGE_TTL_HOURS', String(env.MESSAGE_TTL_HOURS), 'the whole product promise is disappearing messages - must be > 0');
} else if (env.MESSAGE_TTL_HOURS > 168) {
  warn('MESSAGE_TTL_HOURS', `${env.MESSAGE_TTL_HOURS}h`, 'longer than the 7d ceiling the UI offers; reads oddly next to "24 hours" in the copy');
} else {
  ok('MESSAGE_TTL_HOURS', `${env.MESSAGE_TTL_HOURS}h`);
}
const cronMod = await import('node-cron');
const cron = cronMod.default ?? cronMod;
if (cron.validate(env.CLEANUP_CRON)) ok('CLEANUP_CRON', `"${env.CLEANUP_CRON}" is valid - expiry actually deletes, not just hides`);
else bad('CLEANUP_CRON', `"${env.CLEANUP_CRON}" is not a valid expression`, 'cleanup falls back to */5 * * * *; expired rows would otherwise linger until then');

// ------------------------------------------------------------------ media extras
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  ok('ffmpeg', 'video poster frames will be real frames');
} catch {
  warn('ffmpeg missing', 'video posters fall back to the branded placeholder', 'apt install ffmpeg (or it is already in the shipped Docker image)');
}
if (env.TURN.url) {
  if (env.TURN.username && env.TURN.credential) ok('TURN', env.TURN.url);
  else bad('TURN half-configured', 'TURN_URL set but no username/credential', 'clients will fail authentication against the relay and cross-network calls will not connect');
} else {
  warn('TURN not configured', 'video/voice calls only work on the same LAN', 'deploy coturn and set TURN_URL/TURN_USERNAME/TURN_CREDENTIAL for calls over the internet');
}

// ------------------------------------------------------------------ db (skipped offline)
if (OFFLINE) {
  add('skip', 'database', 'not checked (--offline)');
} else {
  await new Promise((resolve) => {
    const sock = net.connect({ host: env.DB.host, port: env.DB.port, timeout: 4000 });
    const finish = (r, d, h) => {
      add(r, 'database reachable', d, h);
      sock.destroy();
      resolve();
    };
    sock.on('connect', () => finish('ok', `${env.DB.host}:${env.DB.port} accepts TCP`));
    sock.on('timeout', () => finish('fail', `${env.DB.host}:${env.DB.port} timed out`, 'is MySQL listening, and does a firewall/security group block 3306?'));
    sock.on('error', (err) =>
      err.code === 'ECONNREFUSED'
        ? finish('fail', `${env.DB.host}:${env.DB.port} refused`, 'start it: docker compose up -d db, or point DB_HOST at your managed MySQL')
        : finish('fail', `${env.DB.host}:${env.DB.port}: ${err.code || err.message}`, 'check DB_HOST/DB_PORT and the provider allowlist')
    );
  });

  // Only talk SQL if the port answered.
  if (results.find((r) => r.name === 'database reachable' && r.level === 'ok')) {
    try {
      const { pool } = await import('../server/src/db/pool.js');
      const [rows] = await pool.query('SELECT VERSION() AS v, CURRENT_USER() AS u');
      const info = Array.isArray(rows) ? rows[0] : rows;
      ok('database login', `${info.u} on ${info.v}`);
      const [tbls] = await pool.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()'
      );
      const n = Number(Array.isArray(tbls) ? tbls[0].n : tbls.n);
      if (n >= 30) ok('schema applied', `${n} tables present`);
      else bad('schema looks empty', `${n} tables in ${env.DB.database}`, 'run: node db/migrate.js');
      try {
        const [demo] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@example.com'");
        const demoCount = Number(Array.isArray(demo) ? demo[0].n : demo.n);
        if (demoCount > 0) {
          if (prod) {
            bad('demo accounts on a production host', `${demoCount} users still carry @example.com emails`, 'they all share the password printed in README.md. Delete them: DELETE FROM users WHERE email LIKE \'%@example.com\';');
          } else {
            warn('demo accounts present', `${demoCount} @example.com users`, 'expected locally; remove before this host is public');
          }
        } else {
          ok('no demo accounts', 'no @example.com users');
        }
      } catch {
        warn('users table unreadable', 'could not check for demo accounts', 'run node db/migrate.js first');
      }
      await pool.end().catch(() => {});
    } catch (err) {
      bad('database query failed', err.message, 'migrate as the same DB_USER the app uses, or grant it DDL');
    }
  }
}

// ------------------------------------------------------------------ db transport
// A compose/localhost database sits on a private network; anything else crosses
// the public internet and carries your DB password on every reconnect.
// Exact names only, not prefixes: an unanchored /^db/ would have let
// "db.prod.example.com" pass as private and skipped the TLS warning entirely.
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'db', 'mysql', 'mariadb', 'host.docker.internal']);
const dbHost = (env.DB.host || '').toLowerCase();
const privateHost =
  LOCAL_DB_HOSTS.has(dbHost) ||
  /^(10|127)\./.test(dbHost) ||
  /^192\.168\./.test(dbHost) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(dbHost) ||
  // a unix socket never touches the network
  Boolean(process.env.DB_SOCKET);
if (env.DB.ssl) {
  ok('DB TLS', `on (rejectUnauthorized=${env.DB.ssl.rejectUnauthorized !== false}${env.DB.ssl.ca ? ', provider CA loaded' : ', system CAs'})`);
  if (env.DB.ssl.rejectUnauthorized === false) {
    warn('DB TLS without verification', 'rejectUnauthorized is off', 'the connection is encrypted but anyone in the middle can impersonate your database; set DB_SSL_CA to the provider bundle instead');
  }
} else if (privateHost) {
  ok('DB transport', `${env.DB.host || 'unset'} looks private - no TLS needed`);
} else if (prod) {
  bad('DB TLS off to a remote host', `DB_HOST=${env.DB.host || '(unset)'} with no DB_SSL`, 'set DB_SSL=true (plus DB_SSL_CA if the provider supplies a bundle); managed MySQL rejects plaintext anyway');
} else {
  warn('DB TLS off to a remote host', `DB_HOST=${env.DB.host}`, 'fine over VPN; set DB_SSL=true on anything crossing the open internet');
}

// ------------------------------------------------------------------ seed policy
if (process.env.SEED_DEMO === '1') {
  if (prod) {
    if (process.env.DEMO_PASSWORD && process.env.DEMO_PASSWORD !== 'Password123!') {
      warn('SEED_DEMO=1 on a production host', 'demo accounts will be created with your DEMO_PASSWORD', 'they clear real rows first (clearData) - be sure this host has no live users');
    } else {
      bad('SEED_DEMO=1 without a private DEMO_PASSWORD', 'db/seed.js will refuse, as it should', 'never publish the demo password on a host people use');
    }
  } else {
    ok('SEED_DEMO', 'dev opt-in set');
  }
} else if (prod) {
  ok('demo seeding disabled', 'production refuses to seed unless SEED_DEMO=1 is set');
} else {
  add('skip', 'SEED_DEMO', 'unset (fine for local development)');
}

// ------------------------------------------------------------------ report
console.log('');
for (const r of results) {
  const c = COLOR[r.level] ?? '';
  const reset = PALETTE ? C(0) : '';
  console.log(`  ${c}${LABEL[r.level]}${reset}  ${r.name}${r.detail ? `\n         ${r.detail}` : ''}${r.hint ? `\n         ${COLOR.skip}> ${r.hint}${reset}` : ''}`);
}
const fails = results.filter((r) => r.level === 'fail');
const warns = results.filter((r) => r.level === 'warn');
const tone = fails.length ? COLOR.fail : warns.length ? COLOR.warn : COLOR.ok;
const okCount = results.filter((r) => r.level === 'ok').length;
console.log(`\n${tone}${fails.length} blocking, ${warns.length} warning(s), ${okCount} ok${C(0)}\n`);
if (fails.length) console.log('  Fix the FAIL lines before pointing people at this URL.\n');
process.exitCode = fails.length ? 1 : 0;
