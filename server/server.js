import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { env } from './src/config/env.js';
import { logger } from './src/utils/logger.js';
import { AppError } from './src/utils/errors.js';
import { assertDbConnection, closePool } from './src/db/pool.js';
import { storage } from './src/services/storage.service.js';
import { checkFfmpeg } from './src/services/upload.service.js';
import { globalLimiter } from './src/middleware/rateLimit.js';
import { requireAuth } from './src/middleware/auth.js';
import { resetAllPresence } from './src/services/auth.service.js';

import authRoutes from './src/routes/auth.routes.js';
import userRoutes from './src/routes/user.routes.js';
import swipeRoutes from './src/routes/swipe.routes.js';
import matchRoutes from './src/routes/match.routes.js';
import messageRoutes from './src/routes/message.routes.js';
import uploadRoutes from './src/routes/upload.routes.js';
import discoveryRoutes from './src/routes/discovery.routes.js';
import likeRoutes from './src/routes/like.routes.js';
import notificationRoutes from './src/routes/notification.routes.js';
import deviceRoutes from './src/routes/device.routes.js';
import { momentRoutes, postRoutes, commentRoutes, reportRoutes } from './src/routes/social.routes.js';
import { adminRoutes } from './src/routes/admin.routes.js';
import { serveMedia, serveSocialMedia } from './src/controllers/upload.controller.js';
import { servePhoto } from './src/controllers/user.controller.js';
import { iceServers } from './src/controllers/message.controller.js';

import { initSockets, closeSockets } from './src/sockets/index.js';
import { startCleanupJob, stopCleanupJob } from './src/jobs/cleanup.js';

const log = logger.child('server');
const app = express();

if (env.TRUST_PROXY || env.isProd) app.set('trust proxy', 1);
app.disable('x-powered-by');

// ----------------------------------------------------------------- security
const allowedOrigins = new Set([env.APP_ORIGIN, ...env.EXTRA_ORIGINS]);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline styles drive drag transforms
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        workerSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: env.isProd ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: env.isProd ? { maxAge: 15552000, includeSubDomains: true } : false
  })
);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // same-origin / curl
      if (allowedOrigins.has(origin)) return cb(null, true);
      // Allow the sandbox/LAN preview hosts in non-production only.
      if (!env.isProd && /^https?:\/\/([\w-]+\.)*(localhost|127\.0\.0\.1|e2b\.app|[\d.]+)(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token']
  })
);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser());

// Permissions-Policy so the browser allows camera/mic on our own origin.
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

// ------------------------------------------------------------ request logs
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/socket.io')) return;
    const ms = Date.now() - started;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode}`, { ms });
  });
  next();
});

// --------------------------------------------------------------- API routes
app.get('/api/health', async (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSecs: Math.round(process.uptime()),
    ttlHours: env.MESSAGE_TTL_HOURS,
    time: new Date().toISOString()
  });
});

app.use('/api', globalLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/swipes', swipeRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/conversations', messageRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/discovery', discoveryRoutes);
app.use('/api/likes', likeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/moments', momentRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);
app.get('/api/media/:id', requireAuth, serveMedia);
app.get('/api/social-media/:name', requireAuth, serveSocialMedia);
app.get('/api/photos/:filename', requireAuth, servePhoto);
app.get('/api/ice-servers', requireAuth, iceServers);

// ----------------------------------------------------------- static frontend
const staticOptions = {
  etag: true,
  maxAge: env.isProd ? '1h' : 0,
  // '/' must fall through to the themed page route below, not be served
  // straight off disk (which would skip the dark-mode class).
  index: false,
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    if (/\.(woff2?|css|js)$/.test(filePath) && env.isProd) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
};
app.use(express.static(env.PUBLIC_DIR, staticOptions));

// Pretty URLs: /app -> /app.html
//
// Pages are sent through a tiny transform that stamps the user's saved theme
// onto <html> before the first byte reaches the browser. A strict CSP
// (script-src 'self') rules out the usual inline anti-FOUC snippet, so the
// class is applied server-side instead -- no flash of white on a dark reload.
const PAGES = [
  'index', 'login', 'register', 'app', 'matches', 'chats', 'chat', 'call',
  'profile', 'nearby', 'likes', 'settings', 'u', 'moments', 'admin'
];
const pageCache = new Map();

function readPage(file) {
  if (!env.isProd) return fs.promises.readFile(file, 'utf8');
  if (!pageCache.has(file)) pageCache.set(file, fs.promises.readFile(file, 'utf8'));
  return pageCache.get(file);
}

function prefersDark(req) {
  const mode = req.cookies?.ec_theme;
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  // 'system' or unset: honour the Client Hint when the browser sends one.
  return req.get('Sec-CH-Prefers-Color-Scheme') === 'dark';
}

export function sendPage(file, req, res, next) {
  readPage(file)
    .then((html) => {
      res.type('html');
      res.setHeader('Cache-Control', 'no-cache');
      // Ask the browser to send the colour-scheme hint on subsequent requests.
      res.setHeader('Accept-CH', 'Sec-CH-Prefers-Color-Scheme');
      res.setHeader('Vary', 'Cookie, Sec-CH-Prefers-Color-Scheme');
      res.send(prefersDark(req) ? html.replace('<html lang="en">', '<html lang="en" class="dark">') : html);
    })
    .catch(next);
}

for (const page of PAGES) {
  app.get(`/${page === 'index' ? '' : page}`, (req, res, next) => {
    const file = path.join(env.PUBLIC_DIR, `${page}.html`);
    fs.access(file, fs.constants.R_OK, (err) => (err ? next() : sendPage(file, req, res, next)));
  });
}

// Shareable profile URLs: /@handle renders the public profile shell, which
// then fetches /api/users/by-username/:username. Registered after the static
// page loop so it cannot shadow a real page, and kept deliberately strict so
// only valid handle shapes reach it -- anything else falls through to the 404.
app.get('/@:username', (req, res, next) => {
  if (!/^[a-zA-Z0-9._]{3,20}$/.test(req.params.username)) return next();
  const file = path.join(env.PUBLIC_DIR, 'u.html');
  return fs.access(file, fs.constants.R_OK, (err) => (err ? next() : sendPage(file, req, res, next)));
});

// ------------------------------------------------------------------ 404 + err
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: { message: 'Endpoint not found.', code: 'NOT_FOUND' } });
  }
  const notFoundPage = path.join(env.PUBLIC_DIR, '404.html');
  return fs.access(notFoundPage, fs.constants.R_OK, (err) =>
    err ? next() : sendPage(notFoundPage, req, res.status(404), next)
  );
});

app.use((err, req, res, _next) => {
  const status = err instanceof AppError ? err.status : err.status || err.statusCode || 500;
  const safe = err instanceof AppError && err.expose;

  if (status >= 500) {
    log.error('unhandled error', { message: err.message, stack: err.stack, path: req.originalUrl });
  } else {
    log.warn('request error', { message: err.message, status, path: req.originalUrl });
  }

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: { message: 'Origin not allowed.', code: 'CORS' } });
  }

  return res.status(status).json({
    error: {
      message: safe ? err.message : status >= 500 ? 'Something went wrong on our side.' : err.message || 'Request failed.',
      code: err.code || undefined,
      details: safe ? err.details : undefined
    }
  });
});

// ------------------------------------------------------------------ bootstrap
const server = http.createServer(app);

async function start() {
  await assertDbConnection();
  await storage.init();
  await checkFfmpeg();
  await resetAllPresence().catch(() => {});

  initSockets(server);
  startCleanupJob();

  await new Promise((resolve) => server.listen(env.PORT, '0.0.0.0', resolve));
  log.info(`listening on http://0.0.0.0:${env.PORT}`, {
    env: env.NODE_ENV,
    origin: env.APP_ORIGIN,
    ttlHours: env.MESSAGE_TTL_HOURS
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received - shutting down gracefully`);

  const force = setTimeout(() => {
    log.error('forced exit after 15s');
    process.exit(1);
  }, 15_000);
  force.unref();

  try {
    stopCleanupJob();
    await closeSockets();
    await new Promise((resolve) => server.close(resolve));
    await closePool();
    log.info('shutdown complete');
    clearTimeout(force);
    process.exit(0);
  } catch (err) {
    log.error('shutdown error', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: reason?.message || String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: err.message, stack: err.stack });
  shutdown('uncaughtException');
});

start().catch((err) => {
  log.error('failed to start', { error: err.message, stack: err.stack });
  process.exit(1);
});

export { app, server };
