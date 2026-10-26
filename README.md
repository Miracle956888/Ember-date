# Ember — swipe, match, chat. Then it disappears.

A one-to-one dating and chat web app. Swipe a deck of profiles, match, and talk
in real time. Ephemeral messages and social media have a 24-hour retention
window; profile photos are retained until the owner removes them or deletes the
account. Matched users can also place peer-to-peer video and voice calls.

> **Readiness notice:** this repository is under security and operations work.
> The automated checks described below are not staging or production evidence.
> Configure providers, test migrations on a restored staging copy, and complete
> the open items in `DEPLOY.md` before handling real user data.

Built with plain HTML, Tailwind CSS (CLI build), and vanilla JavaScript ES
modules on the front end; Node.js, Express, Socket.IO and MySQL 8 on the back
end. No SPA framework, no ORM, no CDN script tags.

**Putting it on a public host:** [`DEPLOY.md`](DEPLOY.md) is the operator guide -
which provider and why, every environment variable, TLS to a managed MySQL, and
how to verify a running site. For cPanel/Passenger, see [`CPANEL.md`](CPANEL.md)
and check the provider's Node.js, WebSocket, process, storage, and network limits
before choosing a plan.

Provision a MySQL 8-compatible database first (TiDB Cloud Serverless or Aiven both
have free tiers and speak the protocol this app uses), then this button reads
[`render.yaml`](render.yaml) from the repo - Docker runtime, HTTPS, health checks,
auto-deploy on push:

[![Deploy to Render](https://img.shields.io/static/v1?label=Deploy&message=to%20Render&color=4645ED)](https://dashboard.render.com/blueprint/new?repo=https://github.com/Miracle956888/Ember-date)

On a VPS instead, one command does the whole thing: `sudo SITE_ADDRESS=your.domain
./deploy/vps.sh` (add `--dry-run` to watch it first).

---

## Table of contents

1. [Quick start](#quick-start)
2. [Demo logins](#demo-logins)
3. [Environment variables](#environment-variables)
4. [npm scripts](#npm-scripts)
5. [Finding someone by username](#finding-someone-by-username)
6. [Discovery features](#discovery-features)
7. [Live location and privacy](#live-location-and-privacy)
8. [Private communication](#private-communication)
9. [Moments and 24-hour posts](#moments-and-24-hour-posts)
10. [Light and dark mode](#light-and-dark-mode)
11. [How the 24-hour deletion works](#how-the-24-hour-deletion-works)
12. [Testing video calls](#testing-video-calls)
13. [Architecture](#architecture)
14. [Project structure](#project-structure)
15. [API reference](#api-reference)
16. [Socket.IO event contract](#socketio-event-contract)
17. [Admin console and RBAC](#admin-console-and-rbac)
18. [Security notes](#security-notes)
19. [Running with Docker](#running-with-docker)
20. [Deploying to a public host](DEPLOY.md)
21. [Troubleshooting](#troubleshooting)

---

## Quick start

**Requirements:** Node.js ≥ 20, MySQL 8 (or MariaDB ≥ 10.6), and optionally
`ffmpeg` on your `PATH` for video poster frames.

```bash
# 1. install dependencies
npm ci

# 2. configure the environment
cp .env.example .env
#    then edit .env - at minimum set DB_USER / DB_PASSWORD, and generate secrets:
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"

# 3. create the database (once)
mysql -u root -p -e "CREATE DATABASE ephemeral_chat CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"

# 4. apply all pending versioned migrations, then load LOCAL synthetic demo data
npm run db:migrate
npm run db:seed

# 5. run it (Tailwind watcher + server, together)
npm run dev
```

Open **http://localhost:3000** and sign in with any demo account below.

For a local production-mode build, run:

```bash
npm run build:css
npm start
```

For any database with real data: take and verify a backup, rehearse the pending
migrations on a recent isolated restore, then run `npm run db:migrate`. The normal
runner applies numbered pending migrations and does not reset rows. Never run
`npm run db:seed`, `npm run db:reset`, or `db/migrate.js --fresh` against a
populated, staging, or production database. `--fresh` is only for a throwaway
development database with both destructive-reset guards enabled.

> **Note on MariaDB.** The canonical schema in `db/schema.sql` is written for
> MySQL 8. `db/migrate.js` detects MariaDB and rewrites the incompatible
> collations at apply time, so the same migration works on both.

---

## Demo logins

`npm run db:seed` creates 12 users. **The password for every account is
`Password123!`** - which is exactly why seeding is a local-only convenience:

- Under `NODE_ENV=production` the seeder **refuses to run** unless you set
  `SEED_DEMO=1` *and* a `DEMO_PASSWORD` that is not the published default. It also
  clears existing rows first, so on a host with real users it would delete them.
- `docker-compose.yml` no longer seeds on container boot for the same reason - a
  public deployment used to ship twelve accounts whose password was in the README.

Locally, nothing changes: run `npm run db:seed` and log in as below.

| Email                  | Username           | Notes                                             |
| ---------------------- | ------------------ | ------------------------------------------------- |
| `amara@example.com`    | `@amara`           | Matched with Tunde **and** Kelechi; has live chats |
| `tunde@example.com`    | `@tunde_a`         | Matched with Amara                                 |
| `ngozi@example.com`    | `@ngozi`           | Matched with Kelechi                               |
| `kelechi@example.com`  | `@kelechi.shoots`  | Matched with Ngozi and Amara                       |

Plus `zainab` (`@zainab.k`), `chidi` (`@chidi_dev`), `aisha` (`@aisha_o`),
`emeka` (`@emeka`), `funmi` (`@funmi.design`), `ibrahim` (`@ibrahim_b`),
`blessing` (`@blessing.bakes`) and `seyi` (`@djseyi`) — all `@example.com` —
who appear in the swipe deck.

To test matching from scratch, sign in as `zainab` and swipe right on someone;
sign in as that person in a second browser and swipe right back. To test
matching *without* swiping, use **Search by username** (the magnifier in the
header, or press `/`), type their handle and hit **Like**.

---

## Environment variables

Copy `.env.example` to `.env`. Everything has a working development default
except the database credentials.

| Variable                                     | Default                 | Purpose                                                     |
| -------------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `PORT`                                       | `3000`                  | HTTP port                                                    |
| `NODE_ENV`                                   | `development`           | `production` enables `Secure` cookies                        |
| `APP_ORIGIN`                                 | `http://localhost:3000` | CORS + Socket.IO origin allow-list                           |
| `DB_HOST` / `DB_PORT` / `DB_NAME`            | `localhost` / `3306` / `ephemeral_chat` | Connection target                    |
| `DB_USER` / `DB_PASSWORD`                    | —                       | **Required**                                                 |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`   | random per boot         | **Set these**, or every restart invalidates all sessions     |
| `MESSAGE_TTL_HOURS`                          | `24`                    | Message lifetime. Lower it to watch expiry quickly           |
| `MAX_IMAGE_MB` / `MAX_VIDEO_MB`              | `10` / `50`             | Upload ceilings                                              |
| `UPLOAD_DIR`                                 | `./uploads`             | Persistent local storage root; back it up with the database |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE`     | empty / `587` / `false` | SMTP transport for password-reset and email-verification delivery |
| `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM`   | empty                   | Optional SMTP auth and a provider-verified sender; never commit credentials |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | empty | All three enable phone-verification SMS; keep credentials server-side |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | empty               | Optional TURN relay for calls across strict NATs             |
| `TRUST_PROXY`                                 | off (on in prod)        | Read `X-Forwarded-*` behind a proxy: real client IPs for rate limiting, and `req.secure` |
| `FORCE_HTTPS`                                 | off                     | 301/308 upgrade to https behind that proxy. Needs `TRUST_PROXY`, or it refuses to start rather than loop |
| `EXTRA_ORIGINS`                               | empty                   | Additional CORS-allowed origins, comma separated              |
| `DB_SSL`                                      | off                     | `true` for TLS to any managed/public database; required for Aiven |
| `DB_SSL_CA_BASE64`                            | unset                   | Base64-encoded provider CA PEM; recommended for Render/Aiven and required for `*.aivencloud.com` hosts |
| `DB_SSL_CA`                                    | unset                   | PEM CA file path inside the running container; the file must exist there |
| `DB_SSL_REJECT_UNAUTHORIZED`                  | unsupported             | Chain and hostname verification are always enforced; a `false` value fails startup |
| `DB_POOL_SIZE` / `DB_SOCKET`                    | `10` / unset            | Connection pool size, or a unix socket instead of TCP          |
| `CLEANUP_CRON`                                  | `*/5 * * * *`           | How often expired rows are actually deleted                    |
| `RUN_BACKGROUND_JOBS`                           | `true`                  | In-process jobs; set `false` only when cPanel cron is configured |
| `LOG_LEVEL`                                     | `info` in prod          | `debug` in development                                         |

Deployment variables and a host comparison live in
**[DEPLOY.md](DEPLOY.md)**; `npm run deploy:check` verifies them. The cPanel
Passenger setup is documented separately in **[CPANEL.md](CPANEL.md)**.

### Email and phone verification delivery

Set SMTP using a provider-approved sender address before enabling password
recovery or email verification. Set all three Twilio values to enable SMS. The
app queues deliveries in a MySQL outbox, encrypts queued bearer data with
AES-GCM, retries transient failures, and destroys payload ciphertext after
success or terminal failure. Pending payloads depend on the stable
`JWT_REFRESH_SECRET`; coordinate any rotation with the outbox, since old queued
payloads cannot be decrypted by the new secret. Verification codes and reset
tokens are never returned in API responses or written to application logs.

Without a provider, delivery is not completed: the job records/retries the
outbox item and the admin health page reports configuration/degradation. Test
with provider-owned addresses/numbers in staging, including actual arrival,
expiry, resend limits, provider failure, and recovery; there is no email/SMS
provider or delivery evidence bundled with this repository.

---

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Tailwind watcher and Node server for local development |
| `npm run build:css` | Build the minified stylesheet before packaging/deploying |
| `npm start` | Start the server; the Docker image applies pending migrations before server startup |
| `npm run db:migrate` | Apply ordered pending migrations. Existing unversioned installs are adopted only after baseline-table/column checks; this does not replay baseline DDL over them. |
| `npm run db:migrate -- --target=0001` | Apply only the baseline to a new isolated database (used by migration CI). |
| `npm run db:migrate -- --fresh` | Destructive development-only rebuild. Requires `ALLOW_DESTRUCTIVE_RESET=1` and `CONFIRM_DROP_DATABASE=<exact DB_NAME>`; disabled in production. Never use on real data. |
| `npm run db:seed` | Destructive demo seeder for local throwaway databases only; it may clear rows. Do not run it on a populated or production database. |
| `npm run db:reset` | `--fresh` plus demo seed; only for an explicitly disposable local database. |
| `BOOTSTRAP_ADMIN_USERNAME=handle npm run admin:bootstrap` | One-time, locked and audited bootstrap of the first active account after migrations. See [Admin console and RBAC](#admin-console-and-rbac). |
| `npm run lint` | ESLint across server, browser modules, migrations and scripts |
| `npm test` | Dependency/config/migration-safety smoke checks; no database required |
| `npm run test:security` | DB-free RBAC, CSRF, token, and migration-history unit tests |
| `npm run test:browser -- --base http://127.0.0.1:3000` | Playwright browser suite; requires Chromium, a running server, and disposable seeded demo accounts. Install browser with `npx playwright install chromium`. |
| `npm run deploy:check -- --offline` | Offline production configuration preflight |
| `npm run sweep -- --base https://your-host --auth --demo` | Walk a running host: 17 pages, referenced assets, auth/CSRF behavior, 404s, and theme paint |
| `npm audit --audit-level=high` | Check the locked dependency tree; CI uses the same blocking threshold |

The CI-only `scripts/security-integration.mjs` creates synthetic accounts, content,
and encrypted-outbox records in a local MySQL database named `ember_ci`, exercises
API/DB controls, then cleans up. It requires explicit opt-in, `CI=true`, a local
API and local DB host, and refuses any other database name or production mode.
Do not repoint it at a shared or production database. CI also runs a real MySQL 8
migration exercise, the route sweep, Socket.IO suite, and Chromium browser suite.

---

## Finding someone by username

Every account has a unique public handle: 3–30 characters, lowercase letters,
digits, dots and underscores, starting and ending alphanumeric (`amara`,
`kelechi.shoots`, `tunde_a`). It is chosen at sign-up — step 1 of the wizard
checks availability live — and can be changed later on the profile page.

Search is for the case the swipe deck cannot serve: you already know who you
are looking for. Open it from the sidebar, the mobile header, or by pressing
`/`, then type a handle. Results show the relationship you already have with
each person, so the right action is always one tap away:

| State                       | Action shown |
| --------------------------- | ------------ |
| Never swiped                | **Like** — records a normal like; if they already liked you it becomes a match immediately |
| You already liked them      | **Liked** (disabled) |
| Already matched             | **Message** — jumps straight to the conversation |

The endpoint applies exactly the same visibility rules as the deck: you never
see yourself, and anyone either of you has blocked is filtered out in both
directions. Matching this way goes through the same `recordSwipe` transaction
as a swipe, so the `match:new` socket event, badges and conversation creation
all behave identically.

Handles are reserved against a blocklist (`admin`, `api`, `login`, `support`,
…) so they cannot collide with routes or impersonate the product. Duplicate
handles return `409 USERNAME_TAKEN` — deliberately specific, since handles are
public anyway, unlike duplicate emails which stay vague to avoid disclosing who
has an account.

---

## Discovery features

Beyond the swipe deck, the app has the surfaces people expect from a modern
dating product. Everything below is unlocked — there is no billing system, and
no feature is paywalled.

| Surface | Where | What it does |
| --- | --- | --- |
| **People Nearby** | `/nearby` | A browsable grid of people around you, closest first, with a distance filter. Browsing here does not consume a swipe. |
| **Bumped into** | `/nearby` → tab | People you were physically close to (within 250 m, inside a 30-minute window). Both sides must have it enabled. |
| **Likes you** | `/likes` | Everyone who liked or super-liked you and is not yet a match. |
| **Visitors** | `/likes` → tab | Who opened your profile, how recently, and which surface they came from. |
| **Taps** | `/likes` → tab | Lightweight nudges — wave, crush or fire — that do not use a swipe. |
| **Favourites** | `/likes` → tab | A private bookmark list. |
| **Top picks** | `/likes` → tab | Eight curated profiles a day, ranked by shared interests, then verification, then distance. The order is stable for the whole day. |
| **Interests** | `/profile` | Up to 8 tags from a shared vocabulary. Shared ones are highlighted on every card as "you both like…". |
| **Prompts** | `/profile` | Up to 3 Q&A answers that give people something to reply to. |
| **Dating intent** | `/profile` | Long-term, casual, friends, or still figuring it out. |
| **Photo verification** | `/settings` | A randomly chosen selfie pose is submitted for manual review; a moderator grants the blue tick only after approval. See the note below. |
| **Discovery filters** | `/settings` | Age range, maximum distance, verified-only, online-only. |
| **Passport** | `/settings` | Browse another city before you travel there. |
| **Incognito** | `/settings` | Browse without appearing in Nearby or leaving a visit behind. |
| **Boost** | `POST /api/discovery/boost` | 30 minutes at the top of the deck. |
| **Safety nudges** | chat | "Are you sure?" before sending something hurtful, and "does this bother you?" for the recipient. |

### A note on verification

Photo verification is **manual-review only**. `submitVerification()` validates
the issued pose challenge and stores a `pending` request; it never grants a
badge. A moderator with the verification-review permission inspects the private
evidence in the admin console and explicitly approves or rejects it. Only an
approval sets the verified badge. After either decision, the evidence is removed
from reviewer access and queued for durable storage deletion; failed unlinks are
retried by the cleanup worker. There is no automated liveness model, so review
and provider/operational readiness still need to be verified on staging.

---

## Live location and privacy

Location is the most sensitive thing this app stores, so the rules are strict
and enforced server-side.

**Nothing is stored until the user opts in.** The browser prompt is only
triggered by an explicit action ("Turn on location"), never on page load.

**Three modes**, chosen by the user in `/settings`:

| Mode | What is stored |
| --- | --- |
| `precise` | Exact coordinates. Required for "bumped into". |
| `approximate` *(default)* | Snapped to a ~1.1 km grid **before** it is written, so the database never holds the exact point. |
| `hidden` | Nothing. Selecting it also **erases** any position already held. |

**Other people never receive coordinates.** The API returns a bucketed string —
`"under 1 km away"`, `"4 km away"`, `"25 km away"` — and rounds harder as the
distance grows. Raw latitude and longitude are returned only for the requester's
own record, and for a location a peer deliberately shared in a chat. The browser
test suite asserts this: it fails if anything resembling a coordinate appears in
the Nearby grid.

**Live shares in chat expire twice over.** A share runs for 15, 30 or 60 minutes,
and it is also bound by the 24-hour message rule — `message_locations` rows carry
their own `expires_at` and cascade with the parent message.

**The kill switch is real.** "Erase stored location" issues a `DELETE`, not a
flag; the cleanup job additionally drops any position untouched for 30 days and
any encounter older than 30 days.

**No third-party map tiles.** A map provider would receive our users'
coordinates on every render, and the strict CSP forbids remote images anyway.
Shared locations render as a locally generated SVG; an external map only opens
when the user clicks through.

---

## Private communication

### End-to-end encrypted messages

Messages are encrypted **in the browser** before they are sent. This is real
E2EE, not database-at-rest encryption:

- Keys are generated with WebCrypto (ECDH P-256 → AES-GCM 256). The private
  key is stored **non-extractable** in IndexedDB, so no script can read it out.
- The server stores **public keys only**. There is no `private_key` column in
  the schema and no decrypt function on the server.
- The conversation key is wrapped once per recipient device, so adding a
  second device does not expose anyone else's copy.

Open **Encryption details** from the chat menu (or tap the badge in the
banner) to see the safety number. Compare it with the other person out of band
to be sure nobody is relaying keys in the middle.

**What it does not do:** it does not hide who you talk to or when, it cannot
protect a device someone else can unlock, and it cannot prevent screenshots.

A message sealed before you signed in on a given device cannot be read on that
device — the key never existed there. The chat says so explicitly rather than
showing a blank bubble.

### Custom disappearing timers

Either person can set how long new messages live: 1 hour, 6 hours, 12 hours,
**24 hours (default)**, 3 days, or 7 days.

- **Changes apply to new messages only.** `expires_at` is stamped when a
  message is written, so nobody can retroactively extend — or shorten — a
  message that was already sent under a different timer.
- **Enforcement is server-side.** Every read filters on the database clock, so
  an expired message is unreachable the moment it lapses, whether or not the
  cleanup job has run.
- A change is announced in the thread, so it never happens silently.

## Moments and 24-hour posts

`/moments` is the social half of the app — a sixth item in the sidebar and a
fifth tab on mobile. Both surfaces live under the same 24-hour rule as chat:
the database clock owns expiry, every payload carries `secondsLeft`, and the
cleanup job removes the rows and the files.

**Moments** are photo, video or text cards (text cards get a choice of five
gradients). They appear as a tray of rails at the top of the page and play in
a full-screen viewer with progress pips, prev/next and Escape-to-close.

- The **owner** sees a view count and can open the viewer list. Everyone else
  never receives the `viewCount` field — it is omitted from the payload, not
  hidden in the UI.
- Six reactions (❤️ 🔥 😂 😮 😍 👏), one per person; picking a second replaces
  the first instead of stacking.
- **Replying opens a real DM**, not a side channel. The reply is created
  through the same message service as the rest of chat, so it inherits the
  conversation's disappearing timer and read receipts. Because a DM needs a
  conversation, replying is limited to people you have matched with — anyone
  else gets a plain-language explanation rather than a dead button.

**Posts** are text plus up to four photos or videos, with an optional poll of
two to four options. They support likes, comments and one level of replies,
and the feed is cursor-paginated for infinite scroll. Poll percentages are
computed on the server; changing your vote moves it rather than adding one.

**Every card can be reported** — profiles, messages, photos, posts, moments
and comments, against nine reasons (scam, fake profile, impersonation,
harassment, spam, threats, inappropriate content, intimate images shared
without consent, other). The reported content is snapshotted when the report
is filed, so deleting it afterwards does not destroy the evidence. Blocking
hides content in both directions.

Media is served from `/api/social-media/:name` behind an authorisation check
that runs **on every read** and resolves through the owning post or moment —
so expiry, deletion and blocking all revoke a link automatically. A URL that
leaks is not a credential. See [Security notes](#security-notes).

## Light and dark mode

Every screen ships in both themes. There are three modes — **Light**, **Dark**
and **System** — chosen from the sun/moon button in the sidebar (or the mobile
header), or from **Settings → Appearance**.

### How a colour knows how to flip

No screen contains hand-written `dark:` variants. Instead the palette is
expressed as **semantic tokens**, and only the token definitions change:

```css
:root      { --c-surface: 255 255 255; --c-ink: 17 20 24;    ... }
.dark      { --c-surface:  26  23  30; --c-ink: 244 241 246; ... }
```

`tailwind.config.js` maps those channels back into ordinary utilities with
`rgb(var(--c-surface) / <alpha-value>)`, so `bg-surface`, `text-ink`,
`border-hairline`, `shadow-card` and friends keep working with opacity
modifiers and simply mean something different once `.dark` is on `<html>`.
Adding a new screen requires no dark-mode work: use the semantic utilities
(`bg-surface`, `text-ink`, `text-ink-soft`, `border-hairline`) rather than
`bg-white` or `text-slate-900` and it themes itself.

The dark palette is a **warm charcoal-plum**, not the blue-grey slate common to
developer tools, so the brand stays warm at night. Brand purple lightens to
`#C68DE8` in the dark so it clears 4.5:1 against the dark surface.

A few colours are deliberately fixed in both themes: photo-card gradients, the
call screen's video stage, and white text sitting on brand gradients.

### No flash of the wrong theme

The strict CSP (`script-src 'self'`) forbids the usual inline anti-FOUC
`<script>`, so the **server** resolves the theme instead. `sendPage()` in
`server/server.js` reads the `ec_theme` cookie — falling back to the
`Sec-CH-Prefers-Color-Scheme` client hint when the mode is `system` — and
stamps `<html lang="en" class="dark">` into the HTML before it is sent.
The correct theme is therefore present in the very first paint. Responses set
`Vary: Cookie, Sec-CH-Prefers-Color-Scheme` so caches never cross the streams.

The preference lives in a one-year `ec_theme` cookie (`light`/`dark`/`system`),
not in `localStorage` — the lint config bans web storage in `public/js`, and a
cookie is the only store the server can read at render time. In `system` mode
the client also listens to `prefers-color-scheme` and flips live when the OS
theme changes, with no reload.

`public/js/theme.js` owns the client half: `getTheme()`, `setTheme(mode)`,
`toggleTheme()`, `onThemeChange(fn)`, `initThemeToggle()` and
`initThemeChoice()`. It also injects the sun/moon icon, keeps `aria-pressed`
and the button label honest, and syncs `<meta name="theme-color">` so mobile
browser chrome matches. Colour transitions are enabled only after first paint
(the `theme-ready` class) and are disabled entirely under
`prefers-reduced-motion`.

---

## How the 24-hour deletion works

Ephemerality is enforced at **four independent layers**. Any one of them alone
would leak data eventually; together, an expired message cannot be read, cannot
be re-fetched, and does not survive on disk.

### Layer 1 — the schema decides the deadline

`expires_at` is computed with the database clock, never trusted to the client.
Messages and attachments carry it, and moments/posts use the same server-side
expiry rule. The indexed deadline lets user-facing reads filter expired content
while the cleanup worker finds rows to reclaim.

### Layer 2 — every read query filters on it

User-facing conversation history, unread counts, attachment downloads and
realtime history filter on the database expiry deadline. Chat attachment reads
recheck the attachment row; social-media reads resolve through the live
moment/post that owns the file. So even if cleanup stops, expired content is no
longer returned by normal REST, socket-history or media routes; moderation
evidence is governed by its separate access controls.

### Layer 3 — a cron job actually deletes the data

`server/src/jobs/cleanup.js` runs **once on boot and then every 5 minutes**
(`*/5 * * * *`, via `node-cron`). Media ownership changes first insert storage
keys into `media_deletion_queue` in the same database transaction that removes
or expires the owning row. A worker pass then:

1. Retries queued file deletions. Missing files count as idempotent success;
   transient storage failures stay queued with an incremented attempt count.
2. Expires abandoned chat/social uploads and content rows. It queues original
   and thumbnail keys before deleting their database references, then attempts
   those unlinks immediately.
3. Hard-deletes expired chat messages, moments, posts and comments, and removes
   stale conversations, location records, encounters and tokens.
4. Logs aggregate counts only; it never writes storage paths or message bodies
   to logs.

The pass is wrapped in `try/catch`; a database or worker error is logged and the
next scheduled run retries durable queue entries. Profile photos do **not** use
the 24-hour content TTL: they remain until the owner removes them or deletes
their account.

```text
[cleanup] run complete {"deletedMessages":4,"deletedFiles":2,"failedMediaDeletions":0,"durationMs":30}
```

### Layer 4 — the client counts down and removes it live

Every bubble carries a TTL chip that updates once per second, corrected for
clock skew between browser and server (the server sends `serverTime` with each
history payload):

* more than 1 hour left → grey chip, e.g. `23h 41m`
* under 1 hour → **amber** chip
* under 10 minutes → **red** chip, counting seconds (`4:58`)

At zero the bubble fades out, is removed from the DOM, and a screen-reader
announcement fires: *"A message expired and was deleted."* A persistent banner
above the thread states the rule and names the next message due to vanish.

### Clearing a chat by hand

"Clear chat" in the thread menu expires every message for **both** users by
setting `expires_at` to `NOW()`. They disappear from user-facing reads
immediately (Layer 2). The service queues attachment keys before changing their
expiry and attempts file removal after commit; failed removals remain in the
outbox for retry, while the cleanup worker later hard-deletes the rows.

### Watching it happen quickly

Set a short TTL and restart:

```bash
MESSAGE_TTL_HOURS=0.02 npm start   # ~72 seconds
```

Send a message, watch the chip go amber then red, and see the bubble remove
itself. Then confirm the row is gone:

```sql
SELECT id, body, expires_at FROM messages ORDER BY id DESC LIMIT 5;
```

**Exempt from expiry:** `call_logs` are deliberately retained. They record who
called whom, when, for how long, and the outcome — metadata, never content.

---

## Testing video calls

WebRTC needs a secure context. `http://localhost` counts as secure, so **two
browser windows on the same machine work with no extra setup.**

1. Sign in as `amara@example.com` in a normal window.
2. Sign in as `kelechi@example.com` in a **private/incognito** window (a separate
   cookie jar — two tabs in the same profile share a session).
3. In Amara's window open the match with Kelechi and press the **video** or
   **phone** icon in the chat header.
4. Kelechi's window shows the incoming-call prompt. Accept it.
5. Grant camera/microphone permission when the browser asks.

You should see the remote video full-bleed, your own camera in a
picture-in-picture tile, a running timer, and a connection-quality dot.

**Controls:** mute (also `M`), camera on/off, hang up (also `Esc`).

**Handled edge cases:** callee offline, callee already on another call, no
answer after 35 s, declined, permission denied, no camera present, camera busy
in another app, and mid-call network loss (one automatic ICE restart before the
call is marked failed).

### Calling across different networks

Two devices behind different routers usually still connect through STUN alone.
Symmetric NAT or restrictive corporate firewalls need a TURN relay:

```env
TURN_URL=turn:turn.example.com:3478
TURN_USERNAME=ember
TURN_CREDENTIAL=super-secret
```

`GET /api/ice-servers` serves this to the client at call time. Credentials are
never baked into any static asset.

> Testing from another device on your LAN? Browsers block `getUserMedia` on a
> plain-HTTP origin that is not `localhost`. Put the app behind HTTPS, or use an
> `ngrok`/`cloudflared` tunnel, and set `APP_ORIGIN` to match.

---

## Architecture

```
Browser (vanilla ES modules)                 Node.js / Express (ESM)
┌──────────────────────────┐                ┌────────────────────────────┐
│ public/*.html            │  fetch + XHR   │ REST  /api/*               │
│ public/js/*.js  ─────────┼───────────────►│  routes → controllers      │
│   api.js   (REST client) │                │        → services → SQL    │
│   socket.js(realtime)  ◄─┼── Socket.IO ──►│ sockets/                   │
│   chat.js / deck.js      │                │  chat.handler.js           │
│   call.js  (WebRTC)      │                │  call.handler.js (signal)  │
└──────────┬───────────────┘                └─────────────┬──────────────┘
           │                                              │
           │  media flows peer-to-peer, never via us      │ mysql2 pool
           └──────────── RTCPeerConnection ───────┐       │  (raw SQL)
                                                  ▼       ▼
                                            other peer   MySQL 8
                                                          ▲
                                        node-cron every 5 min
                                        (24h purge + file unlink)
```

**Request path.** `routes` validate nothing themselves; they attach middleware
(`requireAuth`, `csrfProtection`, rate limiters) and delegate to a controller.
Controllers parse input with **zod** and shape the response. **Services** own
all SQL and business rules. Nothing above the service layer writes SQL, and
every query is parameterised — there is no string concatenation anywhere in a
statement.

**Why raw SQL.** Ephemerality is a data-lifetime concern. An ORM would hide the
`expires_at > NOW()` predicate that every read depends on; keeping the SQL
explicit makes the guarantee auditable in one `grep`.

**Realtime.** Socket.IO authenticates in `io.use()` by reading the same
httpOnly access-token cookie the REST API uses — no token is ever sent through
a query string. Each socket joins `user:<id>`; opening a thread joins
`conv:<id>` only after a participant check. Messages are rate-limited to 20 per
10 seconds per socket.

**Delivery guarantees.** The client generates a `client_uuid` per message and
`messages` has `UNIQUE (conversation_id, client_uuid)`, so a retry after a
flaky reconnect can never duplicate a bubble. Sending falls back to REST if the
socket is down, and the optimistic bubble is reconciled by that same UUID.

**Storage.** Uploads go through a small abstraction
(`services/storage.service.js`) exposing `save`/`read`/`remove`/`stat`. Local
disk is the default; swapping in S3 means implementing that interface, and no
caller changes. Files are never served statically — `/api/media/:id` checks
that the requester is a participant, refuses expired attachments, sets
`Cache-Control: private, no-store`, and supports range requests for video.

---

## Project structure

```
.
├── db/
│   ├── schema.sql           # documentation copy of immutable 0001 baseline
│   ├── migrations/          # ordered, checksummed SQL versions (0001–0004)
│   ├── migrate.js           # safe pending-migration runner; guarded --fresh only for disposable DBs
│   └── seed.js              # destructive local demo seeder
├── public/                  # everything served to the browser
│   ├── index.html           # landing page
│   ├── login.html
│   ├── register.html        # multi-step wizard
│   ├── forgot-password.html # generic recovery request form
│   ├── reset-password.html # fragment-token password reset
│   ├── admin.html           # permission-aware staff dashboard
│   ├── app.html             # swipe deck
│   ├── matches.html         # match roster (tiles)
│   ├── chats.html           # conversation list
│   ├── chat.html
│   ├── call.html            # WebRTC call stage
│   ├── profile.html
│   ├── 404.html
│   ├── css/app.css          # BUILT by Tailwind - do not edit
│   ├── fonts/               # self-hosted Inter + Poppins woff2
│   └── js/
│       ├── api.js           # REST client, CSRF, single-flight 401 refresh
│       ├── match-rows.js    # row/tile builders shared by Matches + Chats
│       ├── socket.js        # Socket.IO lifecycle + clock-skew tracking
│       ├── ui.js            # DOM helpers, modals, toasts, formatters
│       ├── app-shell.js     # session boot, nav, badges, notifications
│       ├── notifications.js  # notification centre: bell, live badge, sheet, deep links
│       ├── deck.js          # swipe gestures + keyboard controls
│       ├── chat.js          # thread, TTL countdown, uploads
│       ├── call.js          # RTCPeerConnection, ICE, call state machine
│       └── *-page.js        # one thin entry module per page (CSP-safe)
├── scripts/
│   ├── dep-smoke.mjs        # `npm test`: dependency/config/migration checks, no DB
│   ├── security-integration.mjs # guarded synthetic MySQL/API security suite (CI only)
│   ├── bootstrap-admin.mjs  # one-time, locked, audited initial-admin path
│   ├── deploy-check.mjs     # public-host configuration preflight
│   ├── smoke-socket.js      # Socket.IO handshake + chat round trip
│   ├── smoke-browser.js     # Playwright end-to-end browser suite
│   ├── cpanel-build.sh      # cPanel production dependency + CSS build
│   ├── run-cleanup.mjs      # optional cPanel cron cleanup entrypoint
│   └── run-delivery.mjs     # optional cPanel cron delivery entrypoint
├── server/
│   ├── server.js            # Express app, helmet/CSP, routes, bootstrap
│   └── src/
│       ├── config/env.js    # env parsing, cookie options
│       ├── db/pool.js       # mysql2 pool + query/execute/withTransaction
│       ├── middleware/      # auth, csrf, rate limits, multer, https upgrade
│       ├── routes/          # thin route tables
│       ├── controllers/     # zod validation + response shaping
│       ├── services/        # all SQL and business rules
│       ├── sockets/         # chat + WebRTC signalling handlers
│       ├── jobs/cleanup.js  # the 24-hour purge
│       └── utils/           # logger, typed errors, zod schemas
├── deploy/
│   ├── vps.sh               # provisions a bare VPS: docker, compose, Caddy, TLS
│   ├── roll.sh              # moves a VPS onto a published image, health-gated
│   └── Caddyfile            # auto-HTTPS reverse proxy for the single-box setup
├── src/input.css            # Tailwind source + design system
├── tailwind.config.js       # brand palette, shadows, keyframes
├── Dockerfile               # multi-stage: builds the CSS, ships prod deps only
├── docker-compose.yml       # app + MySQL 8 + uploads volume, loopback-published
├── render.yaml              # Render blueprint (external MySQL; see DEPLOY.md)
├── fly.toml                 # Fly.io app with a volume for uploads
├── .dockerignore
├── .github/workflows/       # ci.yml (lint/test/audit/image) + publish.yml (ghcr)
├── app.js                   # cPanel / Passenger startup entrypoint
├── eslint.config.js
├── CPANEL.md                # cPanel setup, cron and host limitations
├── DEPLOY.md                # host comparison and the exact deploy commands
├── LICENSE                  # MIT
├── README.md
└── TESTING.md
```

---

## API reference

All routes are JSON. Every mutating request needs the `X-CSRF-Token` header
(read it from the non-httpOnly `ec_csrf` cookie). Authentication is by cookie —
no `Authorization` header, ever.

### Auth — `/api/auth`

| Method | Path        | Body / notes                                            |
| ------ | ----------- | ------------------------------------------------------- |
| POST   | `/register` | `{email, username, password, displayName, birthdate, gender, interestedIn}` |
| POST   | `/login`    | `{email, password}` → sets cookies, returns `{user, csrfToken}` |
| POST   | `/refresh`  | Rotates the refresh token                               |
| POST   | `/logout`   | Clears cookies, revokes the refresh token               |
| GET    | `/me`       | `{user, csrfToken, config}`                             |
| GET    | `/username-available` | `?username=` → `{username, available}` — public, for live sign-up feedback |
| POST   | `/forgot-password` | `{email}` → same generic response for known/unknown accounts; reset token only goes to encrypted delivery outbox |
| POST   | `/reset-password` | `{token, password}` — one-use token; atomically changes password and revokes prior sessions |

### Users — `/api/users`

| Method | Path             | Notes                                        |
| ------ | ---------------- | -------------------------------------------- |
| GET    | `/deck`          | `?limit=` — profiles not yet swiped          |
| GET    | `/search`        | `?q=&limit=` — find people by username or display name |
| GET    | `/me/profile`    | Own profile, photos, likes received          |
| PATCH  | `/me`            | Partial profile update                       |
| POST   | `/me/photos`     | `multipart/form-data`, field `photo`         |
| PATCH  | `/me/photos/order` | `{order: [photoId, …]}` — first is the avatar |
| DELETE | `/me/photos/:id` | Remove an owned photo and thumbnail          |
| POST   | `/me/verify/start` | `{kind:'email'\|'phone', phone?}` — issue a code; code is never in the response |
| POST   | `/me/verify/confirm` | `{kind, code}` — attempt-limited, one-use confirmation |
| DELETE | `/me`            | Delete the account and enqueue owned media for deletion |
| POST   | `/blocks`        | `{blockedId}`                                |
| POST   | `/reports`       | `{reportedId, reason}`                       |
| GET    | `/:id`           | Public profile — `?from=nearby\|search\|deck\|…` records the visit |

### Moments — `/api/moments`

| Method | Path            | Notes                                                     |
| ------ | --------------- | --------------------------------------------------------- |
| GET    | `/` `/feed`     | Rails grouped by author, each with `hasUnseen`             |
| GET    | `/user/:userId` | One person's live moments                                  |
| POST   | `/`             | `{kind:'photo'\|'video'\|'text', body, background, media}` |
| GET    | `/:id`          | Detail incl. the per-emoji reaction breakdown              |
| DELETE | `/:id`          | Owner only                                                 |
| POST   | `/:id/view`     | Records a view (idempotent)                                |
| GET    | `/:id/viewers`  | **Owner only** — who watched                               |
| POST   | `/:id/react`    | `{emoji}` — one per user, replaces                         |
| DELETE | `/:id/react`    | Remove your reaction                                       |
| POST   | `/:id/reply`    | `{body}` → a real DM; **403 unless matched**               |

### Posts — `/api/posts`

| Method | Path             | Notes                                                  |
| ------ | ---------------- | ------------------------------------------------------ |
| GET    | `/` `/feed`      | `?limit=&before=&userId=` → `{posts, nextCursor}`      |
| POST   | `/`              | `{body, media[≤4], poll:{options[2–4]}}`               |
| GET    | `/:id`           | Single post                                            |
| DELETE | `/:id`           | Owner only                                             |
| POST   | `/:id/like`      | Idempotent toggle → `{liked, alreadyLiked, count}`     |
| POST   | `/:id/vote`      | `{optionId}` — changeable; returns the refreshed post  |
| GET    | `/:id/comments`  | One level of replies, `{comments, total}`              |
| POST   | `/:id/comments`  | `{body, parentId?}` — inherits the post's expiry       |

`POST /api/comments/:id/like` · `DELETE /api/comments/:id` (author or post owner).

### Reports — `/api/reports`

| Method | Path                        | Notes                                            |
| ------ | --------------------------- | ------------------------------------------------ |
| POST   | `/`                         | `{targetType, targetId, reason, details}` — snapshots the content |
| GET    | `/:targetType/:targetId`    | `{reported}` — so the UI can say "already reported" |

`targetType` ∈ profile · message · photo · post · moment · comment.
`reason` ∈ scam · fake · impersonation · harassment · spam · threats ·
inappropriate · ncii · other.

### Moderation — `/api/admin`

Every route requires an authenticated account and an explicit permission. An
authenticated account without that permission receives **404**, not 403, to
avoid confirming the staff surface exists. Mutations also require CSRF.

| Method | Path | Permission holders | Notes |
| --- | --- | --- | --- |
| GET | `/whoami` | All staff | Current role and explicit permission list |
| GET | `/overview` | Analyst, moderator, admin | Real database-backed aggregates; zero denominators are shown as unavailable |
| GET | `/health` | Admin | Live database/outbox/configuration checks; not an external uptime SLA |
| GET | `/settings` | Admin | Read-only, secret-free runtime settings |
| GET | `/reports`, `/reports/:id` | Support, moderator, admin | Queue/history; message text is redacted |
| GET/POST | `/reports/:id/notes` | Support, moderator, admin | Notes; POST requires CSRF |
| POST | `/reports/:id/assign`, `/reports/:id/resolve` | Moderator, admin | Assignment and state transitions are audited |
| GET | `/users`, `/users/:id` | Support, moderator, admin | Email/phone appear only for admin/super-admin permissions |
| POST | `/users/:id/suspend`, `/users/:id/restore` | Moderator, admin | Banned-account restoration is admin-only |
| POST | `/users/:id/ban`, `/users/:id/role` | Admin | Permanent ban / role assignment; no self-promotion or equal/higher-rank grant |
| POST | `/content/remove` | Moderator, admin | Soft deletion retains the content row for moderation context |
| GET | `/verifications` | Moderator, admin | Pending review queue |
| GET/POST | `/verifications/:id/evidence`, `/verifications/:id/review` | Moderator, admin | Private evidence; only reviewer permission; review decision is audited |
| GET | `/audit`, `/activity` | Auditor, admin | Privacy-filtered; sensitive audit IP fields are admin-only |

`support_agent`, `analyst`, `moderator`, and `auditor` are separate capability
sets, not inherited ranks. `super_admin` is the only wildcard role. The service
re-reads the actor's current role in mutation transactions, so a stale browser
or token role cannot authorize a write. Target-rank and self-action checks are
also enforced server-side. Successful privileged changes write audit/activity
records in the same database transaction; denied actions do not commit a
mutation or a success audit event.

**Sanctions apply to live sessions.** `requireAuth`, `optionalAuth` and
`socketAuth` all re-check `status`, so a ban or suspension takes effect on the
next request and the next socket handshake rather than when the access token
happens to expire. A lapsed suspension restores itself automatically.

Content takedown is a soft delete (`deleted_at`/`deleted_by`): the row is
evidence, and reported content is ephemeral enough that a hard delete would
routinely destroy the context behind an open report. The dashboard lives at
`/admin`, and its sidebar link is rendered only for staff.

### Swipes, matches, messages

| Method | Path                            | Notes                                            |
| ------ | ------------------------------- | ------------------------------------------------ |
| POST   | `/api/swipes`                   | `{swipeeId, direction:'like'\|'pass'\|'superlike'}` → `{matched}` |
| POST   | `/api/swipes/rewind`            | Undo the last swipe                              |
| GET    | `/api/swipes/likes-received`    | `{count}`                                        |
| GET    | `/api/matches`                  | Matches, conversations, unread totals            |
| DELETE | `/api/matches/:id`              | Unmatch                                          |
| GET    | `/api/conversations/:id`        | `{conversationId, matchId, peer}`                |
| GET    | `/api/conversations/:id/messages` | `?before=&limit=` — unexpired only             |
| POST   | `/api/conversations/:id/messages` | `{body?, clientUuid?, attachmentId?}`          |
| DELETE | `/api/conversations/:id/messages` | Clear the chat for both users                  |
| POST   | `/api/conversations/:id/read`   | Mark as read                                     |

### Discovery — `/api/discovery`

| Method | Path                 | Notes                                                     |
| ------ | -------------------- | --------------------------------------------------------- |
| GET    | `/location`          | Your own stored position                                   |
| POST   | `/location`          | `{lat, lng, accuracy?, city?}` — honours your privacy mode |
| DELETE | `/location`          | Erase the stored position                                  |
| GET    | `/nearby`            | `?radiusKm=&limit=&offset=&onlineOnly=`                    |
| GET    | `/bumped`            | `?days=&limit=` — recent physical run-ins                  |
| GET    | `/top-picks`         | Eight curated profiles, stable for the day                 |
| GET    | `/likes-you`         | People who liked you and are not yet matched               |
| GET    | `/visitors`          | Who viewed your profile                                    |
| GET    | `/counters`          | `{likes, taps, visitors, boost}` for the nav badges        |
| GET    | `/favorites`         | Your bookmark list                                         |
| POST   | `/favorites`         | `{targetId}`                                               |
| DELETE | `/favorites/:id`     |                                                            |
| GET    | `/taps`              | Taps you have received                                     |
| POST   | `/taps`              | `{targetId, kind:'wave'\|'crush'\|'fire'}`                |
| POST   | `/taps/seen`         | Clear the taps badge                                       |
| GET    | `/boost`             | Active boost, if any                                       |
| POST   | `/boost`             | Start a 30-minute boost                                    |
| GET    | `/settings`          | Filters and privacy switches                               |
| PATCH  | `/settings`          | Partial update                                             |
| POST   | `/passport`          | `{lat, lng, label}`                                        |
| DELETE | `/passport`          | Back to your real location                                 |
| GET    | `/interests`         | The interest vocabulary, grouped by category               |
| GET/PUT| `/me/interests`      | `{slugs: […]}` — replaces the whole set, max 8             |
| GET    | `/prompts`           | The prompt catalogue                                       |
| GET/PUT| `/me/prompts`        | `{prompts: [{key, answer}]}` — max 3                       |
| GET    | `/verification`      | Your verification status                                   |
| GET    | `/verification/challenge` | The pose you must copy                                |
| POST   | `/verification`      | `multipart/form-data`, fields `gesture` + `photo`          |

### Location in chat

| Method | Path                                            | Notes                                   |
| ------ | ----------------------------------------------- | --------------------------------------- |
| POST   | `/api/conversations/:id/location`               | `{lat, lng, accuracy?, label?, liveMinutes?}` |
| PATCH  | `/api/conversations/:id/location/:messageId`    | Move an in-flight live share            |
| DELETE | `/api/conversations/:id/location/:messageId`    | Stop sharing early                      |
| POST   | `/api/conversations/:id/check`                  | Pre-send safety advisory (no side effects) |

### Media and system

| Method | Path                  | Notes                                                  |
| ------ | --------------------- | ------------------------------------------------------ |
| POST   | `/api/uploads`        | `multipart/form-data`, field `file` → attachment record |
| GET    | `/api/media/:id`      | `?variant=thumb\|full`; auth-gated, range-capable      |
| GET    | `/api/photos/:filename` | Active profile photos; share links work signed out, while signed-in block checks still apply |
| GET    | `/api/ice-servers`    | STUN/TURN configuration                                |
| GET    | `/api/health`         | `{status: "ok", uptimeSecs, ttlHours, time}`; not a DB or provider health check |

---

## Socket.IO event contract

Rooms: `user:<userId>` (every socket) and `conv:<conversationId>` (joined on
demand, after a participant check).

**Client → server** — all take an ack callback returning `{ok:true, …}` or
`{ok:false, error}`:

| Event           | Payload                                            |
| --------------- | -------------------------------------------------- |
| `chat:join`     | `{conversationId}` → ack carries history + `serverTime` |
| `chat:leave`    | `{conversationId}`                                 |
| `chat:message`  | `{conversationId, body?, clientUuid, attachmentId?}` |
| `chat:typing`   | `{conversationId, isTyping}`                       |
| `chat:read`     | `{conversationId}`                                 |
| `chat:sync`     | `{conversationId, since}` — catch up after a reconnect |
| `presence:ping` | keep-alive                                         |
| `call:invite` / `accept` / `decline` / `offer` / `answer` / `ice-candidate` / `end` / `failed` | WebRTC signalling |

**Server → client:**

`ready`, `presence:update`, `match:new`, `match:removed`, `chat:joined`,
`chat:message`, `chat:message:notify`, `chat:message:expired`, `chat:typing`,
`chat:read`, `chat:cleared`, `call:incoming`, `call:accepted`, `call:declined`,
`call:offer`, `call:answer`, `call:ice-candidate`, `call:ended`,
`server:shutdown`, `error`.

Discovery adds four more server → client events:

| Event                   | Payload                                        |
| ----------------------- | ---------------------------------------------- |
| `nearby:bumped`         | `{user, proximity, at}` — you just crossed paths |
| `tap:received`          | `{user, kind, at}`                             |
| `chat:location:update`  | `{conversationId, messageId, lat, lng, updatedAt}` — a live pin moved |
| `chat:location:stopped` | `{conversationId, messageId}`                  |

---

## Admin console and RBAC

The staff console is at `/admin`; its data comes from the authenticated `/api/admin`
endpoints. The dashboard includes database-backed analytics, moderation reports,
user search/detail and sanctions, verification review, audit/activity views,
health checks, and a read-only runtime-settings summary. Settings are not
editable in the dashboard. Health is observed at request time; it is not an
uptime guarantee or a provider probe for every dependency.

Roles are permission sets, not an ordinal ladder. Sibling staff roles do not
inherit each other's permissions. The server enforces every route, re-checks the
actor's current database role inside mutation transactions, and returns a
non-enumerating `404` to authenticated accounts without access. Mutations also
require CSRF. Only administrators see account email/phone PII; the UI is not the
security boundary.

| Role | Scope |
| --- | --- |
| `support_agent` | Read sanitized reports and notes; basic user lookup/detail without email or phone |
| `analyst` | Read aggregate, database-backed analytics only |
| `moderator` | Reports/notes/assignment, suspend/restore, soft content removal, and manual verification review |
| `auditor` | Read privacy-filtered audit and activity records; no moderation or PII |
| `admin` | Sensitive user/audit access, role management, bans, moderation, verification, analytics, health, and secret-free settings |
| `super_admin` | Explicit wildcard permission; use sparingly and audit access |

### Bootstrap the first administrator

1. Apply every current migration with `npm run db:migrate`.
2. Create the account through the normal sign-up flow and verify its email; do
   not put a password or provider credential in command-line history.
3. On a trusted operator host with the production database environment loaded,
   run `BOOTSTRAP_ADMIN_USERNAME=your_handle npm run admin:bootstrap`.
   The command refuses if an administrator already exists or the handle is
   missing/inactive, uses a database lock and transaction, and records an
   `admin.bootstrap` audit/activity event. It is a one-time recovery/bootstrap
   path, not a role-management command.
4. Sign in to refresh the session, confirm the expected permissions, then
   remove `BOOTSTRAP_ADMIN_USERNAME` from the environment. Use the audited
   console for subsequent role changes.

There is no initial staff account seeded by the app. Do not run direct SQL role
updates in production. Keep at least two independently controlled admin
accounts and an off-platform recovery process; that is an operator control,
not something verified by CI.

### Verification evidence and retention

Email/phone codes and password-reset links are delivered from an encrypted
outbox and never included in API responses or logs. Verification is independent
across email, phone, and photo-review tiers. A photo upload creates a pending
review item; it does **not** grant a badge. Evidence is accessible only to the
review permission, is removed from its row after review, and enters a durable
media-deletion queue. Account deletion queues owned media, including profile
photos and thumbnails, for unlinking. Profile photos are **not** part of the
24-hour content purge; owners control removal by deleting a photo or account.

The `/api/admin/health` and `/api/admin/settings` surfaces return live checks and
non-secret configuration booleans only. They do not reveal database host,
credentials, provider tokens, or raw user message content. Message-report text
is redacted in the staff API. Delivery providers must still be configured and
verified separately; the code cannot prove a production email/SMS reached a
person.

---

## Security notes

* **Tokens live in cookies, never in web storage.** Access (15 min) and refresh
  (7 days) are both `httpOnly`, `SameSite=Lax`, and `Secure` when
  `NODE_ENV=production`. ESLint blocks `localStorage`/`sessionStorage` in
  `public/js/**` to keep it that way.
* **CSRF** uses the double-submit pattern: a readable `ec_csrf` cookie must be
  echoed in `X-CSRF-Token` on every mutation.
* **Passwords** are bcrypt with 12 rounds. Login responses are uniform, so the
  endpoint does not reveal whether an address is registered.
* **A strict CSP** (`script-src 'self'`) means no inline `<script>` and no
  inline `on*=` handlers anywhere. Each page loads one external module — please
  keep it that way rather than relaxing the policy.
* **Uploads** are validated by magic bytes (`file-type`), not by the filename or
  the client's `Content-Type`. Images are re-encoded with `sharp`, which strips
  EXIF — including GPS coordinates. Stored names are random; the original is
  never used as a path.
* **Rate limits:** global 300/min, auth 20/15 min, password reset 5/15 min,
  verification sends 5 per kind per 15 min (plus 10 per user), and five incorrect
  code attempts per issuance; uploads 30/min, swipes 120/min, messages 25/10 s
  over REST and 20/10 s over the socket.
* **A password change ends every existing session, immediately.** Revoking
  `refresh_tokens` rows is not enough on its own: access tokens are stateless
  JWTs that are never looked up, so on their own they would stay valid for the
  rest of their 15-minute TTL after a reset — the exact window a
  compromised-account reset exists to close. `users.sessions_valid_from` is
  stamped on any credential change and every access token issued before it is
  refused, across REST *and* the Socket.IO handshake. The synthetic API/DB CI
  suite checks access-session invalidation after password recovery; Socket.IO
  revocation is still a staging/browser acceptance item.
* **Account recovery does not leak who is registered.** `forgot-password`
  returns an identical response for known and unknown addresses. Reset tokens
  are stored as hashes, issue/consumption are serialized, and consumption,
  password update and session revocation commit atomically. Tokens are single-use
  and expire; the delivery outbox stores them only as authenticated ciphertext.
* **Every query is parameterised.** No user value is ever concatenated into SQL.
* **Authorisation is checked per resource**, not just per route: conversation,
  attachment and call access all re-verify participation.
* **A media URL is not a credential.** Moment and post media is served from
  `/api/social-media/:name`, and the check runs on *every read*, resolved
  through the owning content row rather than baked into the link. So a URL
  someone saved stops working the instant the content is deleted, expires, or
  the owner blocks them — and an unattached upload is unreadable even by the
  person who uploaded it. Filenames are random UUIDs, and responses carry
  `Cache-Control: private, no-store` so no shared proxy retains a copy. The
  checked-in synthetic API/DB suite currently verifies moderation evidence
  privacy and account-media deletion; anonymous/guessed-UUID/path-traversal
  media-read probes still need to be added to the reproducible integration suite.

## Performance notes

### Pagination (keyset, not OFFSET)

Every high-traffic list is paginated by **keyset cursor**, never `LIMIT/OFFSET`.
`OFFSET` re-counts the skipped rows on every page and, on a list that changes
between requests, silently skips or repeats rows. A keyset cursor also needs a
*total* order, so each cursor ends in a unique tiebreaker (`id`):

| List | Cursor |
| --- | --- |
| Posts feed | `p.id < before` |
| Messages | `before` (message id) |
| Notifications | `n.id <` |
| Admin reports | `(priority, id)` |
| People Nearby | `(distance_km, id)` |

`distance_km` is a select alias, so its cursor predicate lives in `HAVING`, not
`WHERE` — and it reuses the alias rather than repeating the haversine, which
also evaluates the expression once instead of three times.

The nearby endpoint takes the cursor as two flat params (`cursorDistanceKm` +
`cursorId`). Both must be present: a half-specified cursor is ignored rather
than guessed at, since guessing would page from the wrong place.

Admin's user list still uses `OFFSET` deliberately — it is low-traffic, and
jump-to-page beats streaming there.

### Feed windowing

The Moments tray is capped at 100 live moments server-side. It used to select
them with `ORDER BY created_at ASC LIMIT 100` — the **oldest** hundred — so past
that threshold newly posted moments never entered the tray at all. It now takes
the newest hundred and reverses the page, because playback within a rail still
has to run oldest-first.

Feed indexes (`idx_posts_feed`, `idx_moments_feed` on `(expires_at,
created_at)`) already existed and are used: the moments feed plan reports
`Using index`.

### Infinite scroll

Posts and People Nearby use an `IntersectionObserver` on a sentinel element
(`rootMargin: 400px`) so the next page is in flight before the user reaches the
bottom. Two non-obvious details:

- `IntersectionObserver` only fires on a **transition**. If a page is short
  enough that the sentinel never leaves the viewport, it fires once and never
  again, stranding the rest of the list. Both feeds therefore keep loading
  while the sentinel is still visible, and stop if a page appends nothing (so a
  server that keeps returning a cursor cannot spin an infinite request loop).
- The "Show more" button is kept as a keyboard-reachable fallback.

### Responsive images (`srcset`)

Every image upload already produced two renditions — a 1600px original and a
400px thumb — but for **profile photos the thumb was generated and then thrown
away**, so a grid of ~200px tiles downloaded 1600px JPEGs. `user_photos` now
carries `thumb_url`, and `photoSrcset()` in `ui.js` emits:

```
srcset="<thumb> 400w, <original> 1600w"
sizes="(max-width: 640px) 45vw, 200px"
```

`sizes` is not optional: without it the browser assumes full viewport width and
picks the large file regardless. Rows uploaded before this column existed fall
back to the original, so nothing renders broken.

Three consequences that had to be handled together:

- the photo route resolved keys under `photos/` only, but renditions live in
  `thumbs/` — it now falls back to the second prefix;
- ownership was resolved from `url` alone, so a thumb URL matched no row and
  404'd. It now also matches `thumb_url`, which keeps the **block check applied
  to the thumb** — personal media must not become readable at a second URL;
- `deletePhoto` returned only `url`, so every deletion leaked a 400px orphan on
  disk. Both files are now removed.

### Image loading

List and grid images carry `loading="lazy" decoding="async"`. Images that are
above the fold or revealed instantly are deliberately left eager — the deck
card photo (it *is* the viewport), match modals, the chat/moment lightbox, and
local upload previews — because lazy-loading those causes a visible blank
flash.

The discovery deck ranks candidates before returning a page. The implementation
uses a derived shared-interest count, separate block predicates, narrow sort
keys, and a date-range age filter. These are query-shape choices, not a
published performance guarantee.

**No reproducible load fixture or benchmark runner is checked into this
repository.** Earlier local timing notes were stored in ignored `tmp/` files and
cannot be reproduced from a fresh clone. Do not treat historical latency,
multiplier, or row-count figures as an SLO. Run production-like load tests on an
isolated, representative staging dataset before estimating capacity.

---

### Navigation

Five tabs, identical on every signed-in page and mirrored in the desktop
sidebar:

| Tab | Route | Badge |
| --- | --- | --- |
| Discover | `/app` | — |
| Matches | `/matches` | matches nobody has spoken to yet |
| Moments | `/moments` | — |
| Chats | `/chats` | unread messages |
| Profile | `/profile` | — |

**Matches and Chats are deliberately different views of one payload.** Matches
is a roster — a grid of everyone you have matched with, so the question it
answers is *who*. Chats is the thread list, ordered by recency with previews
and unread counts, answering *what was said*. A conversation with messages
appears only under Chats; a match with no messages appears only under Matches.
Before this split, chat was reachable only by drilling into a `/matches` row,
which is why the spec's Chats tab had nowhere to point.

Likes moved out of the tab bar to make room and is reached from the heart
button in the mobile header (and from the sidebar on desktop) — it is a
lower-frequency destination than the five above. `markActiveTab` matches the
full pathname, so `/chat?c=1` does not light up the `/chats` tab.

### Reproducible validation

Start with the DB-free checks:

```bash
npm ci
npm run lint
npm test
npm run test:security
npm audit --audit-level=high
```

The browser suite needs a disposable database seeded with demo accounts, a
running server, and the Playwright-managed Chromium build:

```bash
npx playwright install chromium
npm run build:css
npm run test:browser -- --base http://127.0.0.1:3000
```

The route sweep and Socket.IO suite also require a live server; see
[TESTING.md](TESTING.md) for exact prerequisites. CI additionally starts an
isolated MySQL 8 service, applies migrations without a reset, creates and cleans
synthetic security fixtures in `ember_ci`, and runs the API, route, socket, and
browser suites. CI results are not staging or production evidence: no external
provider delivery, production deployment, or real-user-data migration was
performed as part of this repository work.

---

## Running with Docker

```bash
cp .env.example .env      # set the two JWT secrets; compose refuses to start without them
docker compose up --build
```

This starts MySQL 8 with a healthcheck, waits for it, applies pending versioned
migrations, and serves on **http://localhost:3000**. Uploads and database files persist in named
volumes, and both services are published on `127.0.0.1` only (set
`APP_BIND_ADDR=0.0.0.0` / `DB_BIND_ADDR=0.0.0.0` to reach them from a phone on
your LAN).

Demo data is **not** seeded on boot any more. If you want it locally:

```bash
# The container runs with NODE_ENV=production, where the seeder refuses on purpose.
# For a local trial, ask for the dev mode explicitly:
NODE_ENV=development docker compose up -d
docker compose exec -e NODE_ENV=development app node db/seed.js
```

On a host people actually use, keep production and leave demo data alone; if you
truly want it there, set `SEED_DEMO=1` and a private `DEMO_PASSWORD` (see
[Demo logins](#demo-logins)).

For a host the internet can reach, use `deploy/vps.sh` - see **[DEPLOY.md](DEPLOY.md)**.

```bash
docker compose down       # stop
docker compose down -v    # stop and erase all data (volumes are named ember_db-data / ember_uploads)
```

---

## Troubleshooting

| Symptom                                       | Fix                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| Page loads unstyled                           | `public/css/app.css` has not been built — run `npm run build:css`      |
| `ER_ACCESS_DENIED_ERROR` on boot              | Check `DB_USER` / `DB_PASSWORD`; confirm the database exists           |
| Logged out after every restart                | Set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in `.env`             |
| Messages never disappear                      | Check the boot log for `[cleanup] scheduled`; confirm server clock/timezone |
| Call rings but never connects                 | Both peers are behind strict NAT — configure TURN                      |
| "Permission denied" starting a call           | Grant camera/mic in the address bar; the origin must be `localhost` or HTTPS |
| Video posters missing                         | `ffmpeg` is not on `PATH` — videos still upload and play               |
| `413 Payload Too Large`                       | Raise `MAX_IMAGE_MB` / `MAX_VIDEO_MB`                                  |

---

## License

MIT — provided as a complete reference implementation.
