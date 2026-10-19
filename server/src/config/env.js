import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '../../..');

const isProd = process.env.NODE_ENV === 'production';

/** Vars that MUST be present. In non-production we auto-fill secrets for DX. */
const REQUIRED = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'APP_ORIGIN'];
const REQUIRED_PROD = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'DB_PASSWORD'];

function missing(keys) {
  return keys.filter((k) => {
    const v = process.env[k];
    return v === undefined || v === null || String(v).trim() === '';
  });
}

const missingBase = missing(REQUIRED);
if (missingBase.length) {
  throw new Error(
    `[env] Missing required environment variables: ${missingBase.join(', ')}. ` +
      'Copy .env.example to .env and fill it in.'
  );
}

if (isProd) {
  const missingProd = missing(REQUIRED_PROD);
  if (missingProd.length) {
    throw new Error(`[env] Missing required production environment variables: ${missingProd.join(', ')}`);
  }
  if (String(process.env.JWT_ACCESS_SECRET).length < 32 || String(process.env.JWT_REFRESH_SECRET).length < 32) {
    throw new Error('[env] JWT secrets must be at least 32 characters in production.');
  }
} else {
  if (!process.env.JWT_ACCESS_SECRET) {
    process.env.JWT_ACCESS_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[env] JWT_ACCESS_SECRET not set - generated an ephemeral dev secret.');
  }
  if (!process.env.JWT_REFRESH_SECRET) {
    process.env.JWT_REFRESH_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[env] JWT_REFRESH_SECRET not set - generated an ephemeral dev secret.');
  }
}

/**
 * Load one or more trusted CA certificates without ever weakening TLS checks.
 * `DB_SSL_CA_BASE64` is intended for Render: it carries the PEM file as a
 * single-line environment variable, so no certificate has to be baked into the
 * image. `DB_SSL_CA` remains available for a PEM file mounted inside the runtime.
 */
function loadDbCa() {
  const caPath = (process.env.DB_SSL_CA || '').trim();
  const caBase64 = (process.env.DB_SSL_CA_BASE64 || '').trim();
  if (caPath && caBase64) {
    throw new Error('[env] Set only one of DB_SSL_CA (mounted PEM path) or DB_SSL_CA_BASE64 (base64 PEM).');
  }
  if (!caPath && !caBase64) return null;

  let pemBytes;
  let source;
  if (caBase64) {
    const compact = caBase64.replace(/\s+/g, '');
    if (compact.length > 131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
      throw new Error('[env] DB_SSL_CA_BASE64 must be standard base64-encoded PEM certificate data.');
    }
    pemBytes = Buffer.from(compact, 'base64');
    const canonical = pemBytes.toString('base64').replace(/=+$/, '');
    if (!pemBytes.length || canonical !== compact.replace(/=+$/, '')) {
      throw new Error('[env] DB_SSL_CA_BASE64 is not valid base64-encoded PEM certificate data.');
    }
    source = 'DB_SSL_CA_BASE64';
  } else {
    const resolvedCaPath = path.isAbsolute(caPath) ? caPath : path.resolve(ROOT_DIR, caPath);
    if (!fs.existsSync(resolvedCaPath) || !fs.statSync(resolvedCaPath).isFile()) {
      throw new Error(`[env] DB_SSL_CA file does not exist inside this runtime: ${resolvedCaPath}`);
    }
    pemBytes = fs.readFileSync(resolvedCaPath);
    source = 'DB_SSL_CA';
  }

  const pem = pemBytes.toString('utf8').replace(/\r\n/g, '\n').trim();
  const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
  const certificates = pem.match(certificatePattern) || [];
  const remainder = pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim();
  if (!certificates.length || remainder) {
    throw new Error(`[env] ${source} must contain one or more PEM-encoded CA certificates.`);
  }

  for (const [index, certificatePem] of certificates.entries()) {
    let certificate;
    try {
      certificate = new crypto.X509Certificate(certificatePem);
    } catch {
      throw new Error(`[env] ${source} contains an invalid X.509 certificate at block ${index + 1}.`);
    }
    if (!certificate.ca) {
      throw new Error(`[env] ${source} certificate block ${index + 1} is not a CA certificate.`);
    }
  }

  return certificates.map((certificatePem) => Buffer.from(`${certificatePem}\n`, 'utf8'));
}

/**
 * Database TLS policy.
 *
 * Local Compose/localhost connections may remain plaintext. Remote databases
 * require TLS; Aiven hosts additionally require the project CA so Node can build
 * a trusted chain. The mysql2 driver is configured to verify both that chain
 * and the DB_HOST identity. There is deliberately no insecure override.
 */
function dbSsl() {
  const raw = (process.env.DB_SSL || '').trim().toLowerCase();
  const enabled = ['1', 'true', 'yes', 'on'].includes(raw);
  const disabled = ['', '0', 'false', 'no', 'off'].includes(raw);
  if (!enabled && !disabled) {
    throw new Error('[env] DB_SSL must be true or false.');
  }

  const rejectSetting = (process.env.DB_SSL_REJECT_UNAUTHORIZED || '').trim().toLowerCase();
  if (rejectSetting && !['1', 'true', 'yes', 'on'].includes(rejectSetting)) {
    throw new Error('[env] Certificate verification cannot be disabled; remove DB_SSL_REJECT_UNAUTHORIZED or set it to true and install the provider CA.');
  }

  const ca = loadDbCa();
  const dbHost = (process.env.DB_HOST || '').trim().toLowerCase();
  const isAivenHost = dbHost === 'aivencloud.com' || dbHost.endsWith('.aivencloud.com');

  if (!enabled) {
    if (ca) throw new Error('[env] DB_SSL_CA/DB_SSL_CA_BASE64 requires DB_SSL=true.');
    if (isAivenHost) throw new Error('[env] Aiven MySQL requires DB_SSL=true and its project CA certificate.');
    return undefined;
  }

  if (isAivenHost && !ca) {
    throw new Error('[env] Aiven MySQL requires its project CA: set DB_SSL_CA_BASE64 in the host environment or mount a PEM file and set DB_SSL_CA.');
  }

  return {
    rejectUnauthorized: true,
    verifyIdentity: true,
    ...(ca ? { ca } : {})
  };
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`[env] ${name} must be an integer, got "${raw}"`);
  return n;
}

const uploadDirRaw = process.env.UPLOAD_DIR || './uploads';

export const env = Object.freeze({
  NODE_ENV: process.env.NODE_ENV || 'development',
  isProd,
  isTest: process.env.NODE_ENV === 'test',
  PORT: int('PORT', 3000),
  APP_ORIGIN: process.env.APP_ORIGIN,
  // Extra origins allowed by CORS (comma separated). Handy for LAN / preview hosts.
  EXTRA_ORIGINS: (process.env.EXTRA_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  TRUST_PROXY: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  // 301 http -> https using the proxy's X-Forwarded-Proto. Off by default so a
  // plain-HTTP LAN box or container health check never loops; on for public hosts.
  FORCE_HTTPS: process.env.FORCE_HTTPS === '1' || process.env.FORCE_HTTPS === 'true',

  DB: Object.freeze({
    host: process.env.DB_HOST,
    port: int('DB_PORT', 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    connectionLimit: int('DB_POOL_SIZE', 10),
    socketPath: process.env.DB_SOCKET || undefined,
    ssl: dbSsl()
  }),

  JWT: Object.freeze({
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '7d',
    accessCookieMaxAge: 15 * 60 * 1000,
    refreshCookieMaxAge: 7 * 24 * 60 * 60 * 1000
  }),

  MESSAGE_TTL_HOURS: int('MESSAGE_TTL_HOURS', 24),
  MAX_IMAGE_MB: int('MAX_IMAGE_MB', 10),
  MAX_VIDEO_MB: int('MAX_VIDEO_MB', 50),
  UPLOAD_DIR: path.isAbsolute(uploadDirRaw) ? uploadDirRaw : path.resolve(ROOT_DIR, uploadDirRaw),
  PUBLIC_DIR: path.resolve(ROOT_DIR, 'public'),

  SMTP: Object.freeze({
    host: (process.env.SMTP_HOST || '').trim(),
    port: int('SMTP_PORT', 587),
    secure: process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: (process.env.SMTP_FROM || '').trim(),
    configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM)
  }),
  TWILIO: Object.freeze({
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER)
  }),

  TURN: Object.freeze({
    url: process.env.TURN_URL || '',
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || ''
  }),

  CLEANUP_CRON: process.env.CLEANUP_CRON || '*/5 * * * *',
  LOG_LEVEL: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug')
});

export const COOKIE = Object.freeze({
  access: 'ec_at',
  refresh: 'ec_rt',
  csrf: 'ec_csrf'
});

export function cookieOptions(maxAge, { httpOnly = true } = {}) {
  return {
    httpOnly,
    secure: env.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge
  };
}

export default env;
