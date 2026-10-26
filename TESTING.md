# Testing and release evidence

This guide covers only checked-in scripts and reproducible operator checks. A
passing local or CI suite is not evidence that email/SMS providers, an external
object store, a staging deployment, or production data have been exercised.

## Fast, database-free checks

Requirements: Node.js 20 or 22 and npm. From a clean checkout:

```bash
npm ci
npm run build:css
npm run lint
npm test
npm run test:security
npm audit --audit-level=high
npm run deploy:check -- --offline
```

`npm test` runs `scripts/dep-smoke.mjs`. It exercises the checked-in upload and
image-processing code, cookie parsing, request limits, HTTPS guards, deployment
configuration, migration parsing/adoption/reset safeguards, and static workflow
assertions. It does not connect to MySQL. `npm run test:security` runs DB-free
unit/regression checks for permission separation, CSRF/auth behavior, migration
history, media retention, and page/navigation links.

## Disposable MySQL migration test

The migration scripts make schema changes and must only be tested against a
throwaway database. CI uses a fresh MySQL 8 service named `ember_ci`; it never
runs `--fresh` against an existing database.

For a local equivalent, start a disposable MySQL 8 container on an unused port
(for example `3307`) and ensure it contains no valuable data. Set the same
connection values in every shell used below:

```bash
export NODE_ENV=development APP_ORIGIN=http://localhost:3000
export DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=ci-root-password
export DB_NAME=ember_ci DB_SSL=false
export JWT_ACCESS_SECRET=local-only-access-secret-change-before-use-123456
export JWT_REFRESH_SECRET=local-only-refresh-secret-change-before-use-654321

node db/migrate.js --target=0001
mysql -h 127.0.0.1 -P 3307 -uroot -pci-root-password ember_ci \
  -e "INSERT INTO interests (slug, label) VALUES ('migration-sentinel','Migration Sentinel')"
node db/migrate.js
mysql -h 127.0.0.1 -P 3307 -uroot -pci-root-password ember_ci \
  -e "SELECT version, name, checksum FROM schema_migrations ORDER BY version; SELECT slug FROM interests WHERE slug='migration-sentinel';"
node db/migrate.js --if-needed
```

Expected: versions `0001`–`0004` are recorded once, the synthetic sentinel
survives, and the last invocation reports that the schema is current. The latest
migration adds the durable media-deletion reasons and `pending_social_uploads`;
this local procedure does not reset or seed the database. CI additionally checks
migration checksums and preservation of the synthetic sentinel.

`--fresh` deletes the named database and is disabled in production. It requires
both `ALLOW_DESTRUCTIVE_RESET=1` and
`CONFIRM_DROP_DATABASE=<exact DB_NAME>` outside production. Do not use it to
"fix" migration failures; inspect the partial DDL, restore a backup if needed,
and reconcile deliberately. MySQL DDL is not generally transactional.

## Synthetic API/DB security integration

`CI` runs `scripts/security-integration.mjs` against the same disposable MySQL
service and a local server. It creates uniquely named synthetic accounts,
content, evidence files, and delivery records, tests server-side RBAC/CSRF, PII
and message redaction, report/content/verification moderation, verification
send limits, one-use codes, password-reset concurrency/session revocation,
signed-out profile-photo visibility/block checks, and account-media deletion,
then attempts cleanup.

The script refuses to run unless **all** of the following are true:

- `ALLOW_SYNTHETIC_SECURITY_TESTS=1` is explicitly set;
- `CI=true`, `NODE_ENV` is not production, and the API base is localhost;
- the DB host is localhost and `DB_NAME=ember_ci`.

That guard is a last line of defense, not permission to point at a shared
schema. Only use it with an empty/throwaway local CI database. Do not set these
flags against staging or production. The script decrypts delivery payloads only
in process for assertions and never prints codes, reset tokens, or private
message content.

## Browser, route, and realtime tests

These suites mutate the seeded accounts and conversation. Use a disposable
MySQL database and synthetic demo data only.

1. Configure the local DB environment as above. Run `npm run db:migrate`, then
   run `npm run db:seed` **only on that disposable database**. The demo seeder
   may clear data; never use it with populated or production data.
2. Build CSS and install the Chromium build managed by Playwright:

   ```bash
   npm run build:css
   npx playwright install chromium
   ```

3. Start the server in one shell with the disposable DB environment loaded:

   ```bash
   npm start
   ```

4. In another shell, run:

   ```bash
   npm run sweep -- --base http://127.0.0.1:3000 --auth --demo
   BASE=http://127.0.0.1:3000 node scripts/smoke-socket.js
   npm run test:browser -- --base http://127.0.0.1:3000
   ```

The route sweep checks all 17 pretty-URL pages, local assets, authentication,
CSRF, expected 404 behavior, and theme response. The Socket.IO suite drives
handshakes and chat events. The Playwright suite uses two isolated browser
contexts, checks responsive pages/auth/profile/search/theme, and sends a
synthetic chat message. It launches the Playwright-managed Chromium by default;
set `CHROMIUM_PATH=/path/to/chromium` only when using a separately installed
binary. `--shots` writes screenshots under ignored `tmp/shots/`.

## CI coverage

`.github/workflows/ci.yml` currently defines three jobs:

- **checks** on Node 20 and 22: `npm ci`, CSS build, lint, syntax checks,
  `npm test`, `npm run test:security`, offline deploy check, and
  `npm audit --audit-level=high`;
- **deploy-verify** on Node 22 with disposable MySQL 8: baseline plus pending
  migrations through `0004`, synthetic-row preservation, restart/checksum
  checks, seeded route sweep, guarded synthetic security integration,
  Socket.IO suite, Playwright/Chromium browser suite, and production-mode
  HTTPS/Secure-cookie checks;
- **docker**: builds the runtime image and checks its stylesheet, production
  dependencies, startup guards, and public health endpoint contract.

A workflow file or a local result is not a CI pass. Report a CI result only
after the workflow has actually completed on the relevant revision.

## Staging/production release checklist

Before using real data or inviting users:

- [ ] Run the complete CI workflow on the exact release commit.
- [ ] Take a database backup and upload-storage backup, then prove both restore
      to an isolated staging environment.
- [ ] Apply migrations to a recent staging restore; inspect row/table counts,
      warnings, queue state and application logs. Confirm the migration ledger
      is contiguous and checksums match. Do not use destructive reset/seed.
- [ ] Confirm `APP_ORIGIN`, HTTPS proxy trust, secure cookies, database TLS,
      stable JWT secrets, persistent upload storage, backups, and single-instance
      socket/cron assumptions.
- [ ] Configure a verified SMTP sender and Twilio account in the secret store.
      Test delivered email and SMS, retry/failure behavior, resend/guess limits,
      password reset, and old-session revocation; do not copy real codes or tokens
      into tickets or logs.
- [ ] Bootstrap the first staff account on staging with
      `BOOTSTRAP_ADMIN_USERNAME=... npm run admin:bootstrap`. Test each role,
      sensitive-field redaction, mutation audit, and two-person admin recovery.
- [ ] Verify that pending photo evidence is restricted to reviewers, that
      approval is manual, and that reviewed evidence is queued for deletion.
      Confirm profile photos persist until user removal/account deletion, while
      the 24-hour purge is limited to the documented ephemeral content.
- [ ] Exercise account deletion with a synthetic staging account and verify the
      durable media-deletion queue drains; independently test restore/rollback.
- [ ] Run the route and browser suites against staging with dedicated synthetic
      accounts. Do not use real customer content as a fixture.
- [ ] Record dated health, provider-delivery, migration, backup-restore, and
      rollback evidence. `/api/health` alone is not launch approval.

## Current verification record

In the Arena workspace on 2026-10-26, `npm run lint`, `npm test` (214 passed),
`npm run test:security` (22 passed), `npm run cpanel:build`,
`npm audit --audit-level=high` (0 vulnerabilities), and `git diff --check` passed.
The cPanel build was exercised end to end: it installed locked build/runtime
dependencies, generated the ignored CSS asset, and pruned dev dependencies. The
cron entrypoints were also checked to fail with a nonzero status and a sanitized
message when required configuration is absent. No credentials were added to the
repository.

No cPanel account, Passenger host, Aiven endpoint, or production database was
accessed. Therefore actual cPanel routing/WebSocket support, live DB
migration/API integration, route sweep, hosted sockets/browser rendering,
staging, provider delivery,
deployment, backup restore, and production verification were not run. The
workflow definitions are checked locally, but no hosted Actions result is
available for this revision.
