# Deploying Ember-date on cPanel

This repository includes a cPanel/Phusion Passenger startup entry, a CSS/runtime
build helper, and optional cron entrypoints. This is a supported deployment path
only on cPanel plans that provide the required Node.js and proxy features; the
name “cPanel” by itself does not guarantee them.

## Check the hosting plan first

Ask the provider to confirm all of the following before moving a production
site:

- **Node.js Application Manager (Passenger)** with Node.js 20 or 22 and npm.
  Ember-date is not a PHP-only application and cannot run on a plan that lacks a
  persistent Node.js application feature.
- Permission to install the locked npm dependencies, including the native
  `sharp` package, and enough memory, CPU, process time, and disk for the app.
- HTTPS termination that forwards the original scheme correctly. Socket.IO
  polling must pass through; WebSocket upgrade support is needed for the best
  real-time chat/call signalling behavior.
- Outbound TCP access from the account to the configured MySQL endpoint (for
  example, Aiven), and a database account with the privileges needed for the
  reviewed migrations.
- A **single app process/worker** for this release. Presence and Socket.IO rooms
  are kept in process memory; multi-worker Passenger deployments are not
  coordinated by Redis or another shared adapter.
- A writable, persistent private directory for uploads. Back it up separately
  from MySQL and keep it outside `public_html`.

If the plan cannot meet these requirements, cPanel configuration alone cannot
remove the limitation. Use a Node-capable VPS or managed app host instead. Do
not point a real domain or populated database at the app until the release and
backup gates in [DEPLOY.md](DEPLOY.md) have been completed.

## 1. Create the Node application

1. Keep the Git checkout/application root outside the website document root,
   for example `/home/CPANELUSER/apps/ember-date`. Use cPanel Git Version Control
   or another trusted deployment method; do not copy the project into
   `public_html`.
2. In **Setup Node.js App** (the label may differ by cPanel version), create an
   application using Node.js 20 or 22. Set its application root to the checkout
   and attach a dedicated domain or subdomain at its root, such as
   `https://app.example.com`. This app uses root-relative URLs and is not
   configured to live under a URL prefix such as `/ember-date`.
3. Set the startup file to **`app.js`**. Let cPanel assign/manage `PORT`; do not
   hard-code a public listening port. The entrypoint loads the normal server,
   which binds to the cPanel-provided port.
4. In Terminal, run the activation command shown by cPanel for this application
   before running Node/npm commands. It selects the same Node runtime used by
   Passenger.

## 2. Configure secrets, database, and private storage

Create the production configuration in a permission-restricted `.env` file in
the application root (outside `public_html`), or use cPanel's secret environment
settings for the web process. The cron option below also needs the same settings;
Passenger environment variables are **not automatically inherited by cPanel
Cron Jobs**. If using cron, keep the shared values in the protected `.env` file
or explicitly load them in each cron command.

At minimum, configure:

```dotenv
NODE_ENV=production
APP_ORIGIN=https://app.example.com
TRUST_PROXY=1
FORCE_HTTPS=1

DB_HOST=your-mysql-hostname
DB_PORT=3306
DB_NAME=your_database
DB_USER=your_least_privilege_user
DB_PASSWORD=your_database_password
DB_SSL=true
DB_SSL_CA=/home/CPANELUSER/private/aiven-ca.pem

JWT_ACCESS_SECRET=replace-with-a-private-random-value-at-least-32-characters
JWT_REFRESH_SECRET=another-private-random-value-at-least-32-characters
UPLOAD_DIR=/home/CPANELUSER/ember-date-data/uploads
RUN_BACKGROUND_JOBS=true
```

Replace every example value. `APP_ORIGIN` must be the exact public HTTPS origin,
without a path. Confirm with the provider that `TRUST_PROXY=1` and
`FORCE_HTTPS=1` match its HTTPS proxy headers; test redirects before launch.
Leave `PORT` to cPanel.

For Aiven MySQL, download the **project CA** from the Aiven service and save it
as a private PEM file outside the application and web roots. Restrict its file
permissions to the account, set `DB_SSL=true`, and set `DB_SSL_CA` to its
absolute path. `DB_SSL_CA_BASE64` is an alternative if the hosting secret store
supports it. The application verifies the CA chain and database hostname; do
not set `DB_SSL_REJECT_UNAUTHORIZED=false` or otherwise disable TLS checks. Run
`npm run db:ping` before any migration to prove this cPanel runtime can reach the
configured database.

Create the upload directory and ensure it is writable by the cPanel account:

```sh
mkdir -p /home/CPANELUSER/ember-date-data/uploads
```

Keep it outside `public_html`, the Git checkout, and any directory that a deploy
or cleanup process replaces. The application serves protected media through
authenticated routes; do not expose the storage directory as a static website.

Protect `.env` (for example, mode `600`) and the CA file. Do not commit, paste,
or log their contents. Configure SMTP/Twilio only with provider-approved
credentials if those flows are enabled. Keep JWT secrets stable across restarts;
rotating `JWT_REFRESH_SECRET` invalidates sessions and queued encrypted delivery
payloads.

## 3. Install, build, migrate, and restart

From the application root, with cPanel's Node environment activated:

```sh
npm run cpanel:build
```

This runs `npm ci --include=dev`, builds the ignored `public/css/app.css`, then
removes dev-only dependencies. It does **not** migrate the database, seed demo
data, restart Passenger, or modify the upload directory.

Before a first migration or any production release:

1. Back up both the database and upload directory, and verify the backup can be
   restored to an isolated staging copy.
2. Review the numbered SQL migrations and rehearse them on that staging copy.
3. With the production environment loaded, run the read-only connectivity check:
   `npm run db:ping`.
4. Only after the backup/rehearsal gate, run `npm run db:migrate`. This applies
   pending numbered migrations; it is not a reset. **Never run** `npm run
   db:reset`, `db/migrate.js --fresh`, or demo seeding against a populated or
   production database.
5. Restart from cPanel's Node application screen, or from the app root run:

   ```sh
   mkdir -p tmp
   touch tmp/restart.txt
   ```

The application does not create a default administrator. Follow the audited
first-admin procedure in [DEPLOY.md](DEPLOY.md) after the app, database, and
email flow have been verified.

After restart, check `https://app.example.com/api/health`, the login/static
pages, upload permissions, and Socket.IO through the public domain. For a basic
polling handshake, request:

```sh
curl -i 'https://app.example.com/socket.io/?EIO=4&transport=polling'
```

This proves only that the route responds; it does not prove WebSocket upgrades,
WebRTC calls, SMTP/SMS delivery, or production readiness. Test those flows with
synthetic accounts and provider-owned test addresses/numbers.

## 4. Background jobs

The default `RUN_BACKGROUND_JOBS=true` keeps cleanup and delivery scheduling in
the app process, preserving its normal Socket.IO expiry broadcasts. This is the
simplest mode when Passenger keeps one app process running. On startup, cleanup
and delivery also make an initial pass.

If the provider suspends/recycles the web process or requires cPanel Cron Jobs,
set `RUN_BACKGROUND_JOBS=false` and add these jobs in cPanel Cron Jobs:

- Cleanup: every five minutes (`*/5 * * * *`) running
  `scripts/run-cleanup.mjs`.
- Email/SMS outbox: every minute (`* * * * *`) running
  `scripts/run-delivery.mjs`.

Use the absolute Node binary path shown by your cPanel Node environment. A
command template is:

```sh
cd /home/CPANELUSER/apps/ember-date && /home/CPANELUSER/nodevenv/apps/ember-date/22/bin/node scripts/run-cleanup.mjs
cd /home/CPANELUSER/apps/ember-date && /home/CPANELUSER/nodevenv/apps/ember-date/22/bin/node scripts/run-delivery.mjs
```

The `nodevenv` path varies by account and Node version; replace it with the
actual path from cPanel. Test each command manually from the application root
before scheduling it. The scripts load `.env` from that directory, close their
DB pool, use nonzero exit status on failure, and avoid printing message bodies,
recipient details, or raw database/provider errors.

In cron mode, cleanup still removes expired records/media but does not have the
web process's Socket.IO broadcaster, so connected clients may not receive the
immediate expiry event. Do not enable both the in-process scheduler and cPanel
cron for the same jobs. Keep the Passenger web app at one process in either
mode; external cron does not make multi-worker Socket.IO/presence safe.

## Known host-dependent limitations

- A cPanel account without Node.js Application Manager/Passenger cannot host this
  application as-is. PHP hosting alone is insufficient.
- If Passenger/WebSocket proxying is unavailable, Socket.IO may fall back to
  HTTP polling, but realtime behavior and WebRTC signalling can be degraded or
  blocked. Confirm this with the provider and test from a browser.
- Multiple Passenger workers are not supported by the current in-memory
  Socket.IO/presence design. A shared Socket.IO adapter and coordinated
  background processing would be needed before horizontal scaling.
- Video posters use `ffmpeg`/`ffprobe` when installed. Without them the app uses
  a generic poster; this does not disable all video uploads, but host limits may
  still reject large or CPU-intensive uploads.
- Shared-host CPU, memory, disk, outbound-network, cron-frequency, and process
  lifetime limits vary by provider. This repository cannot verify or override
  those account policies.

Passing setup and health checks therefore means the current checks passed; it
is not a universal guarantee that every cPanel plan can run every feature
without restriction.
