# Deployment and operations

> **This is a deployment guide, not a launch approval.** The repository has
> automated checks, but no external provider, staging environment, production
> database, SMTP/Twilio account, backup restore, or live deployment was exercised
> during this work. Resolve the release gates below before onboarding real users.

## Runtime requirements

- Node.js 20 or 22, MySQL 8 (MariaDB 10.6+ is supported through collation
  adaptation, but the live migration CI job uses MySQL 8).
- One app process for realtime service. The current Socket.IO presence/room
  state is in-process, so horizontal/multi-worker scaling is not configured.
  Cleanup/delivery jobs run in-process by default; the [cPanel guide](CPANEL.md)
  documents optional host cron entrypoints for accounts that suspend/recycle apps.
- HTTPS termination and correct proxy configuration (`TRUST_PROXY=1`,
  `FORCE_HTTPS=1` where the app performs the redirect).
- Persistent, private storage for `UPLOAD_DIR`. Do not place it under
  `public/`. Database and uploads need separate backups.
- SMTP for reset links/email verification and Twilio credentials for SMS if
  those flows are enabled. Without the provider, the encrypted outbox retries
  but delivery is not complete.

The checked-in Render and Fly configurations are examples and have not been
validated by a live provider account. Verify service schema, TLS, volume
permissions, secrets support, region, limits, and pricing directly with the
provider before use. Cost/availability estimates are intentionally not stated
here because they were not verified for this release.

For a cPanel/Passenger setup, see the separate [cPanel deployment guide](CPANEL.md).
A cPanel logo alone does not imply Node.js, WebSocket, outbound-DB, or persistent
storage support; the guide lists the plan prerequisites and limits.

## VPS using Docker Compose

The repo includes `deploy/vps.sh` for Ubuntu/Debian and `docker-compose.yml` for
a single-host MySQL + app + upload-volume deployment. Review the script and its
`--dry-run` output before running it:

```bash
git clone https://github.com/Miracle956888/Ember-date.git /opt/ember
sudo SITE_ADDRESS=ember.example.com /opt/ember/deploy/vps.sh --dry-run
sudo SITE_ADDRESS=ember.example.com /opt/ember/deploy/vps.sh
```

Use a real DNS name and configure the host firewall so only SSH and HTTPS
certificate/traffic ports are publicly reachable. The compose file publishes
app and MySQL ports on loopback by default; keep them private. Caddy terminates
TLS in the provided VPS flow. Review generated `/opt/ember/.env`, set the real
`APP_ORIGIN`, and keep that file out of source control and logs.

The image starts by running the ordered migration runner, then starts the
server. It does not seed demo data. `docker compose down -v`, `db/seed.js`,
`npm run db:reset`, and `db/migrate.js --fresh` are destructive; never use them
on a host with real data.

After DNS/TLS and the database are ready:

```bash
cd /opt/ember
docker compose exec app node scripts/deploy-check.mjs
curl -fsS https://ember.example.com/api/health
```

The `deploy-check` script is also runnable as `npm run deploy:check` on an
operator workstation with Node/dependencies installed and the target `.env`
loaded.

`/api/health` is a public container/process check. It is not a complete service
SLA or proof that SMTP, SMS, backups, TURN, or browser workflows work.

## Database migrations and data safety

`db/migrations/` is the migration source; `db/schema.sql` is a documentation
copy of immutable baseline `0001`, not the production update command. Current
numbered migrations are:

- `0001_baseline.sql`: 42 application tables and 330 parsed column definitions;
- `0002_admin_security.sql`: staff roles, RBAC/audit/activity tables, encrypted
  delivery outbox, verification-review workflow, and media-deletion queue. It
  revokes legacy automatic photo-verification approvals for records with
  approved submissions, preserves user/profile data, and queues reviewed
  evidence for deletion;
- `0003_verification_send_history.sql`: adds a revocation marker/index so code
  resend invalidation retains issuance history for the rolling send limit;
- `0004_durable_media_retention.sql`: extends the deletion outbox reasons and
  adds short-lived owner-bound reservations for unclaimed social uploads.

The runner records version, filename-derived name, and SHA-256 checksum in
`schema_migrations`, serializes runners with a database advisory lock, validates
history continuity, and refuses checksum drift. An unversioned existing schema
is adopted only when all baseline tables and baseline columns are present; the
runner records the baseline without replaying its DDL. That shape check is not a
full proof that every index, foreign key, or data invariant matches the baseline,
so inspect/reconcile legacy drift on a restored staging copy before proceeding.

Normal command (also what the Docker image runs):

```bash
npm run db:migrate
```

It applies pending versions and is safe to rerun on current history. The
`--if-needed` flag remains a compatibility alias; it still checks and applies
pending migrations. `--target=0001` is intended for disposable migration tests.

Before a real-data migration:

1. Record the release SHA and current migration ledger/checksums.
2. Take a consistent database backup and a separate upload-storage backup; prove
   they restore into an isolated environment.
3. Apply the exact candidate migrations to a recent restored staging copy.
   Inspect migration output, changed verification status, queued deletion count,
   indexes/constraints, application logs, and user-visible flows.
4. Schedule a maintenance window if the migration or data volume warrants one.
   MySQL DDL can auto-commit; this runner stops on a failed statement and does
   not roll back already committed DDL. Repair deliberately or restore a verified
   backup; do not repeatedly rerun blindly.
5. After production apply, verify the complete ledger and application health,
   then retain the migration and backup evidence.

The destructive `--fresh` mode is disabled when `NODE_ENV=production`. Outside
production, it requires both `ALLOW_DESTRUCTIVE_RESET=1` and
`CONFIRM_DROP_DATABASE` equal to the exact database name. Use it only for a
throwaway local database. Never use demo fixtures to test or repair a populated
or production database.

## First administrator

The application does not seed staff accounts. On the target host, configure and
test SMTP first if email verification is part of the sign-up process. Create an
account normally, verify it, then run the one-time audited bootstrap from the
repo/container with database environment already loaded:

```bash
BOOTSTRAP_ADMIN_USERNAME=your_handle npm run admin:bootstrap
# On a Compose host:
docker compose exec -e BOOTSTRAP_ADMIN_USERNAME=your_handle app \
  node scripts/bootstrap-admin.mjs
```

The script requires the latest migration in `db/migrations/` to be applied, an
existing active account, and no existing admin/super-admin. It serializes with a
database lock and transaction and writes `admin.bootstrap` audit/activity records. Sign in
again and verify the assigned permissions. Remove the bootstrap variable
immediately. Subsequent role changes belong in the audited admin console; do
not grant roles with manual production SQL. Maintain at least two independently
controlled admin accounts and document an off-platform recovery process.

## Required configuration and secrets

Set secrets through the host's secret manager (or a permission-restricted `.env`
file outside version control). Do not put real values in `render.yaml`,
`fly.toml`, Compose files, screenshots, logs, shell history, or tickets.

| Setting | Production requirement |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | Exact public HTTPS origin; no path |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Reachable MySQL 8 / supported MariaDB account with least-privilege permissions |
| `DB_SSL`, `DB_SSL_CA_BASE64`, `DB_SSL_CA` | Enable TLS and load the managed DB's trusted CA; Aiven hosts require the project CA and always retain chain/hostname verification |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Separate, high-entropy values of at least 32 characters; store persistently |
| `TRUST_PROXY`, `FORCE_HTTPS` | Set consistently with the trusted TLS proxy; test redirects and secure cookies |
| `UPLOAD_DIR` | Private persistent volume, outside `public/`; back up separately |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Configure a verified transactional sender before recovery/email verification is relied on |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | All three required for phone-verification SMS |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Required for reliable calls across strict NATs; otherwise calls may be limited to direct paths |
| `MESSAGE_TTL_HOURS`, `CLEANUP_CRON` | Review the retention contract and ensure cleanup runs continuously |
| `RUN_BACKGROUND_JOBS` | `true` for one always-running app process; set `false` only when both host cron jobs are configured (see [CPANEL.md](CPANEL.md)) |

### Aiven MySQL TLS on Render

For an Aiven connection error such as `self-signed certificate in certificate chain`, configure the Aiven **project CA** rather than turning certificate checks off:

1. In Aiven, open **Project → Services → your MySQL service → Overview → Connection information** and download the **CA certificate** as a PEM file. Use the host and port shown for that service.
2. In the Render Blueprint prompts or the service's **Environment** settings, set `DB_SSL=true` and add `DB_SSL_CA_BASE64` as a secret environment variable. The checked-in `render.yaml` declares this variable with `sync: false` so the certificate value is not committed.
3. Base64-encode the **entire PEM file**, including its `BEGIN CERTIFICATE` and `END CERTIFICATE` lines. On macOS/Linux, run:

   ```sh
   base64 < aiven-ca.pem | tr -d '\r\n'
   ```

   In PowerShell, run:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("aiven-ca.pem"))
   ```

   Copy the resulting single-line value into Render as `DB_SSL_CA_BASE64`. Do not add literal `\n` escapes, PEM quotes, or the local file path. The app decodes the value, validates the X.509 CA PEM, and passes the CA to `mysql2`.
4. Keep `DB_SSL_REJECT_UNAUTHORIZED` unset. The app rejects attempts to set it to `false`; the driver always uses `rejectUnauthorized: true` and `verifyIdentity: true`, so it verifies both the CA chain and the server name from `DB_HOST`.
5. Save the environment and redeploy. If you prefer a file instead, mount the PEM using Render's protected Secret Files and set `DB_SSL_CA` to the exact absolute path inside the container. A path on your computer does not exist inside Render; startup deliberately fails if the mounted file is missing.
6. From the Render Shell, run `npm run db:ping`. This uses the same `mysql2` TLS config and performs only a ping plus `SELECT VERSION()`; it does not run migrations or modify rows. Then inspect the deploy logs and open `/api/health` on the service URL. The app itself runs migrations at startup, so test against a restored staging database before pointing it at production.

Never paste the database password or CA value into tickets or chat. Keep a database backup and test a restore before production migrations.

Queued reset/verification payloads use AES-GCM with a key derived from
`JWT_REFRESH_SECRET`. Keep that secret stable. Before rotating it, drain or
intentionally discard pending encrypted outbox payloads and plan for outstanding
reset/verification requests to be reissued. Rotating it also invalidates
sessions; test the coordinated rotation in staging.

The health check reports whether SMTP/Twilio are configured and the queue state,
but configuration is not delivery proof. Send staging-only test messages to
provider-owned addresses/numbers and verify arrival, links, expiry, retries, and
failure handling without logging the bearer data.

## Retention, account deletion, and evidence

The default 24-hour lifetime applies to ephemeral messages and documented
social content. It does **not** sweep profile photos. Profile photos remain until
the owner removes them or requests account deletion. Account deletion
transactionally queues owned profile, attachment, post, moment, and verification
media before relational cascades remove ownership records. A worker retries
storage deletion; operators must monitor the queue and verify storage behavior.

Photo verification submissions are pending/manual-review only; upload does not
grant a badge. Evidence remains private while pending, is available only to
review permission, and after review its DB reference is cleared and the object
is queued for deletion. The previous automatic-approval state is handled by
migration `0002`; rehearse its data effect on staging before rollout.

## Release verification

Run the checked-in commands in `TESTING.md`. The GitHub workflow is configured
to run dependency audit, lint, no-DB tests, migration checks on MySQL 8, guarded
synthetic API/DB security tests, route sweep, Socket.IO tests, Playwright browser
smoke, and Docker-image checks. A configured workflow is not proof it passed;
check the actual run on the exact release commit.

Minimum staging evidence before production:

- [ ] CI is green for the exact commit and no high/critical dependency advisory
      is suppressed.
- [ ] Migration applied to a restored staging copy with backup/restore evidence.
- [ ] SMTP and Twilio test messages were delivered; provider configuration and
      retry behavior were confirmed.
- [ ] Admin bootstrap, least-privilege roles, PII redaction, audit, report
      redaction, manual verification and evidence deletion were checked.
- [ ] Recovery works and old REST and Socket.IO sessions fail after reset.
- [ ] Synthetic account deletion removes its media via the durable queue while
      unrelated profile photos remain untouched.
- [ ] HTTPS/cookies, database TLS, health, cleanup schedule, backup restore,
      rollback plan, and storage permissions were checked.

## Current evidence and unresolved release gates

Repository-local outcomes at the time of editing are recorded in `TESTING.md`.
No migration was run against a database during this work. No live email/SMS
provider, real deployment, staging environment, external database, backup
restore, performance/load test, or production data was available to verify.

Before public launch, resolve at least these gates:

- **Critical — operational:** rehearse migrations `0002`–`0004` on a current
  restored production-like database and verify the backup/restore/rollback plan.
- **High — delivery:** configure and observe real SMTP and SMS delivery, including
  abuse/rate behavior and failed-provider recovery.
- **High — security acceptance:** run role-by-role admin and privacy acceptance
  on staging; test access-token invalidation over REST and Socket.IO, media
  authorization/path traversal, evidence retention, and account deletion.
- **High — operations:** prove persistent-volume backup/restore, outbox/media
  queue monitoring, alerting, HTTPS/proxy and remote database TLS.
- **Unassessed — capacity:** no representative load test or user-facing latency
  evidence is checked into the repository; size infrastructure only after
  staging measurement.
