# V1 Implementation Progress

Audit: **`AUDIT-V1.md`** (7 sections, delivered before any code, as required).

## ✅ Phase 1 — Security & privacy hardening — COMPLETE

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | **HIGH: `/api/photos/:filename` authorization** | Fixed | New `getPhotoForViewer()` resolves the basename to its owning row and enforces bidirectional block checks; orphaned files 404. Cache cut from 24 h to 5 min + `Vary: Cookie`. **6/6 assertions pass** (owner 200, other 200, anon 401, blocked 404, bogus 404). |
| 2 | **HIGH: no password recovery** | Fixed | `password_resets` table stores only SHA-256 of the token. `POST /api/auth/forgot-password` + `/reset-password`, 30-min single-use tokens, all sessions revoked on change, identical response for known/unknown addresses. **7/7 assertions pass.** |
| 3 | **LOW: username enumeration** | Fixed | Dedicated `usernameCheckLimiter` (20/min) replaces the shared 60/min search limiter on the unauthenticated availability endpoint. |
| 4 | **LOW: no login audit / account lockout** | Fixed | `login_attempts` table; 10 failures per email per 15 min → 429, independent of IP. |
| 5 | **Account status enforcement** | Added | `assertUsable()` blocks banned/suspended sign-in; lapsed suspensions self-heal. |
| 6 | **Unblock + blocked list** | Added | `GET /api/users/blocks`, `DELETE /api/users/blocks/:id`. **7/7 assertions pass.** |
| — | *Retracted finding* | — | "Blocking doesn't sever conversations" was **wrong**; tested false and corrected in the audit. Blocking already deletes the match and cascades. |

## ✅ Phase 2 — Data foundation — COMPLETE (schema)

Migration applies cleanly: **41 tables, 67 statements**.

`users` gained: `email_verified_at`, `phone`, `phone_verified_at`, `profile_completion`, `role`, `status`, `suspended_until`, `status_reason`, `username_changed_at` + 3 indexes.
`conversations` gained: `ttl_hours` (default 24), `ttl_set_by`, `ttl_set_at`.
`messages` gained: `ciphertext`, `iv`, `sender_key_id`, `is_encrypted`.

New tables: `password_resets`, `verification_tokens`, `login_attempts`, `username_history`, `user_devices`, `moments`, `moment_views`, `moment_reactions`, `posts`, `post_media`, `poll_options`, `poll_votes`, `comments`, `content_likes`, `content_reports`, `notifications`, `notification_prefs`, `admin_audit_log`.

Key design decisions:
- **Polymorphic `content_likes`** with `UNIQUE (user_id, target_type, target_id)` — idempotent liking for profiles/photos/posts/moments/comments from one table.
- **`content_reports`** with the full 9-reason taxonomy × 6 target types, a priority column so NCII/threats jump the queue, and a `snapshot` so evidence survives content expiry.
- **Ephemerality convention** applied uniformly: `created_at` + `expires_at` + `idx_*_expires` on every temporary table.
- **`notifications.group_key`** unique per user for coalescing — anti-spam built into the schema.
- **E2EE**: server stores public keys only; private keys will live in IndexedDB (`localStorage` is banned by lint).

## ✅ Phase 3 — Identity & profile — COMPLETE

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | **Profile completion %** | Done | `completionFor()` scores 11 weighted fields summing to 100 (avatar 20, bio 14, extra photos 12, interests 12, intent 9, birthdate 8, city 8, gender 5, languages 4, hobbies 4, verified 4) and returns a `missing[]` list with per-item weights so the UI can prioritise. Recomputed on every profile write and cached on `users.profile_completion`. |
| 2 | **Verification tiers** | Done | `verification_tokens` holds a SHA-256 `token_hash` only; 6-digit codes, 15-min TTL, 5 attempts, 5 issues per 15 min per kind. `POST /me/verify/start` + `/me/verify/confirm` for `email` and `phone`; `verificationTiers()` returns `{email, phone, photo, level}`. Copy states plainly that verification is **not** a safety guarantee. |
| 3 | **International phone** | Done | Stored E.164, no Nigeria-only assumptions; malformed input rejected at the validator. |
| 4 | **Controlled username changes** | Done | 30-day change cooldown, `username_history` audit row per change, and a 90-day `claimable_at` cooling-off so a released handle cannot be instantly grabbed by an impersonator — while the **original owner** may reclaim it at any time. |
| 5 | **Shareable `/@username` profiles** | Done | `GET /api/users/by-username/:username` + the `/@handle` page route (`u.html` / `u-page.js`). Case-insensitive; unknown handles return the same generic `No user found.` as blocked/suspended ones, so the endpoint leaks no existence signal. |
| 6 | **Public profile privacy** | Done | Payload omits email, phone and exact coordinates; blocked viewers get a 404, not a 403. |
| 7 | **Languages / hobbies / country** | Done | JSON columns surfaced through the profile API and rendered on the public page. |

**Bug found and fixed by browser testing (not by the API suite):** the handle-lookup
route sat below the blanket `router.use(requireAuth)` gate, so **every share link
401'd for signed-out visitors** — the exact people a share link exists for. All 58
API assertions were green throughout, because they all ran authenticated. Fixed by
mounting the route above the gate with `optionalAuth`, and locked in with **7 new
browser assertions** plus 4 anonymous API assertions.

**Second rate-limiter bug, found by re-running the suite back to back:**
`POST /api/auth/refresh` was behind `authLimiter`, whose key is `ip:email` — but
a refresh request carries no email, so the key collapsed to a bare `ip:` that
**every user on that address shared**, with a 20-per-15-min budget designed for
password guessing. On any NAT, office, campus or mobile-carrier IP, a handful of
users navigating normally would sign each other out. This had been dismissed for
several sessions as a test artifact ("repeated logins trip the limiter, add a
sleep"); it was a production bug. Refresh tokens already rotate and are
single-use, so replay is stopped by revocation rather than throttling. Now on a
dedicated `refreshLimiter` keyed by a hash of the refresh token itself
(120/15 min). The suite now passes **three times back to back with no sleeps**,
which it never did before.

**Rate-limiter correction:** verification codes reused `passwordResetLimiter`,
which is keyed per **IP** — one user behind carrier NAT would have locked out
everyone else on that address. Replaced with a per-**user** `verifyCodeLimiter`
(10 per 15 min) on top of the service's own per-kind cap.

## ✅ Phase 4 — Likes & matching reasons — COMPLETE

| # | Item | Status | Evidence |
|---|---|---|---|
| 10 | **Generic idempotent like primitive** | Done | One polymorphic table `content_likes` + `UNIQUE(user_id, target_type, target_id)` serves profiles, photos, posts, moments and comments. `POST /api/likes`, `POST /api/likes/toggle`, `DELETE /api/likes/:type/:id`, `GET /api/likes/:type/:id(/likers)`. A repeat like returns `alreadyLiked: true` and **cannot** inflate the counter; unlike is equally idempotent and `posts.like_count` is floored at 0. Targets that are expired, soft-deleted, nonexistent or blocked all return the same **404**, so the endpoint leaks no existence signal. |
| 11 | **Visible match reasons** | Done | `reasons.service.js` is pure and query-free: `matchReasons(person, viewer)` ranks shared interests (100+n) › same city (90) › same intent (80) › shared language (70) › distance (60) › verified (40) › online (30), capped at 3. Computed once in `location.service.decorate()` so the deck, Nearby, Likes-you, Top Picks and Favourites all inherit it, plus `getPublicProfile`, `getPublicProfileByUsername` and `searchUsers`. Distance reasons reuse the **pre-bucketed** label, never raw coordinates. |
| — | **Like notifications** | Done | A genuinely new like notifies the owner; a repeat does not. Coalesced per target via `UNIQUE uniq_notif_group`, so ten likers make one row with `count: 10`. Unliking **withdraws** the notification. Muted categories in `notification_prefs` produce no row at all. Self-likes are rejected. |
| — | **Blocking severs likes** | Done | `blockUser()` now deletes `content_likes` **and** `notifications` in both directions — a block undoes the relationship rather than merely hiding it. |

**Three real bugs caught by the runtime probe, all invisible to lint and curl:**

1. **`ON DUPLICATE KEY UPDATE id = id` silently broke idempotency on MariaDB.**
   It reports `affectedRows: 1` for a *no-op* update, which is indistinguishable
   from a fresh insert — so every repeat like looked new and double-incremented
   `posts.like_count`. The unique index held (never two rows), but the
   denormalised counter drifted upward and could not be trusted. Switched to
   `INSERT IGNORE`, which reports a clean 1 = inserted / 0 = already present.
2. **Notification withdrawal keyed on the wrong column.** `unnotify()` matched
   `group_key AND actor_id`, but a coalesced row stores only the *latest* actor,
   so an unlike by anyone else silently no-opped and the count never came down.
   Now keyed on the group alone.
3. **Likes were sharing `contentLimiter` (30/min), sized for creating posts.**
   Double-tapping through a gallery is ordinary behaviour that would have hit a
   429 in normal use. Split out a per-user `likeLimiter` (120/min) — high enough
   that no human trips it, low enough to stop a scripted like-farm.

Also fixed: the like deep link pointed at the *recipient* instead of the liker
(the handle is now resolved server-side rather than trusted from the caller),
and `/@username` is served by `profile.service.getPublicProfileByUsername` — a
**different** function from the one Phase 4 had wired — so the like button and
reason panel would have rendered blank on the exact page they were built for.
Found by driving the browser, not by reading the code.

# Phase 5 — Private communication (E2EE + custom disappearing timers) ✅ COMPLETE

Audit items **12** (genuine end-to-end encryption) and **13** (custom timers).

> Note: an earlier draft of this file said "Next: Phase 5 — Stories/Moments".
> That was wrong — Moments/posts is **Phase 6** (`AUDIT-V1.md` L160–163).
> Phase 5 is L155–158.

## What "genuine E2EE" means here

The spec was explicit that database-at-rest encryption does not count. So the
plaintext never leaves the browser:

- **Keys are generated in the browser** (WebCrypto, ECDH P-256 → AES-GCM 256)
  and the private key is stored **non-extractable** in IndexedDB. Not
  `localStorage` — the lint config bans it, and a non-extractable `CryptoKey`
  cannot be read out by script even if XSS lands.
- **The server stores public keys only.** There is no `private_key` column
  anywhere in the schema, and the probe asserts that with `SHOW COLUMNS`.
- **There is no decrypt function on the server.** Not "unused" — absent.
- A conversation key is wrapped **once per recipient device**, so a second
  device gets its own copy and nobody else's copy is readable.

### The claims we deliberately do NOT make
The brief warned against misleading absolutes, so the details panel states the
limits plainly: it does not hide **who** you talk to or **when**; it cannot
protect a device someone else can unlock; **screenshots are always possible**;
and because we distribute the keys, users are given a **safety number** to
compare out of band. The string "nobody can ever read this" appears nowhere —
asserted by a test.

## Custom disappearing timers

1h / 6h / 12h / **24h default** / 3d / 7d, server-enforced. Two properties
matter and both are proven against the raw DB:

- **Not retroactive.** `expires_at` is stamped at write time. Changing the
  timer cannot extend the life of a message already sent — otherwise one
  person could unilaterally turn the other's 1-hour message into a 7-day one.
- **Never client-trusted.** Every read filters `expires_at > NOW()` using the
  DB clock, so expiry does not depend on the cleanup job running on time.

A change posts an in-thread system message, so it can never happen silently.

## Evidence

| Claim | How it was proven |
|---|---|
| Recipient actually decrypts | Two **separate browser contexts** (separate IndexedDB ⇒ separate devices); amara sends, tunde renders the plaintext |
| Server never saw the plaintext | Raw SQL: newest row has `body IS NULL`, `is_encrypted=1`, and `SELECT COUNT(*) … WHERE body LIKE '%secret%' OR ciphertext LIKE '%secret%'` → **0** |
| No private key is stored | `SHOW COLUMNS FROM user_devices` contains no `private`/`secret` field |
| Keys are per-device | One wrapped copy per `device_id`; device A cannot fetch device B's copy even within one account |
| Wrap addressed to an outsider | Rejected 400, no row written |
| Timer is not retroactive | Older row keeps 24h while the next message is stamped 1h, read straight from `messages` |
| Timer syncs live | Peer's banner flips to 1h over the socket without a reload |
| Honest copy | Test asserts the panel mentions screenshots + metadata **and** that no absolute claim is present |
| Mobile | 390px: no horizontal overflow, badge visible |

## Bugs found and fixed while building

1. **`conversationDeviceKeys` used `part.userAId ?? userId`** — wrong whenever
   the viewer is user B, silently returning the wrong side's devices. Caught by
   reading `assertParticipant`'s real return shape instead of assuming it.
2. **The envelope validator had `max()` but no base64 regex**, so malformed
   ciphertext was accepted (201 instead of 400) and would have been stored
   permanently undecryptable. Caught by the backend probe.
3. **`data-ttl` collided with the per-message TTL chip.** The timer picker
   reused the attribute, so the option query matched message chips too. Renamed
   to `data-ttl-option`. This was a real ambiguity in the app, fixed there
   rather than worked around in the test.
4. **Misleading placeholder.** The screenshot showed history sealed to keys a
   fresh device never held, labelled "does not have the key **yet**" — implying
   it was still coming. Now distinguishes "encrypted before you signed in on
   this device" from a key that genuinely may still arrive.

Bug 4 was only visible in a screenshot; every assertion was already green.

## Sign-out wipes the device keys
`wipeKeys()` runs on logout so the next person on a shared computer does not
inherit the ability to decrypt the account's messages.

## Bonus fix found by the regression runner: `authLimiter` counted successes

Running every suite back-to-back started returning **429 on login**. That was
not test noise — it exposed a real flaw in the limiter's shape.

`authLimiter` had `skipSuccessfulRequests: false`, so it counted *successful*
logins toward the 20-per-15-minute cap. But the threat being defended against
is credential **guessing**, and a guess that succeeds is not a guess — it is
the owner signing in. Counting successes punishes precisely the wrong people:
anyone behind a shared IP (office, campus, NAT, a household) or signing in
across several devices would lock themselves out, while an attacker's *failed*
attempts stayed capped at 20 either way.

Now `skipSuccessfulRequests: true`, keyed `ip:email` so one targeted account
cannot be locked out by someone hammering a different address.

Because this loosens a security control, it is re-proven rather than assumed
(`tmp/bruteforce.mjs`, 4 assertions):

| Claim | Result |
|---|---|
| A password-guessing run is still blocked | ✅ 429 at attempt **21** |
| Throttle is per-account, not a global lockout | ✅ another account signs in fine mid-block |
| 25 consecutive **valid** logins all succeed | ✅ 25/25 (previously would have 429'd) |

## Phase 6 — Stories/Moments & 24-hour posts ✅ COMPLETE (`AUDIT-V1.md` L160–163)

Both ephemeral surfaces ship on one page (`/moments`), added as a sixth nav
entry and a fifth mobile tab. Everything obeys the same 24-hour contract as
chat: the DB clock owns expiry, the cleanup job purges, and `secondsLeft`
rides on every payload so the UI can show a live countdown.

**Moments** — photo/video/text with five gradient backgrounds, published to a
tray of rails and played in a full-screen viewer (pips, prev/next, Escape to
close). Owners see a view count and a viewer list; non-owners never receive
the `viewCount` key at all. Six reactions, one per user (a second choice
replaces the first rather than stacking).

**Replies are match-gated.** A moment is visible broadly, but replying opens a
real DM in the existing conversation via `message.service`, so it inherits the
conversation's disappearing timer and read receipts instead of forking a
parallel message path. A non-match gets a 403 explained in plain language, not
a dead button.

**24-hour posts** — text + up to four media + optional 2–4 option polls, with
likes, one-level comment threads and cursor-paginated infinite scroll. Poll
percentages are computed server-side; a vote is changeable and moves rather
than duplicating (UNIQUE on `(post_id, user_id)`).

**Reporting** reaches every surface through one endpoint and the full nine-reason
taxonomy (scam, fake, impersonation, harassment, spam, threats, inappropriate,
NCII, other), snapshotting the content at write time so a later delete cannot
erase the evidence. Blocks return 404 in both directions.

### Two real bugs this phase caught

1. **Every desktop modal was mis-centred.** `.sheet` centred itself with
   `-translate-x/y-1/2`, but `.animate-pop-in` ends on `transform: scale(1)`
   with fill-mode `both` — the animation's final frame permanently overwrote
   the centring transform, so panels hung down and right of centre. Harmless
   on short dialogs, fatal on a tall one: the composer with a poll open pushed
   its **Post button clean outside the viewport**, unclickable. Now centred
   with `inset-0 + margin:auto` (pure box model, nothing for a transform to
   clobber) plus `max-height: 88dvh` and internal scrolling. Mobile stays a
   flush bottom sheet — verified at 390px and 1280px.
2. **A silently dropped CSS declaration.** The first attempt at that height cap
   never reached `public/css/app.css` even though the build reported success.
   A green build is not proof a rule shipped — `grep` the built file.

## Verification baseline (after Phase 1–6)
`npm run lint` → **0** · migration → **42 tables / 68 statements**

| Suite | Result |
|---|---|
| `scripts/smoke-browser.js` | **114/114** |
| `scripts/smoke-socket.js` | **17/17** |
| `tmp/regress-profile.mjs` | **24/24** |
| `tmp/phase4.mjs` | **77/77** |
| `tmp/phase5.mjs` | **68/68** (asserts against raw DB rows) |
| `tmp/phase4-ui.mjs` | **27/27** (real Chromium) |
| `tmp/phase5-ui.mjs` | **37/37** (real Chromium, two contexts) |
| `tmp/phase6.mjs` | **101/101** (moments, posts, polls, comments, reports) |
| `tmp/phase6-media.mjs` | **31/31** (upload pipeline + private-media access control) |
| `tmp/phase6-ui.mjs` | **45/45** (real Chromium, desktop + mobile, two users) |
| `tmp/phase7.mjs` | **50/50** (notification fan-out, coalescing, pref gating, blocking) |
| `tmp/phase7-ui.mjs` | **35/35** (real Chromium, bell + live badge + sheet + prefs) |
| `tmp/bruteforce.mjs` | **4/4** (login throttle still holds) |

**565 assertions green across 13 suites.** `smoke-browser` grew from 114 to
117: `/moments` joined the responsive sweep at 320/768/1440px.

Run everything with `node tmp/regress-all.mjs`. It resets the DB between
suites — `phase4.mjs` unmatches amara+tunde, which deletes conversation 1 and
made `phase5.mjs` fail with a 404 when the suites were chained by hand. That
was a fixture-ordering artefact, not a product bug, but the runner removes the
trap permanently.

### Running the suite

Start the server with a raised global ceiling for an end-to-end run:

```
RATE_LIMIT_GLOBAL_PER_MIN=100000 npm start
node tmp/regress-all.mjs
```

The global limiter is 300 req/min **per IP**, and all thirteen suites share one
source IP, so a full run exhausts it partway through. That produced a
genuinely confusing failure mode — a *different* suite went red on each run,
always on assertions that expected 401/403 but received 429. Only the blunt
global ceiling is raised; the auth limiter, the per-account login backoff, CSRF
and every authz check stay at production values, which is exactly why
`bruteforce.mjs` still passes. The default in code remains 300 and `.env`
carries no override.

## Phase 7 — Safety & notifications ✅ COMPLETE (`AUDIT-V1.md` L165–167)

**Twelve notification kinds**, all actually emitted and all verified end to
end: `match`, `message`, `profile_like`, `photo_like`, `post_like`,
`post_comment`, `comment_reply`, `moment_reaction`, `moment_reply`,
`verification`, `safety`, `system`.

- **Coalescing.** `UNIQUE (user_id, group_key)` turns a repeat into a counter
  bump rather than a new row. Withdrawing the underlying action (`unnotify`)
  decrements and deletes the row at zero.
- **Two counters, deliberately.** `count` is how many events stand behind the
  row; `unseen_count` is how many arrived since the user last looked and
  resets on read. Collapsing these into one column made "mark all read"
  behave like withdrawing every like — caught by `phase4.mjs`.
- **Preference gating.** Six user-facing categories in Settings. Verification,
  safety and system messages are ungated and always delivered.
- **Privacy.** A message notification carries a generic body and never the
  text. Blocking purges notifications in both directions; `list`/`unreadCount`
  also filter blocked actors and non-active users at read time.
- **Live push.** Socket `notification:new` carries `{kind, unread}` — a count
  only, never content, so a stale tab can move its badge without holding data
  it may no longer be allowed to see.
- **Deep links.** Every row navigates to the thing it is about; the targets are
  asserted to resolve rather than merely to be non-empty.

### Two real bugs the screenshots caught that the assertions did not

1. **"Tunde and 21 others sent you a message."** Coalescing counts *events*,
   not people, and a 1:1 conversation can only ever involve one other person.
   The client now phrases per-kind: "and N others" only for kinds where an
   actor can contribute at most once (likes, reactions), and "sent you 22
   messages" for a burst.
2. **An unhandled rejection on every page.** `requireAuth` is called behind a
   top-level `await bootPage(...)`, so when a user navigated away while the
   boot fetch was in flight the aborted request surfaced as a red
   `TypeError: Failed to fetch` in the console. It reproduced about one run in
   five and is now resolved quietly when the document is being torn down.

A third was a latent MySQL bug: `GREATEST(count - 1, 0)` on an UNSIGNED column
underflows *before* `GREATEST` can clamp it, so any zero-count row made every
later `unnotify` throw. Fixed with `CAST(count AS SIGNED)`.

## Phase 8 — Admin & moderation ✅ COMPLETE (`AUDIT-V1.md` L169–170)

The report **read** side, moderation enforcement, and the dashboard.

### Security fix this phase depended on

Before any of the dashboard was worth building, a probe showed that **a ban only
blocked new sign-ins**. `requireAuth` selected `id, email, display_name,
avatar_url` and never looked at `status`, so a banned account kept its access
cookie and could carry on messaging, liking and browsing until the token
expired. Proven, not assumed:

```
--- user 1 BANNED mid-session ---
POST message : 201      <- before
POST like    : 201
GET discovery: 200
--- after the fix ---
POST message : 403   POST like: 403   GET discovery: 403
```

`requireAuth`, `optionalAuth` and `socketAuth` now load `role`/`status` and run
the same `assertUsable` predicate the login path uses, so a sanction bites
existing HTTP sessions *and* live sockets. A lapsed suspension still heals
itself on the next request.

### Roles

`requireRole(minRole)` with rank ordering `user < moderator < admin`.

- **moderator** — report queue, content takedown, user search, suspend/restore
- **admin** — the above, plus permanent bans, role changes and the audit log

Two deliberate choices:

- **404, not 403,** for an authenticated non-moderator. A 403 confirms that
  `/api/admin/*` exists and is worth attacking; a 404 says nothing.
- **The service re-checks rank independently of the route.** Nobody may action
  an account at or above their own level, and nobody may action themselves (a
  self-ban would lock the last admin out). A mutation test that disabled the
  route gate proved this second layer holds: `moderator cannot ban` still
  returned 403 with the gate switched off.

### Report queue

Ordered `priority DESC, id ASC` — threats and NCII outrank spam, and within a
band the oldest is handled first. Keyset paginated on `(priority, id)` rather
than `OFFSET`, because the queue mutates while it is being worked and `OFFSET`
would skip rows as items are actioned out from under it.

Each row carries the **evidence snapshot** taken at report time, so a moment
reported at 23:59 is still reviewable at 09:00 after the content itself expired.
Content takedown is a **soft delete** (`deleted_at`/`deleted_by`) for the same
reason: a hard delete would destroy the context behind the report.

### Audit log

Every state-changing action writes an `admin_audit_log` row from inside the same
code path as the mutation — actor, action, target, stated reason, IP, timestamp.
It is not possible to suspend someone without leaving a record, and a *rejected*
action writes no row (asserted).

### Analytics

Users (total, new 24h/7d, active 24h/7d, online, suspended, banned) ·
connections (matches, messages, swipes) · live content (posts, moments,
comments) · safety (open/urgent/reviewing/actioned/dismissed, **reports per 1k
messages** so the number does not simply track traffic) · verification rates for
email, phone and photo. All windows use the DB clock, never Node's.

### The bug the browser caught that the API tests could not

`openModal` removes the panel **before** it resolves. The suspend and ban flows
read `#suspend-days` / `#suspend-reason` *after* awaiting it, so both were
querying a detached DOM: every suspension silently posted the **7-day default
with no reason**, whatever the moderator typed or selected. A moderator choosing
"3 days — repeated harassment" would have got seven days and a blank audit
entry. Values are now captured in the action handler while the dialog is still
mounted, and the suite asserts the stored duration, not just the reason.

### Verified

- `tmp/phase8.mjs` — **99 assertions**, run twice consecutively with no DB reset
- `tmp/phase8-ui.mjs` — **44 assertions** in a real browser at 1280px and 390px
- Mutation test: disabling the role gate turned **8 assertions red**, so the
  suite has teeth
- Full runner: **16 suites, all green**

## ▶ Next: Phase 9 — performance & polish (`AUDIT-V1.md` L172–175)

Cursor pagination and infinite scroll across deck/search/nearby/feeds, FULLTEXT
display-name search, feed indexes, lazy images with `srcset`, the nav rename,
and i18n readiness.


---

## Phase 10 — account-lifecycle verification

Phase 10 started with a coverage audit rather than new code. Grepping all 15
suites for every flow the V1 spec names found five with **zero coverage**:
logout, password recovery, email verification, phone verification and username
changes. Every other spec area already had a suite, so the new work targets the
gap instead of restating existing coverage.

`tmp/phase10.mjs` — **59 assertions**. Because all five flows mutate
credentials, handles or verification tiers, the suite registers its own
throwaway `p10*` users (epoch-suffixed against collisions) and deletes them on
exit, asserting `COUNT(*) = 12` so the shared seed fixture is provably intact.

### Security bug found and fixed

The assertion *"the pre-reset session was invalidated by the password change"*
failed against shipped code. `consumePasswordReset` calls
`revokeAllUserTokens`, which only touches `refresh_tokens` — but access tokens
are **stateless JWTs** that `requireAuth` verifies without ever consulting that
table. A password reset therefore left the previous session usable for the
remainder of its 15-minute TTL, which is exactly the window a
compromised-account reset is supposed to close.

Fix: a token epoch. `users.sessions_valid_from` is stamped on password change
and `assertTokenNotStale` rejects any access token issued before it. It hangs
off the existing `assertNotSanctioned` hook, so it adds no query and applies to
`requireAuth`, `optionalAuth` and `socketAuth` alike (the socket handshake was
vulnerable too). The epoch is `NOW() + 1 SECOND` because JWT `iat` is
second-resolution.

Mutation-tested: disabling the check makes the assertion red, restoring it makes
it green.

### Rate limiting

`passwordResetLimiter` (5 / 15 min / IP, in-memory) tripped on re-runs and the
429 read like a broken reset. It gained the same narrow, test-only override the
global ceiling already has — `RATE_LIMIT_RESET_PER_15MIN`. **The production
default is unchanged and was re-verified to bite at request 6**; single-use
hashed tokens, expiry, supersession and session revocation remain
unconditional.

### Status

| Check | Result |
|---|---|
| `tmp/phase10.mjs` | **59/59** |
| Full runner | **16 suites green**, twice consecutively (~250 s) |
| `npm run lint` | 0 errors |
| `migrate --fresh` | 42 tables, `sessions_valid_from` present |

### Item 20 — deck query optimisation (done)

Old code vs new code against an identical 50k-user database: **p50 235 ms → 97
ms, p95 282 ms → 109 ms**, deck output byte-identical on all eight fingerprints
(`tmp/p10-deckdiff.mjs`). Three changes: correlated shared-interest subquery →
derived join; `OR`-based block filter → two seekable `NOT EXISTS` (applied to
all ten occurrences across four services); deferred join so the 50k-row sort
carries ids and sort keys instead of full profile rows. Plus a sargable age
filter and `idx_users_deck_rank`, both kept on merit but individually marginal —
see the Performance notes in README.md. Verified by 17 green suites, including a
new `tmp/p10-blockcheck.mjs` guarding the rewritten block filters, and by a real
browser screenshot of the rendered deck.

Still open on item 20: cursor pagination / infinite scroll, feed indexes, lazy
images and `srcset`. Then item 21 (nav rename + mobile pass) and item 22 (i18n).

### Item 20 — pagination, infinite scroll, lazy images (done)

Audited before building: keyset cursors already existed on posts, messages,
notifications and admin reports, and the posts feed already had a working
`IntersectionObserver`. Remaining gaps were all in People Nearby and images.

1. **`peopleNearby`: `OFFSET` → keyset cursor** on `(distance_km, id)`. The old
   `ORDER BY distance_km, is_online` had **no unique tiebreaker**, so
   equidistant users could reorder between requests and be skipped or repeated.
   Predicate goes in `HAVING` (alias scope) and reuses the `distance_km` alias
   instead of repeating the haversine.
2. **Callers updated**: `nearbyQuerySchema` (`offset` → `cursorDistanceKm` +
   `cursorId`), `discovery.controller.js`, `nearby-page.js`.
3. **Infinite scroll on Nearby**, matching the posts pattern, plus a
   viewport-fill loop so a short page cannot strand the list, and the button
   kept as a keyboard fallback.
4. **Header count fixed** — appending overwrote it with the last page's count
   ("0 people" above a full grid). Now a running total, suffixed `+` while more
   pages remain.
5. **Lazy images**: 16 list/grid `<img>` tags got `loading="lazy"
   decoding="async"`; 8 deliberately left eager (deck card, match modal,
   lightbox, upload preview) to avoid a blank flash.

Two new suites (`p10-nearbypage.mjs`, `p10-nearbyscroll.mjs`) registered in
`regress-all.mjs`. **19 suites green.**

### Item 20 — feed windowing, indexes, srcset (done)

1. **Moments feed took the oldest 100.** `ORDER BY created_at ASC LIMIT 100`
   meant that past 100 live moments, the newest never appeared in the tray.
   Now selects newest-first and reverses, preserving oldest-first playback.
   Proven against the pre-fix file (fails there, passes here).
2. **Feed indexes already existed** (`idx_posts_feed`, `idx_moments_feed`) and
   are used — `EXPLAIN` reports `Using index`. Nothing to add.
3. **`srcset`.** The 400px rendition was generated on every upload then
   discarded for profile photos. Added `user_photos.thumb_url`, persisted and
   exposed it, and added `photoSrcset()` to `ui.js`. This also required fixing
   the photo route (thumbs live under `thumbs/`, not `photos/`), extending the
   ownership lookup to `thumb_url` **so the block check covers the thumb**, and
   deleting both files on removal instead of leaking an orphan.

**Item 20 complete. 22 suites green.**

## Item 21 — navigation rename + mobile pass (done)

The spec asked for 🏠 Discover · ❤️ Matches · 📸 Moments · 💬 Chats · 👤 Profile.
Four of the five existed; **Chats had no destination** — conversations were
reachable only by drilling into a `/matches` row. The tab bar was also
duplicated inline across seven HTML files, all showing Discover / Moments /
Likes / Matches / Profile.

**Decision (closest to Tinder's real web app):** split the two concerns rather
than point a new tab at an existing page. Tinder separates the match roster
from the message list, so:

- **`/chats`** is new — the conversation list (previews, timestamps, unread
  counts), driven by `public/js/chats-page.js`.
- **`/matches`** became a roster of match tiles plus the "new matches" rail,
  with a link across to Chats.
- Nothing was deleted. `/likes` survives as a full page, moved to the heart
  button in the mobile header and kept in the desktop sidebar.
- Row and tile builders were extracted to `public/js/match-rows.js` so the two
  pages share one renderer instead of duplicating ~50 lines.
- Badges were split: Chats carries unread messages, Matches carries matches
  nobody has spoken to yet.
- `PAGES` in `server/server.js` gained `chats`. `markActiveTab` is an exact
  pathname match, so `/chat?c=1` does not highlight the Chats tab.

**Three real bugs fixed**, documented in TESTING.md under `tmp/p10-nav.mjs`:
unread badges had never rendered (Tailwind's `.hidden` class beat the `hidden`
property in `setBadge`); two unhandled rejections in `settings-page.js` threw
visible console errors when a user navigated away mid-load; and Matches
initially duplicated the Chats list — caught by reading the screenshot while
all 42 assertions were green.

Mobile pass at 390 / 360 / 820px: bottom nav visible and within the viewport,
tap targets ≥44px, no horizontal overflow. `node tmp/regress-all.mjs` →
**23 suites green**.

## Item 22 — i18n readiness (done)

Audited first: intl phone, ISO-2 country, JSON languages and server-emits-ISO
were already in place, so this pass fixed what was actually missing.

**Real bug #4 — the 24-hour contract depended on where you deploy.** The pool
reads DATETIME as UTC while MySQL's `time_zone` defaults to `SYSTEM` (the host
clock), and 126 expiry comparisons use `NOW()`. Measured: a UTC-8 session makes
a "24 hour" item expire in **16 hours**; UTC+1 stretches it to 25. Every pooled
connection is now pinned to `+00:00` via the pool's `connection` event —
`initSql` is not a real mysql2 option and was being silently ignored. The suite
mutation-tests it.

**New:** `users.timezone` (IANA) + `users.locale` (BCP-47), both nullable and
validated against the runtime's own tz database, private-serialiser only so a
precise zone never leaks on a public profile; and `public/js/i18n.js` — a
string catalogue with `t()`, placeholder interpolation, locale negotiation and
zone-aware date/time/number formatters, wired into `bootPage` and the three
formatters that were calling `toLocale*` directly. This makes the app
translatable; `en` is still the only catalogue and ~105 inline copy sites
remain, which is recorded honestly in the audit rather than claimed as done.

Also fixed while reading the screenshot: the sidebar Discover icon was still
the same heart as Likes/Matches (item 21 only fixed the tab bar). All 11
sidebar icons are now unique.

`npm run lint` clean · `node tmp/regress-all.mjs` → **24 suites green**
(`tmp/p10-i18n.mjs`, 63 assertions).

## Item 23 — final verification sweep (done)

Item 23's original three bullets were closed when the runner had 16 suites;
items 17-22 landed afterwards, so this pass re-verified the whole thing rather
than re-running it.

**Coverage re-audit.** Checked the spec's flow list against the suites again.
A keyword grep suggested five untested flows (verify, TTL timers, polls,
username cooldown, suspend/ban) — all five were **false alarms**; reading the
call sites showed each is genuinely asserted. No new feature tests needed.

**Deploy realism.** Built a throwaway DB from `schema.sql` alone and diffed all
42 tables against live: zero drift, so item 22's hand-applied `timezone`/
`locale` columns are reproducible from source. Then a full cold rebuild
(`migrate --fresh` + `seed`) with every suite green.

**Security spot-check.** Non-enumerable login/reset, dev tokens gated behind
`!env.isProd`, uploads unreachable as static files and 401 via the authorising
routes, UUIDv4 media filenames, strict CSP, no CORS reflection, `requireRole`
404s for authenticated non-staff.

**Real bugs #5 and #6 — both on `/profile`**, the page item 21 missed. It was
the only page of 9 with **no `<main>` landmark** (so "Skip to content" targeted
a plain div), and it still had a **stale 3-tab nav** with a speech-bubble icon
labelled "Matches". Both fixed.

`npm run lint` clean · `node tmp/regress-all.mjs` → **25 suites green**
(`tmp/p10-sweep.mjs`, 98 assertions across 8 pages x 5 viewports).

## Post-V1 hardening — credential logging (done)

**The bug.** `forgot-password` logged the full password-reset *link* and
`verify/start` logged the 6-digit *code*, both unconditionally at `info` — the
production default level. The response bodies were properly gated behind
`!env.isProd`; the log lines silently defeated that gate. Anyone with log
access could take over any account.

**The fix, in two layers.** Call sites no longer pass secrets (and no longer
log the user's email/phone either), *and* the logger now redacts secret-named
keys at any depth plus `?token=`/`?code=` inside URL strings, so a future
careless log line cannot reintroduce the leak.

**Two more bugs fell out of testing it.** Mutation-testing the redactor
revealed the logger would **crash the process** on a circular meta object
(`JSON.stringify` throws) — fixed with `safeStringify` in both output
branches. And the full runner turned up a genuine flake: `/nearby` ended with
a top-level `await boot()` with no `.catch()`, so navigating away mid-flight
raised an unhandled `TypeError: Failed to fetch` roughly 1 run in 3. Guarded,
then confirmed with 5 consecutive clean runs.

`npm run lint` clean · `node tmp/regress-all.mjs` → **26 suites green**
(`tmp/p10-secretlog.mjs`, 23 assertions).

## Post-V1 hardening — notification deep links (done)

Four independent faults between a notification and its content, all fixed:
dead `/posts` route in `post.service.js` (now `/moments`), missing
`id="comment-…"` anchor, no hash handling at all after async feed render, and
no `hashchange` listener so a second notification click was inert. Added
`GET /api/comments/:id/context` (LIVE + NOT_BLOCKED gated) because a comment id
does not identify its post. 28 suites green.

## Post-V1 hardening — full-folder error sweep (done)

Swept the whole project for anything still erroring: syntax-checked every JS/MJS
file, linted, resolved every relative import and static asset reference, read
the server log, and drove the eight pages no browser suite had covered
(`tmp/p11-errorsweep.mjs`, 51 checks). Verified data integrity directly against
the database — all 63 foreign keys orphan-free, no expired-but-present rows, and
zero schema drift (347 columns) against a scratch build of `db/schema.sql`.

The sweep turned up one real defect: deleting a profile photo removed the
original but orphaned its thumbnail on disk forever, because the two files live
in different directories and the delete path assumed one of them. Fixed with a
shared `removeStoredFile` helper and locked in by `tmp/p11-mediacleanup.mjs`.
Every other media path stores real storage keys and was already correct.

Thirty suites green together.


## Post-V1 hardening — blocked-people UI (done)

Closes the last open item in `AUDIT-V1.md`. The block API shipped in Phase 1
with no client calling it, so a block could only be undone in SQL. Settings now
has a "Blocked people" section: avatar, name, `@username`, empty state, and an
unblock button behind a confirm dialog whose copy is explicit that unblocking
does not bring back the old match or chat.

- `public/js/api.js` — `blockedList()`, `unblock(blockedId)`.
- `public/settings.html` — section with `#blocked-list`, `aria-live="polite"`.
- `public/js/settings-page.js` — `paintBlocked` / `unblockPerson` / `wireBlocked`,
  delegated clicks because the list repaints.

Divider initially used `divide-line` (raw black); switched to the house
`divide-hairline/[var(--hairline-a)]` after a screenshot showed a heavy rule.
Checked light and dark.

`tmp/p11-unblock.mjs` (14 checks) added to `regress-all.mjs`. It asserts the
block is genuinely lifted — server list, username search and `GET /api/users/:id`
all re-checked after the row disappears — plus Cancel-is-a-no-op, double-unblock
404, and a `finally` that always restores the fixture.

**31/31 suites green** (~489 s). Suite count corrected in README (30 → 31);
`TESTING.md` entry added.

## Post-V1 hardening — MySQL 8 parameter binding (done)

Reported from the user's own machine: every feed 500'd with `Incorrect
arguments to mysqld_stmt_execute`. Not reproducible here — our CI database is
MariaDB, which silently coerces the parameter MySQL 8.0.22+ rejects, which is
exactly why 31 green suites missed it. mysql2 sends JS numbers as DOUBLE and
MySQL will not convert a double to the integer `LIMIT` demands.

Fixed at the driver boundary in `pool.js` (`coerceParams` + a `wrapConnection`
proxy for transactions) so all 19 `LIMIT ?` sites and the 37 in-transaction
calls are covered at once, with floats deliberately left alone. Also fixed the
composer bug the same report exposed: a saved post was reported as failed
because the feed reload shared the write's `try`.

Verified by asserting on the *types* handed to the driver rather than on query
results, since MariaDB cannot reproduce the failure. Six mutants across the two
new suites, all caught.

**33/33 suites green** (~488 s), + `tmp/p11-mysql8params.mjs` (34) and
`tmp/p11-composer.mjs` (6).
