import 'dotenv/config';
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

  DB: Object.freeze({
    host: process.env.DB_HOST,
    port: int('DB_PORT', 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    connectionLimit: int('DB_POOL_SIZE', 10),
    socketPath: process.env.DB_SOCKET || undefined
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
