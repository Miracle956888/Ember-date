import { env } from '../config/env.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const active = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;

const COLORS = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  debug: '\u001b[90m',
  reset: '\u001b[0m'
};

/**
 * Keys whose values are credentials or credential-bearing URLs. Logging one
 * hands an account to anyone who can read the logs (aggregators, sidecars,
 * support tooling, a leaked dump), which silently defeats the `!env.isProd`
 * gate on the API response. Redaction lives here rather than at the call site
 * so a future log line cannot reintroduce the leak.
 */
const SECRET_KEYS = /^(code|token|link|password|secret|otp|resetToken|devCode|devResetToken|accessToken|refreshToken|authorization|cookie)$/i;

/** Strip credentials from a `?token=`-style URL while keeping it readable. */
function redactUrl(value) {
  if (typeof value !== 'string' || !/[?&](token|code|otp)=/i.test(value)) return value;
  return value.replace(/([?&](?:token|code|otp)=)[^&\s]+/gi, '$1[redacted]');
}

/** Recursively redact secret-valued keys. Depth-capped; cycle-safe. */
function redact(meta, depth = 0, seen = new WeakSet()) {
  if (typeof meta === 'string') return redactUrl(meta);
  if (!meta || typeof meta !== 'object' || depth > 4) return meta;
  if (seen.has(meta)) return '[circular]';
  seen.add(meta);
  if (Array.isArray(meta)) return meta.map((v) => redact(v, depth + 1, seen));
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'string') out[k] = redactUrl(v);
    else out[k] = redact(v, depth + 1, seen);
  }
  return out;
}

/**
 * `JSON.stringify` throws on a circular object. Inside a logger that is fatal:
 * an error path logging a request, socket or cyclic `cause` would crash the
 * process instead of recording the problem. Never let logging be the failure.
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (_k, v) => {
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      });
    } catch {
      return '[unserialisable meta]';
    }
  }
}

function emit(level, msg, rawMeta) {
  if (LEVELS[level] > active) return;
  const meta = redact(rawMeta);
  const time = new Date().toISOString();
  if (env.isProd) {
    // Structured JSON lines for log shippers.
    const line = safeStringify({ time, level, msg, ...(meta && typeof meta === 'object' ? meta : meta === undefined ? {} : { meta }) });
    process.stdout.write(`${line}\n`);
    return;
  }
  const color = COLORS[level] || '';
  const metaStr = meta === undefined ? '' : ` ${typeof meta === 'string' ? meta : safeStringify(meta)}`;
  process.stdout.write(`${color}${time} ${level.toUpperCase().padEnd(5)}${COLORS.reset} ${msg}${metaStr}\n`);
}

export const logger = {
  error: (msg, meta) => emit('error', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  debug: (msg, meta) => emit('debug', msg, meta),
  child(scope) {
    return {
      error: (msg, meta) => emit('error', `[${scope}] ${msg}`, meta),
      warn: (msg, meta) => emit('warn', `[${scope}] ${msg}`, meta),
      info: (msg, meta) => emit('info', `[${scope}] ${msg}`, meta),
      debug: (msg, meta) => emit('debug', `[${scope}] ${msg}`, meta)
    };
  }
};

export default logger;
