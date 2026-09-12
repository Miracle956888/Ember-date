# Deploying Ember to a public host

Everything in this repo is built to run anywhere Node 20 + MySQL 8 run. This file
picks the host, then gives the exact commands.

Prices are as found in September 2026. Verify before you buy anything.

---

## 1. What this app actually needs (this is what rules providers out)

Six requirements, all of them structural:

| Need | Why | What it rules out |
| --- | --- | --- |
| **A process that never sleeps** | Socket.IO keeps live chat open, and the 24 h purge is a `node-cron` job inside the app. If the process is frozen, expired messages stop being deleted and the promise in the product name quietly stops being true. | Serverless (Vercel, Netlify, Cloudflare Workers), Render **free** tier (sleeps after 15 min idle), any scale-to-zero setup |
| **MySQL 8 or MariaDB ≥ 10.6** | `db/schema.sql` is MySQL-first; `db/migrate.js` detects MariaDB and rewrites the incompatible collations, so both work. Nothing else will. | Providers that only offer Postgres (Render, Supabase, Neon, Railway's Postgres default) |
| **Persistent disk** | `UPLOAD_DIR` holds every photo and video. On an ephemeral filesystem a deploy deletes people's media. | Free tiers without volumes - unless you move uploads to object storage |
| **HTTPS** | In production `env.js` sets `Secure` on the session cookies, so an http origin means **nobody can log in at all** - and passwords would travel in the clear. | Any host where you cannot attach a certificate |
| **One instance** | There is no Redis adapter and no sticky-session config, so a second replica splits who is connected to whom. | Auto-scaling groups (fine to leave at 1, but do leave it at 1) |
| **UDP + a TURN relay** | WebRTC calls only connect directly on the same LAN. Over the internet most clients need a relay. | Nothing - but budget coturn, or accept that calls fail for some users |

If a host satisfies those six, it will run this app.

---

## 2. The short answer

| You want | Use | Cost | Notes |
| --- | --- | --- | --- |
| **Best overall for this app** | **Hetzner Cloud CX22** (or CAX11 ARM, same price) running `docker-compose.yml` + Caddy | ~€3.79-4.35/mo, 2 vCPU, 4 GB, 40 GB NVMe, 20 TB traffic, IPv4 included | MySQL, app and uploads on one box; nothing scales to zero; 20 TB makes media serving a non-issue. Use §3. |
| **Genuinely free, permanent, public** | **Oracle Cloud Always Free** ARM VM (4 cores / 24 GB on the free tier) | $0 | Same compose flow as §3. Caveats are account-level, not technical: free capacity in a region can be unavailable, and idle free instances can be reclaimed. Fine for a real side project, not for something you promise people. |
| **Never touch a server** | **Render** with `render.yaml` | $7/mo Starter + external MySQL | No MySQL of its own, so pair it with Aiven's free MySQL (§4). Skip the free tier: 30-60 s cold starts and a frozen purge cron. |
| **Small, cheap, real IP** | **Fly.io** with `fly.toml` | ~$2-3/mo + external MySQL | Nearest regions to West Africa are Paris/Lisbon/Madrid; Mumbai exists if your users are further east. |
| **Already on DigitalOcean/Vultr/Linode** | Their $5-6/mo droplet, same §3 flow | $5-6/mo | Simpler bill, more expensive per gigabyte than Hetzner. |
| **Avoid** | Vercel/Netlify/Cloudflare for the API | - | Serverless cannot hold sockets or run a cron; uploads have nowhere to live. |

For the database on a PaaS, the free options that actually speak MySQL:
**Aiven for MySQL** free tier - 1 node, 1 CPU, 1 GB RAM, 1 GB disk, **no credit card**,
but it **requires TLS** and caps `max_connections` at 76
([docs](https://aiven.io/docs/products/mysql/concepts/mysql-free-tier)); and
**TiDB Cloud Serverless**, also MySQL-protocol and also TLS-only, whose free
allowance is roomier than 1 GB. DigitalOcean Managed MySQL starts ~$15/mo if you
want it managed and backed up. PlanetScale has no free tier any more (~$39/mo).

1 GB of disk sounds small for a chat app with photos: it is. Use it to try the
deployment, then either move to a paid plan or (better for this app) keep media in
object storage - `server/src/services/storage.service.js` is a five-method seam
built for exactly that swap.

---

## 3. VPS deployment (recommended)

Takes about ten minutes plus DNS propagation.

**3.1** Buy a small Ubuntu 22.04/24.04 or Debian 12 box. Add a DNS **A record** for
your domain pointing at it (`ember.example.com` → `203.0.113.10`). Do this first:
Caddy cannot get a certificate until the name resolves, and that is the single most
common "why is it not loading" here.

**3.2** Copy the repo onto the server, then run the provisioning script:

```bash
git clone https://github.com/Miracle956888/Ember-date.git /opt/ember
sudo SITE_ADDRESS=ember.example.com /opt/ember/deploy/vps.sh
```

Read it first if you like - `deploy/vps.sh --dry-run` prints every command it would
run and changes nothing.

What it does: installs Docker if missing, writes `/opt/ember/.env` with freshly
generated `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `DB_PASSWORD` (never
overwriting an existing `.env`, because rotating those secrets mid-flight logs every
user out and re-encrypting the database password breaks nothing but the login), sets
`APP_ORIGIN`/`TRUST_PROXY`/`FORCE_HTTPS`, brings up app + MySQL + the uploads volume,
and installs Caddy for TLS and the http→https redirect.

**3.3** Security-group ports: **22, 80, 443** only. Not 3000, not 3306/3307 - the
compose file binds both to `127.0.0.1` now, so a scanner reaches nothing even if you
fat-finger the firewall.

**3.4** Verify:

```bash
cd /opt/ember && npm run deploy:check     # config you can reach; DB checks included
docker compose logs --tail 30 app
curl -fsS https://ember.example.com/api/health
```

`deploy:check` prints every blocking problem with the reason and the fix - it exists
because these failures are invisible in code and obvious at 2 a.m. on a live host.

**3.5** Create your real account through the site. Then decide about demo data -
the answer on a public host is normally "no". `docker-compose.yml` no longer seeds on
boot and `db/seed.js` refuses in production unless you both set `SEED_DEMO=1` and
supply a `DEMO_PASSWORD` that is not the `Password123!` printed in the README. Seeding
also clears tables, so on a host with real users it deletes them. If you want the
12 demo profiles for a screenshot, do it on a throwaway box.

---

## 4. Render

1. Create the **database first**, outside Render: Aiven free MySQL or TiDB Serverless.
   Note the host / port / user / password / database, and **download its CA bundle** -
   both providers require TLS, and `mysql2` without `DB_SSL=true` fails with
   `Connections using insecure transport are prohibited`, which mentions TLS nowhere.
2. Fork this repo, then Render → New → Blueprint → pick the fork. `render.yaml`
   creates the web service from the Dockerfile, generates the two JWT secrets for
   you, and prompts for the `sync: false` ones.
3. Put the CA bundle in the repo? No. Either use a provider whose certificate chains
   to a public CA (then `DB_SSL=true` is enough), or add a Render **Secret File** env
   var named `DB_SSL_CA` containing the PEM and set `DB_SSL=true` - Render writes file
   env vars to the path in the variable, which is exactly what `DB_SSL_CA` expects.
4. Set `APP_ORIGIN` to the real URL once your custom domain is attached, then add a
   Persistent Disk (dashboard → Service → Disks, $0.25/GB/mo) mounted at
   `/var/tmp/ember-uploads`, because `UPLOAD_DIR` points there in the blueprint.
   Without the disk, every deploy erases uploaded media.
5. The schema is applied by the image itself at first boot (`node db/migrate.js
   --if-needed`). There is deliberately no `preDeployCommand`: it needs a paid
   instance type, and `node db/migrate.js` on a database that already has tables
   would drop 23 of them and abort on the rest - i.e. every push would destroy
   user data. If you prefer to migrate by hand instead (e.g. to watch it happen),
   run `node db/migrate.js` from the service's Shell tab once, before the first
   traffic lands.

---

## 5. Fly.io

```bash
fly launch --copy-config --no-deploy            # reads fly.toml
fly volume create ember_uploads --app ember -s 10 -y
fly secrets set DB_HOST=... DB_PORT=3306 DB_USER=ember DB_PASSWORD=... DB_NAME=ember \
  DB_SSL=true APP_ORIGIN=https://ember.fly.dev \
  JWT_ACCESS_SECRET=$(openssl rand -hex 32) JWT_REFRESH_SECRET=$(openssl rand -hex 32)
fly deploy
```

`fly deploy` builds the image, whose start command runs `node db/migrate.js
--if-needed`: an empty database gets the schema during the first health check, a
database that already has one is left alone. Nothing to run by hand - and do not
run the bare command afterwards, which now refuses for exactly that reason.

The `node` user in the image needs to write to the volume; if uploads start failing
with `EACCES`: `fly ssh console -C "chown -R node:node /app/uploads"`.

---

## 6. Anywhere with Docker, no git

CI publishes the image on every `v*` tag, so a box only needs Docker:

```bash
docker pull ghcr.io/Miracle956888/ember-date:v1.0.0
docker run -d --name ember --env-file /opt/ember/.env \
  -v ember-uploads:/app/uploads -p 127.0.0.1:3000:3000 \
  ghcr.io/Miracle956888/ember-date:v1.0.0
```

ghcr.io packages from private repos are private: `docker login ghcr.io` with a token
scoped `read:packages` (or set the package visibility to public). The image does not
migrate - `node db/migrate.js --if-needed` runs at container start in both the
image and compose, which is what you want on a host you will restart. Run
`node db/migrate.js` by hand only against an empty database: the schema snapshot
is not re-runnable (it recreates 23 tables and aborts on the other 19), and
`node db/migrate.js --fresh` is the one command that intentionally rebuilds from
scratch, taking every row with it.

Pushing a `v*` tag also rolls a VPS automatically once you set `DEPLOY_HOST`,
`DEPLOY_PATH` and `SSH_PRIVATE_KEY` in repo settings; it runs `deploy/roll.sh`, which
waits for `/api/health` and refuses to call a bad image a success.

---

## 7. After the first deploy

- **Become the admin.** Roles are not seeded. `UPDATE users SET role='admin' WHERE username='you';` (or `'moderator'` for the report queue and takedowns without bans or role changes).
  then sign out and in (the role is in the token). `/admin` is otherwise unreachable.
- **Backups.** The only state is MySQL plus `UPLOAD_DIR`:
  ```bash
  docker compose exec db sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction ephemeral_chat' \
    | gzip > /backup/ember-$(date +%F).sql.gz
  tar czf /backup/uploads-$(date +%F).tgz -C /var/lib/docker/volumes/ember_uploads/_ . 2>/dev/null \
    || tar czf /backup/uploads-$(date +%F).tgz -C "$(docker volume inspect ember_uploads -f '{{.Mountpoint}}')" .
  ```
  Restore is `gunzip -c file.sql.gz | docker compose exec -T db mysql -uroot -p... ephemeral_chat`.
  Cron both, and test a restore before you need one.
- **Calls across networks.** Stand up coturn on the same box and set the three
  `TURN_*` vars, or say plainly in your UI that video calls need a shared network.
  Half-configuring TURN is worse than not: clients fail at relay authentication,
  which looks like "the call dropped".
- **Abuse.** You now run a public app where strangers send images. `POST
  /api/users/reports` plus `/admin` (report queue, suspend, ban, audit log) already
  exist, so the moderation path is there on day one. Keep `MAX_IMAGE_MB` modest, and
  remember the purge deletes content after 24 h - including the evidence you may need
  for a report, so review the queue daily.
- **Monitoring.** `GET /api/health` is unauthenticated on purpose (the container
  health check uses it). `journalctl -u caddy` and `docker compose logs -f app` cover
  the rest; the app logs JSON with a level, so filtering on `"level":"error"` works.

---

## 8. What I could not verify from here

Being straight about it, because these files are the ones you run in production:

- The sandbox this work was done in has an outbound allowlist that blocks every
  provider (`render.com`, `fly.io`, `*.githubusercontent.com`, apt mirrors), so
  **nothing was deployed to a live host from here and no external database was
  reachable**. I could not exercise `deploy/vps.sh` against a real Docker install.
- What **is** verified: `npm audit` is clean (was 8 findings incl. 1 high); the 100
  checks in `npm test` run the app's real modules - multer 2.x uploads through
  `middleware/upload.js`, file-type 22 + sharp 0.35 through `processUpload()` on real
  image bytes, node-cron 4's actual scheduler, cookie 0.7's parser, express/qs query
  parsing, the new `forceHttps` rule, the production seed guard, and `deploy-check`'s
  pass and fail exit codes. `bash -n` and `--dry-run` cover the shell script's syntax
  and logic; `deploy/roll.sh` was driven through its success, missing-directory and
  failed-health-check paths with stubs.
- `render.yaml` and `fly.toml` are written against their providers' documented schemas
  (`preDeployCommand`, `dockerfilePath`, `generateValue`, `sync: false` all confirmed in
  Render's docs) but have **not** been validated by a real account. If a key is
  rejected, the fix is to create the service in the dashboard and paste the same env
  vars.
- Caddy and MySQL config assume Ubuntu/Debian with systemd. On another distro the
  package names differ; the compose file does not care.
