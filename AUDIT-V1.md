# V1 Upgrade Audit — Ember

**Codebase:** 13,372 LOC · 23 tables · 7 API routers · 12 pages · 22 client modules
**Philosophy target:** *Connect in the moment. Share freely. Stay private.*
**Verdict:** the app is a solid, secure **dating** app. It is roughly **40% of the V1 spec**. The dating half is largely done and good; the **social half (moments, posts, comments, notifications) and the entire trust-and-safety back office (admin, moderation, audit) do not exist**. No rebuild is warranted — every missing feature is additive.

---

## EXISTING FEATURES

Verified present and working (browser suite: 107/107, socket suite: 17/17).

| Area | What exists |
|---|---|
| **Auth** | Register, login, logout, refresh rotation. Argon2id passwords. JWT access + refresh in `httpOnly` cookies. Double-submit CSRF (`ec_csrf` + `x-csrf-token`) applied to **every** mutating route — verified route-by-route, zero gaps. |
| **Usernames** | `users.username VARCHAR(30)`, `UNIQUE KEY uniq_users_username`, collation `utf8mb4_0900_ai_ci` (case-insensitive by design). Zod `usernameSchema`: 3–30 chars, lower-cased, `^[a-z0-9](?:[a-z0-9._]*[a-z0-9])?$`, no repeated separators, **reserved-word blocklist** (24 words incl. `admin`, `support`, `root`, `ember`). `GET /api/auth/username-available`. |
| **Username search** | `GET /api/users/search`, indexed, rate-limited (`searchLimiter`), relevance-ordered (exact → prefix → online → alpha), block-filtered on **both** directions, capped at 20. |
| **Profiles** | Photo + up to 6 extra photos with ordering/delete/replace, display name, birthdate→age, gender, city, bio (500), intent, job title, school, height, interests (8 max), prompts (3 max), verification flag, online status + `last_seen_at`. |
| **Matching** | Swipe like/pass/superlike, `UNIQUE KEY uniq_swipe` (idempotent), mutual-match detection in a transaction, unmatch, rewind, likes-received. Shared interests already computed and surfaced. |
| **Chat** | 1:1 conversations bound to matches, `assertParticipant` on every read/write, cursor pagination (`before` + `LIMIT`), Socket.IO delivery, typing, read receipts, client-uuid dedupe, image/video attachments, live location sharing. |
| **Ephemerality** | `messages.expires_at` (24 h via `MESSAGE_TTL_HOURS`), `attachments.expires_at`, `idx_expires`, every read filtered `expires_at > NOW()`, cron cleanup every 5 min deleting rows **and** files from disk. |
| **Discovery** | Nearby (geo-cell + haversine), Bumped Into, Top Picks (8/day), Likes You, Visitors, Favorites, Taps, Boost, Passport, Encounters. Distance is bucketed to strings; suite asserts no raw coordinates leak. |
| **Privacy** | `user_settings.location_mode` = precise / **approximate (default, 0.01° snap)** / hidden. Never returns exact GPS. |
| **Blocking (core)** | `blocks` table; enforced in deck, search, nearby, bumped, top-picks, visitors, favorites, match creation, public profile — **15 call sites, bidirectional**. |
| **Calls** | Native WebRTC 1:1 audio/video, signalling over Socket.IO, ICE endpoint. |
| **Platform** | Strict CSP (`script-src 'self'`), zero inline scripts/handlers, Helmet, 7 tuned rate limiters, structured logging, Docker + compose, light/dark theming, mobile-first responsive shell. |

---

## PARTIALLY IMPLEMENTED

| Feature | What's there | What's missing |
|---|---|---|
| **Likes** | Swipe-likes only (`swipes` table). | Likes on **profiles outside the deck, photos, posts, moments**. No generic idempotent like primitive. |
| **Verification** | Single boolean `is_verified` + selfie challenge endpoint. | **Tiered** ✓email / ✓phone / ✓profile. No email-verify flow, no phone at all, no `email_verified_at` / `phone_verified_at` columns. |
| **Reporting** | `POST /api/users/reports` — **profiles only**, free-text reason. | Reporting messages, photos, posts, moments, comments. No fixed reason taxonomy (scam/fake/impersonation/harassment/spam/threats/inappropriate/NCII/other). **No queue, no moderator ever sees a report** — rows land in a table nobody reads. |
| **Blocking** | Fully enforced in discovery/search/matching **and verified to sever matches, conversations and messaging**. | ~~No unblock endpoint; no blocked-list UI.~~ **Closed — see H6.** |
| **Disappearing content** | Server-enforced 24 h, hard-deleted, media removed. | **Timer is global and fixed.** No per-conversation choice of 1h/6h/12h/24h/3d/7d. No `conversations.ttl_hours`. |
| **Chat encryption** | TLS + `httpOnly` cookies + at-rest DB. | **Not E2EE.** Bodies are plaintext in `messages.body`; the server can read every message. No keypairs, no client-side crypto, no key exchange. |
| **Profile completion** | All the underlying fields exist. | No `%` computed or displayed anywhere. |
| **Shareable URLs** | Usernames are unique and indexed. | **No `/@username` route.** Only `/profile?id=N`. |
| **Notifications** | Socket events for match/message/tap; unread badges. | No `notifications` table, no history, no deep links, no preferences, no notification centre. |
| **Pagination** | Chat has cursor pagination. | Deck, search, nearby, visitors, likes-you all return one fixed page — no infinite scroll. |
| **i18n readiness** | No Nigeria-only hard-coding in logic; geo is international. | Seed data is Nigerian, currency/locale/timezone not abstracted, no string catalogue, no intl phone. |

---

## MISSING FEATURES

Confirmed absent — grep across `server/` and `db/` returns **zero** schema references:

1. **Stories / Moments** — no table, service, route, page, or client module. (photo/video/text, 24 h, views, reactions, reply→DM, delete/report/block)
2. **24-hour posts** — nothing. (text/photo/video, optional polls, like/comment/reply/delete/report)
3. **Comments & replies** — no `comments` table anywhere.
4. **Notifications** — no `notifications` table, no preferences, no centre.
5. **Admin / moderation dashboard** — **no `role` column, no `is_admin`, no admin route, no admin page, no report queue, no suspend/ban/restore, no analytics, no audit log.** This is the single largest gap.
6. **Genuine E2EE** — no crypto layer client-side.
7. **Custom disappearing timers** — no per-conversation TTL.
8. **Photo likes / post likes / moment reactions** — no generic like table.
9. **`/@username` public profile route.**
10. **Profile completion %.**
11. **Verification tiers + email/phone verification flows.**
12. **Password recovery** — `auth.routes.js` has no `/forgot` or `/reset`. A user who forgets their password is permanently locked out. *(Spec's testing section requires "recovery".)*
13. **Extended report taxonomy + moderation actions.**
14. **Unblock + blocked-users list.**
15. **Infinite scroll / pagination on discovery surfaces.**
16. **Content expiry for non-message objects** (moments/posts need their own `expires_at` + cleanup).

---

## SECURITY RISKS

Ordered by severity. Two are real and must be fixed first.

### 🔴 HIGH — `GET /api/photos/:filename` authenticates but does not authorize
`server/src/controllers/user.controller.js:110`. It calls `findPhotoKeyByBasename(req.params.filename)` and streams the file to **any logged-in user** who knows the basename. There is no check that the requester may see that photo — no owner check, no block check. Contrast with `serveMedia`, which correctly enforces owner-or-participant. This directly violates the spec's *"private media not guessable by URL"*. Filenames are random, so it is not trivially enumerable, but a blocked user who saved a URL retains access forever, and `Cache-Control: private, max-age=86400` extends the window.
**Fix:** resolve the photo to its owner, enforce block-awareness + visibility, and switch private media to short-lived signed tokens.

### 🔴 HIGH — no password recovery
No reset flow exists, so users have no account-recovery path. Beyond usability this is a security issue: it pushes users toward weak, memorable passwords and there is no way to rotate credentials after a breach.

### 🟠 MEDIUM — reports are write-only
`POST /api/users/reports` inserts a row no human or process ever reads. NCII, threats and harassment reports are silently discarded. **This is the most consequential safety gap in the product**, even though it is not an exploit.

### 🟠 MEDIUM — no admin authorization model at all
When the dashboard is added there is currently no `role`, no permission check, and no audit log to build on. Must be designed in from the start (role-based, least-privilege, every action logged) rather than bolted on.

### ~~🟠 MEDIUM — blocking does not sever existing conversations~~ — **RETRACTED, tested false**
My first read of `blockUser` missed the unmatch branch. Verified empirically instead: blocking deletes the match, the FK cascade removes the conversation and messages, and the blocked user then gets **404 on send, 404 on profile, 0 results in search**, in both directions. Blocking *is* a contact filter. The only genuine gap here was the **missing unblock endpoint + blocked-list UI** — ~~open~~ **now closed**: `GET /api/users/blocks` and `DELETE /api/users/blocks/:id` ship with a "Blocked people" section in Settings (confirm dialog, empty state, live repaint). Covered by `tmp/p11-unblock.mjs`, which proves the block is genuinely lifted — search and profile access return — not merely hidden from the list.

### 🟡 LOW — username enumeration via `username-available`
`GET /api/auth/username-available` is unauthenticated and rate-limited only by the global limiter (60/min), permitting bulk existence probing. Real-world impact is low (usernames are public by design and search exists) but it should get its own tighter limiter.

### 🟡 LOW — no account lockout / no login-attempt audit
`authLimiter` is 20/15 min per IP. Distributed credential stuffing against a single account isn't specifically slowed, and failed logins aren't recorded.

### 🟡 LOW — misleading-privacy exposure (forward-looking)
The product must ship E2EE *without* claiming "nobody can ever read this" and disappearing messages *without* anti-screenshot claims. Copy needs an explicit honesty pass.

### ✅ Audited and clean
SQL injection (100% parameterized, zero string interpolation) · XSS (`escapeHtml` + strict CSP + no inline handlers) · CSRF (complete coverage, verified route-by-route) · IDOR on conversations/messages/matches (`assertParticipant` everywhere) · IDOR on attachments (owner-or-participant) · password storage (Argon2id) · session handling (httpOnly, SameSite, rotation) · CORS (single origin) · upload validation (MIME + magic-byte + size + re-encode) · DB user privileges (scoped to one schema) · exact-GPS leakage (bucketed, suite-asserted).

---

## PERFORMANCE ISSUES

1. **`LIKE '%term%'` on display_name in search** — `user.service.js:118`. The leading wildcard means the `display_name` half **cannot use an index**; only the username half is a range scan. Fine at 12 users, a full scan at 100k. Needs a `FULLTEXT` index or prefix-only matching on display name.
2. **No pagination on discovery surfaces** — deck, nearby, visitors, likes-you, favorites return fixed slices with no cursor. Infinite scroll is required by the spec and there's no cursor contract to build it on.
3. **Per-row photo hydration** — several services run a second query to attach photos after the main select. Batched by `IN (...)` today, so acceptable, but the new feeds must not repeat the pattern per post/moment.
4. **`COUNT(*)` badge queries on every page boot** — `/counters` runs several aggregate counts unindexed by viewer; will need covering indexes or cached counters as tables grow.
5. **No feed indexes exist yet** — moments/posts feeds need composite `(user_id, expires_at)` and `(expires_at, created_at)` indexes from day one, or every feed read becomes a scan.
6. **Images served at full resolution** — thumbs exist for attachments but profile photos are served as uploaded. Feeds of many small avatars will over-fetch. No `srcset`, no lazy loading on grids.
7. **No `LIMIT` guard on interests/prompts joins** — small today, unbounded in principle.
8. **Cleanup job scans `expires_at` every 5 min across messages + attachments** — indexed and cheap now; adding 3 more expiring tables to the same job needs batched deletes to avoid long locks.

---

## DATABASE / ARCHITECTURE ISSUES

1. **No generic "content" abstraction.** Likes, reports and comments each need to target *many* object types (profile, photo, post, moment, comment, message). Modelling six separate like tables would be a mess. **Decision: polymorphic `(target_type, target_kind_id)` tables** — `content_likes`, `content_reports`, `comments` — each with a `UNIQUE` key giving idempotency for free. This matches how Tinder/Badoo-scale schemas handle it and keeps the raw-SQL, no-ORM constraint clean.
2. **No `role` on `users`.** Needs `role ENUM('user','moderator','admin')` + `status ENUM('active','suspended','banned')` + `suspended_until` / `ban_reason`, plus an `admin_audit_log` table. Must land before any admin endpoint.
3. **Expiry is modelled per-table ad hoc.** `messages` and `attachments` each hand-roll `expires_at`. The spec demands *every* temporary object carry `created_at` / `expires_at` / expiration status with backend enforcement. **Decision: a consistent convention** — every ephemeral table gets `created_at`, `expires_at`, `KEY idx_<t>_expires (expires_at)`, all reads filtered `expires_at > NOW()`, all registered in one cleanup registry rather than bespoke cleanup code per table.
4. **TTL is a global env var, not per-row policy.** `MESSAGE_TTL_HOURS` is baked in at insert. Custom timers require `conversations.ttl_hours` and recomputation on change (new messages only — never retroactively extend, which would be a privacy regression).
5. **No key material storage for E2EE.** Needs `user_devices` (public key per device) + `messages.ciphertext` / `content_key` columns, keeping `body` for legacy/system messages. Note: `no-restricted-globals` bans `localStorage` in `public/js`, so private keys must live in **IndexedDB** (not banned) — that's the only viable client store here.
6. **`verifications` table is single-purpose** (selfie only). Needs a `kind` discriminator for email/phone/profile tiers.
7. **No soft-delete anywhere.** Moderation needs to remove content from users while retaining it for review/appeal. Content tables need `deleted_at` + `deleted_by` rather than hard `DELETE`.
8. **Notification fan-out has no home.** Sockets emit directly from services today. A `notifications` table plus one `notify()` service is needed so every event is persisted, deep-linkable and preference-gated.
9. **Growth headroom is fine.** The layered structure (routes → controllers → services → pool) cleanly accommodates travel mode, calls, AI matching, events, translation and subscriptions later without restructuring. **No architecture swap is needed — confirmed.**

---

## IMPLEMENTATION PLAN

Ordered by the spec's priority (security → privacy → … → polish). Each step ends green on lint + suites; nothing existing is removed.

**Phase 1 — Security & privacy hardening** *(fixes the two HIGH findings first)*
1. Authorize `/api/photos/:filename`: owner/visibility/block checks + short-lived signed media tokens.
2. Password recovery: reset-token table, request + consume endpoints, tight limiter, single-use expiring tokens.
3. Dedicated limiter on `username-available`; failed-login recording.
4. Blocking severs contact: unmatch + hide conversation on block; add unblock + blocked list.

**Phase 2 — Data foundation** *(one migration, additive only)*
5. `users`: `role`, `status`, `suspended_until`, `email_verified_at`, `phone`, `phone_verified_at`, `profile_completion`.
6. New tables: `content_likes`, `comments`, `content_reports`, `notifications`, `notification_prefs`, `moments`, `moment_views`, `moment_reactions`, `posts`, `post_media`, `polls`, `poll_votes`, `user_devices`, `admin_audit_log`, `password_resets`, plus `conversations.ttl_hours`. All ephemeral tables carry the `created_at`/`expires_at`/`idx_expires` convention; unified cleanup registry.

**Phase 3 — Identity & profile**
7. Verification tiers (✓email, ✓phone, ✓profile) with honest, non-guaranteeing copy.
8. Profile completion % (computed server-side, shown as a ring on the profile).
9. `/@username` shareable public profile route + page; controlled username changes with history.

**Phase 4 — Matching & likes**
10. Generic idempotent like primitive (profiles, photos, posts, moments) — `UNIQUE` key handles double-like inflation; blocked/deleted targets rejected.
11. Visible match reasons ("❤️ 5 shared interests", "📍 Same city").

**Phase 5 — Private communication**
12. Genuine E2EE: X25519 device keypairs (WebCrypto), IndexedDB private-key storage, per-conversation key agreement, AES-GCM payloads, server stores ciphertext only. Honest copy: what it does and does not protect.
13. Custom disappearing timers (1h/6h/12h/**24h default**/3d/7d), per conversation, server-enforced, applying to new messages only; expired content unreachable via API, DB, cache **and** old media URLs; media purged from disk.

**Phase 6 — Social layer**
14. Moments: photo/video/text, 24 h, view counts, reactions, reply→DM, delete/report/block.
15. Posts: text/photo/video + optional polls, 24 h, like/comment/reply/delete/report.
16. Comments + threaded replies with moderation hooks.

**Phase 7 — Safety & notifications**
17. Full report taxonomy across all 6 content types; report queue with moderator actions.
18. Notifications: table, fan-out service, deep links, preference gating, notification centre, no spam (coalescing).

**Phase 8 — Admin & moderation**
19. Role-based admin dashboard: user search (incl. by username), suspend/ban/restore, report queue + actions, content review, analytics (total/new/active users, matches, messages, posts, moments, reports, verification rate), full audit logging on every action.

**Phase 9 — Performance & polish**
20. Cursor pagination + infinite scroll across deck/search/nearby/feeds; FULLTEXT display-name search; feed indexes; lazy images + `srcset`.
    - **[done] Username/display-name search.** Measured at 50k users before changing anything: `EXPLAIN type=ALL`, **50,024 rows examined to return 10**.
      Now a capped `UNION` of two independently indexed branches (username `range` scan + `display_name` `FULLTEXT`), joined back by primary key:
      **~1,200 rows examined**, p50 **42.1ms → 14.8ms** (username prefix) and multi-word display-name search at ~22ms.
      Cost is now proportional to matches, not to table size. Sub-3-char terms fall back to a contains-scan (`innodb_ft_min_token_size = 3`).
      Rejected along the way, each for a measured reason: plain `OR` across the two indexes (optimiser cannot combine them → full scan, 135ms);
      `IN (SELECT … UNION …)` (becomes a DEPENDENT SUBQUERY → **81 seconds**); relevance-ordered candidates (125ms, and the outer `ORDER BY` discards the ranking anyway).
    - **[done] Deck query.** Same method: measured first, then changed one thing at a time, with a saved output snapshot (`tmp/p10-deckdiff.mjs`) proving each
      step returned byte-identical rows. Old code vs new code on an identical 50k-user database: **p50 235ms → 97ms, p95 282ms → 109ms.**
      (1) The shared-interest count was a correlated subquery re-executed once per candidate — 50k executions, ~190ms; now a derived `LEFT JOIN` aggregated once.
      (2) The block filter used one `NOT EXISTS` with an `OR` spanning two indexes, so MariaDB scanned the whole `uniq_block` index per candidate; split into two
      seekable `NOT EXISTS` (61ms → 15ms), applied to **all ten occurrences across four services** and guarded by a new suite, `tmp/p10-blockcheck.mjs`.
      (3) Deferred join: the inner query sorts ids and sort keys only, the outer fetches wide columns for the ten survivors, so the 50k-row sort stops carrying
      `bio`/`city`/`avatar_url` (170ms → 98ms in isolation).
      Two changes kept but honestly marginal: the age filter was non-sargable (`TIMESTAMPDIFF(...) BETWEEN`) and is now an equivalent, index-friendly date range —
      no measurable gain today because it matches nearly every row; and `idx_users_deck_rank (is_online, last_seen_at, id)` buys only ~4%, since `boosted` and
      `shared_count` sort ahead of it — its write cost on the presence columns was measured (~1%) before it was kept.
      Item 20 **complete**.
    - [done] **Feed indexes** already present (`idx_posts_feed`,
      `idx_moments_feed`); `EXPLAIN` confirms `Using index`. While checking
      them, found and fixed a real bug: the Moments tray selected the *oldest*
      100 live moments, so on a busy instance new moments never appeared.
    - [done] **`srcset`.** The 400px rendition was generated on upload then
      discarded for profile photos, so ~200px grid tiles fetched 1600px files.
      Persisted it as `user_photos.thumb_url` and added `photoSrcset()`; also
      fixed the photo route prefix, extended the ownership lookup so the
      **block check applies to thumbs**, and stopped leaking orphaned files on
      delete.
    - [done] **Keyset pagination + infinite scroll.** Audit found cursors already
      on posts/messages/notifications/admin reports and a working
      `IntersectionObserver` on the posts feed. Converted the one remaining
      `OFFSET` list, **People Nearby**, to a `(distance_km, id)` keyset cursor —
      its old ordering had no unique tiebreaker, so equidistant users could be
      skipped or duplicated between pages. Added infinite scroll to Nearby with
      a viewport-fill loop (a short page otherwise strands the list, because
      `IntersectionObserver` only fires on a transition). Fixed a header that
      read "0 people" above a full grid. Admin's user list keeps `OFFSET`
      deliberately (low traffic, jump-to-page). Two new suites; **19 green**.
    - [done] **Lazy images.** 16 list/grid `<img>` tags now carry
      `loading="lazy" decoding="async"`; 8 above-the-fold or instantly-revealed
      images left eager on purpose to avoid a blank flash.
21. Nav to 🏠 Discover · ❤️ Matches · 📸 Moments · 💬 Chats · 👤 Profile; mobile-first pass across iPhone/Android/tablet/desktop.
    - `[done]` **Chats had no destination** — conversations were reachable only
      through a `/matches` row. Added `/chats` (thread list) and turned
      `/matches` into a match roster of tiles, mirroring how Tinder separates
      the two. Tab bar rewritten across all 8 pages that carry it, plus the
      desktop sidebar; `/likes` kept and moved to the mobile header. Shared
      renderers extracted to `public/js/match-rows.js`; badges split so Chats
      shows unread messages and Matches shows unspoken-to matches.
    - `[done]` **Three real bugs.** Unread badges had never been visible
      (Tailwind's `.hidden` class beat the `hidden` property in `setBadge`);
      `settings-page.js` threw two unhandled `Failed to fetch` rejections as
      visible console errors when navigating away mid-load; Matches initially
      duplicated the Chats list (found by reading the screenshot while all
      assertions were green).
    - `[done]` Mobile pass at 390/360/820px — nav within viewport, ≥44px tap
      targets, no horizontal overflow. New suite `tmp/p10-nav.mjs` (42
      assertions); **23 suites green**.
22. i18n readiness: string catalogue, intl phone, timezone handling, no region hard-coding.
    - `[done]` **Audited before building.** Three of the four sub-items were already satisfied: `phoneSchema` is E.164-generic (`/^\+[1-9]\d{7,14}$/`, punctuation stripped — the only `+234` in the tree is an example inside an error message), the schema already carries `country` (ISO 3166-1 alpha-2), `languages` (JSON) and an indexed `city`, and the server never formats a date — it emits ISO and the client localises. A grep for `nigeria|+234|'NG'|NGN|africa/lagos` across `server db public src` returned no hits in executable code.
    - `[done]` **Real bug found and fixed: the ephemerality contract was deployment-dependent.** The mysql2 pool parses DATETIME as UTC (`timezone: 'Z'`) but MySQL defaults to `time_zone = SYSTEM`, i.e. the host clock — and all **126** expiry comparisons run off the DB clock via `NOW()`. Proven by experiment: on a session at UTC-8, a "24 hour" item written as `NOW() + INTERVAL 24 HOUR` reads back in Node as expiring in **16 hours** (at UTC+1, 25 hours). Fixed by pinning every pooled connection to `+00:00`. Note `initSql`/`init_command` is **not** a valid mysql2 option (it is silently ignored with a warning), so the pin hooks the pool's `connection` event. Mutation-tested: the suite asserts the unpinned UTC-8 case really does yield 16 h, so the guard cannot pass vacuously.
    - `[done]` **Per-user timezone + locale.** Added `users.timezone VARCHAR(64)` (IANA) and `users.locale VARCHAR(10)` (BCP-47), both nullable — NULL means "use the browser's". Validated against the runtime's own tz/locale database (`Intl.DateTimeFormat`, `Intl.getCanonicalLocales`) rather than a hard-coded list, so no region is privileged and new zones need no code change; `pt-br` canonicalises to `pt-BR`, `Mars/Olympus` is a 400. **Privacy:** both are returned only on the private `/auth/me` serialiser and deliberately withheld from the public profile — a precise IANA zone narrows a stranger's location far more than the coarse city already shown.
    - `[done]` **String catalogue** at `public/js/i18n.js`: dotted keys grouped by surface, `{placeholder}` interpolation, locale negotiation (exact tag → base language → `en`), and a missing key falls back to `en` then to the key itself so the UI can never render blank. `initI18n(user)` runs in `bootPage` before first paint. Adopted by the three locale-sensitive formatters — `timeAgo`, `clockTime` and the chat day separator now go through `Intl` with the user's zone. That fixed a latent off-by-one: the old day separator compared `toDateString()` in the *runtime's* zone, so near midnight a message could read "Yesterday" for anyone east of UTC.
    - `[note]` **Honest scope.** This makes the app *translatable*; it does not ship a second translation. `en` is the only complete catalogue, and ~105 runtime copy sites across 33 modules are still inline English. Extracting them is mechanical but would touch every module, so it is deliberately left as follow-on work rather than risked in this pass.
    - `[done]` `tmp/p10-i18n.mjs` — **63 assertions**, registered in the runner (**24 suites**). Covers the UTC pin + its mutation, the schema columns, 8 international phone formats and 5 rejections, zone/locale validation, a full API round-trip with DB persistence, the public-profile privacy check, catalogue resolution/interpolation/fallback, and one UTC instant rendered across Kiritimati / Los Angeles / Lagos.
    - `[done]` **Bonus fix from reading the screenshot.** The sidebar's Discover link still used the *same heart path* as Likes and Matches — item 21 replaced it with a flame in the tab bar only. Swapped in all 9 sidebars; a browser probe now confirms all 11 sidebar icons are unique.

**Phase 10 — Verification**
23. End-to-end tests for auth (incl. recovery + email/phone verify), usernames (duplicate/case/invalid/deleted/blocked/load/changes), profiles, matching, chat (encrypt/decrypt/delivery/expiration/custom timers), moments, posts, safety, notifications, admin. Extend `TESTING.md` and `README.md`.
    - `[done]` Coverage audit across the 15 existing suites found five spec-named flows with **no test at all**: logout, password recovery, email verify, phone verify, username changes. Everything else on this list was already covered, so `tmp/phase10.mjs` (**59 assertions**) targets the gap rather than duplicating ~4,300 lines. It registers throwaway `p10*` users and asserts the 12-user seed fixture is untouched on exit.
    - `[done]` **Real vulnerability found and fixed.** `revokeAllUserTokens` only revoked `refresh_tokens`, but access tokens are stateless JWTs that `requireAuth` never looks up — so a password reset left the old session working for its full 15-minute TTL. Added the `users.sessions_valid_from` token epoch + `assertTokenNotStale`, enforced in `requireAuth`, `optionalAuth` and `socketAuth`. Mutation-tested: disabling the check turns the assertion red.
    - `[done]` Runner extended to **16 suites, green twice consecutively** (~250 s each); lint clean; `sessions_valid_from` rebuilds from `db/schema.sql`.
    - `[done]` **Final sweep (after items 17-22 landed).** Re-audited the spec's flow list against the suites rather than trusting the earlier pass: verify email/phone, custom TTL timers, polls + voting, username duplicate/case/cooldown/`USERNAME_TAKEN`, suspend/ban/restore and audit logs are all genuinely asserted. (An initial keyword grep suggested five gaps; all five were false alarms from case/pattern artifacts, confirmed by reading the call sites.)
    - `[done]` **Schema drift check.** Built a throwaway DB from `db/schema.sql` alone and diffed every column of all **42 tables** against the live DB: **zero drift**, so the `timezone`/`locale` columns added by hand in item 22 really are reproducible from source. Then did a full **cold rebuild** (`migrate --fresh` + `seed`) and reran everything green — the closest thing to a real deploy. The cleanup job reaping exactly 1 message on boot is correct: the seed deliberately plants one already-expired message to prove TTL enforcement.
    - `[done]` **Security spot-check** against the live server: login and `forgot-password` are non-enumerable (byte-identical responses for known vs unknown accounts); `devResetToken`/`devCode` are gated behind `!env.isProd`; uploads are **not** reachable as static files (404 on `/uploads/...`) and only via authorising routes (401 without a session); photo filenames are UUIDv4, so private media is not URL-guessable; CSP has no `unsafe-inline` for scripts; no `Access-Control-Allow-Origin` reflected to a forged origin; no `X-Powered-By`; `requireRole` returns **404** to authenticated non-staff.
    - `[done]` **Two real bugs found by the sweep, both on `/profile`** — the one page the earlier nav work missed. (1) It was the **only page of 9 with no `<main>` landmark**, so the "Skip to content" link pointed at a plain `div` and screen-reader users lost main-region navigation there. (2) It still carried a **stale 3-tab nav** using the pre-item-21 `data-tab` attribute, with a heart for Discover and a *speech-bubble* icon labelled "Matches". Both fixed; the in-page `.seg-tab` controls on `/likes` and `/nearby` legitimately keep `data-tab` and were left alone.
    - `[done]` `tmp/p10-sweep.mjs` — **98 assertions**: all 8 primary pages x 5 viewports (iPhone SE 375, iPhone 14 390, Android 360, iPad 820, desktop 1280) asserting content renders, no horizontal overflow, 5 tabs with >=44px tap targets inside the viewport on mobile, sidebar on desktop, and zero console/page errors. Registered in the runner: **25 suites**.

## Post-V1 hardening

**H1. Credential logging (fixed).** `forgot-password` logged the full reset
*link* and `verify/start` logged the 6-digit *code* — both unconditionally, at
`info`, which is the production default. The API responses were correctly gated
behind `!env.isProd`, but the log line walked straight around that gate: anyone
with log access (aggregator, sidecar, support tooling, a leaked dump) could read
a live reset token and take over any account. Same shape as the stateless-JWT
bug in item 23 — the guard existed, a second path ignored it.
- Fixed at the call sites (reset logs `userId` only; verify logs `userId`+`kind`,
  and no longer logs the user's email/phone as `target`).
- Plus **defence in depth in the logger itself**: a `redact()` pass blanks
  secret-named keys (`code`, `token`, `link`, `password`, `otp`, `authorization`,
  `cookie`, …) at any depth and strips `?token=`/`?code=` from any URL-looking
  string, so a careless future log line cannot leak either.
- Outside production the reset flow now also returns `devResetLink`, so losing
  the logged link costs nothing in development.
- `tmp/p10-secretlog.mjs` (**23 assertions**) covers the redactor as a unit, the
  live server's real log stream for both flows, and a static check that the call
  sites stay clean — the last one matters because the runtime check is
  (correctly) satisfied by the safety net alone. Mutation-tested three ways:
  reinstating the leak under a misnamed key stays green (the net catches it),
  disabling the redactor fails, and passing `code` back to the logger fails.

**H2. Logger could crash the process (found by mutation-testing H1).** Disabling
the redactor surfaced a pre-existing bug: `emit()` called bare
`JSON.stringify(meta)`, which **throws on a circular object**. Inside a logger
that is fatal — an error path logging a request, socket, or an error with a
cyclic `cause` would kill the server instead of recording the problem. Added
`safeStringify()` (try → cycle-replacer → `'[unserialisable meta]'`) to *both*
the prod-JSON and dev-text branches. Logging must never be the thing that fails.

**H3. Unhandled `TypeError: Failed to fetch` on `/nearby` (fixed).** `p10-nav`
went red in the runner but passed in isolation, ~1 run in 3: `nearby-page.js`
ended with a top-level `await boot()` and no `.catch()`, so navigating away
mid-flight turned the aborted fetch into an unhandled `pageerror`. Now
`boot().catch()` swallows abort/fetch races and shows a real error gate for
anything else. Verified with 5 consecutive clean runs, not one.

**H4. Notification deep links went nowhere (fixed).** Reported as "linking
issues". A sweep of every link surface found four independent faults, all on
the path from a notification to the content it points at:

1. **Dead route.** `post.service.js` emitted `href: '/posts#comment-…'` and
   `'/posts#post-…'`, but there is no `/posts` route and no `posts.html` —
   posts are mounted on `/moments` (`moments-page.js` imports `initPosts`).
   Live `/posts` returned 404, so *every* post notification was a dead end.
   Both now emit `/moments#…`.

2. **Missing anchor.** Comments rendered with `data-comment` but no `id`, so
   `#comment-<id>` could never resolve even on the right page. Added
   `id="comment-${c.id}"` plus `scroll-mt-24`.

3. **Nobody handled the hash.** There was zero hash handling in the client —
   no `location.hash`, no `scrollIntoView`. Feeds render asynchronously, so
   even a correct anchor lost the browser's native jump: the element does not
   exist when the browser looks for it. `posts.js` gained `focusFromHash()`,
   which paginates up to 10 pages to find the card, auto-opens a collapsed
   comment thread, waits for the async render and flashes a ring on arrival.
   `moments.js` gained `openFromHash()` — a moment is not scrollable, it lives
   in a rail and opens in the full-screen viewer, so it is located across rails
   and the viewer is opened at that index; it refetches once before giving up,
   because the notification may be for a moment posted after the page loaded.

4. **Second click did nothing.** Both handlers ran once at init. Clicking a
   second notification while already on `/moments` is a *same-document* hash
   change, which re-runs nothing, so the page just sat there. Both modules now
   listen for `hashchange`.

A comment id does not identify its post, so the client needs a lookup:
`GET /api/comments/:id/context` → `{commentId, postId}`. It reuses the same
`LIVE` + `NOT_BLOCKED` clauses as every other read, so a deep link cannot
confirm the existence of an expired post or reach a blocked user's thread, and
returns 404 `That comment is no longer available.` otherwise.

Stale links degrade gracefully — expired content shows a toast, never a crash.
Covered by `tmp/p11-linkaudit.mjs` (25 static checks, mutation-tested) and
`tmp/p11-deeplink.mjs` (27 browser checks), including the real end-to-end
journey: tunde replies → amara opens the bell → clicks → the thread opens
scrolled to the reply.

**H5. Deleted profile photos left their thumbnail on disk (fixed).** Profile-photo delete removed the 1600px original but never the 400px rendition, so every deleted photo leaked a file that survived indefinitely. Cause: `savePhotoFile` publishes both files under the same `/api/photos/<uuid>` URL shape, but writes the original to `photos/` and the thumb to `thumbs/`; the delete path reconstructed `photos/<basename>` for *both* URLs, so the thumb unlink always missed. Nothing caught it because the API still returned 200, the DB row was gone, and `GET /api/photos/<thumb>` still 404s -- `getPhotoForViewer` resolves the basename back to an owning row, so the orphan was unreachable but never reclaimed. Disk usage was the only symptom.

`user_photos` is the only table that stores public URLs rather than storage keys; every other media path (attachments, moments, posts, cleanup sweep, `purgeFiles`) persists the real key and was unaffected -- verified by reading all 13 `storage.remove` call sites. Fix: new `uploadService.removeStoredFile(basename)` resolves a basename against each directory the writer can target (`photos/`, `thumbs/`, `videos/`, root) and removes the first hit; the controller now calls it for both URLs. Covered by `tmp/p11-mediacleanup.mjs` (13 checks: both files land on disk, the thumb is provably *not* in `photos/`, both are gone after delete, no net leak, both URLs 404). Mutation-tested by restoring the old line -- 2 checks go red.

**H6. Blocked-people UI — the last open item from this audit (shipped).** The block endpoints existed from Phase 1 but nothing in the client ever called them, so blocking was a one-way door: reversing it meant editing the database by hand. Added `api.blockedList()`/`api.unblock()` and a "Blocked people" section in Settings — avatar, display name, `@username` (or "Account no longer available" for a deleted account), an empty state, and an unblock button behind a confirm dialog that states plainly that unblocking does **not** restore the old match or chat, because it does not. Rows delegate their click handler, since the list repaints after every change.

Two process notes worth keeping. First, the initial divider used `divide-line`, the only such use in the codebase; both `--c-line` and `--c-hairline` are raw black and the house convention is `divide-hairline/[var(--hairline-a)]`, so it rendered as a heavy black rule. Assertions were green — a **screenshot** caught it, in both themes. Second, the accompanying suite (`tmp/p11-unblock.mjs`, 14 checks) deliberately verifies the block is *lifted* rather than merely un-rendered: after the row vanishes it re-queries the server, username search, and the profile endpoint. Mutation-tested twice (no-op unblock, and skipping the confirm dialog); both mutants are caught.

**H7. Every feed 500'd on MySQL 8 — `Incorrect arguments to mysqld_stmt_execute` (fixed).** Reported from the user's own machine (Windows + MySQL 8): `GET /api/posts` and `GET /api/moments` both returned 500 from `pool.js:52`. The database engine, not the code path, was the variable — our CI runs MariaDB, which is why **31 green suites never saw it**.

Cause: mysql2 picks a wire type from the JavaScript value, so every JS `Number` is sent as `MYSQL_TYPE_DOUBLE`. Since **MySQL 8.0.22** the server type-checks prepared parameters and will convert a *string* to an integer but **not a double**, so any `LIMIT ?` — we have 19 — is rejected outright. MariaDB still coerces silently. This is upstream [sidorares/node-mysql2#1239](https://github.com/sidorares/node-mysql2/issues/1239); the maintainer's recommended fix is to send integers as strings.

Fixed once, at the driver boundary, rather than at 19 call sites: `coerceParams()` in `pool.js` maps finite **safe** integers and `bigint` to decimal strings and leaves everything else alone. The narrowness is the point — floats stay floats, because latitude, longitude and distance genuinely are DOUBLEs and coercing them would be the mirror-image bug (the deck alone binds `4.8156` next to integer limits in one 32-parameter list). `null`/`undefined`/`Date`/`Buffer`/`boolean` pass through untouched, unsafe integers are left for the driver since they have already lost precision, and the original array is returned by identity when nothing changed. `withTransaction` hands the callback a `wrapConnection()` Proxy so the **35 `conn.execute` + 2 `conn.query`** sites inside transactions are covered too; without it the module helpers would be fixed and every transaction still broken.

Because MariaDB cannot reproduce the server-side rejection, a green suite proves nothing here. `tmp/p11-mysql8params.mjs` (34 checks) therefore **spies on the driver** — patching `execute` on both `PromisePool` and `PromisePoolConnection` — and asserts on the parameter *types* actually handed to mysql2: nothing integer-shaped may arrive as a JS number, in `query()`, in `execute()`, inside a transaction, in the post feed, or in the deck; and a float bound beside an integer must stay a number while the integer becomes a string. Mutation-tested four ways (coercion disabled, floats over-coerced, transaction proxy removed, `query()` bypassing coercion); each is caught, and the transaction mutant is caught *only* by the type assertions — every SQL-level check still passed on MariaDB.

A second, independent defect surfaced in the same report: the write had actually **succeeded** (`POST /api/posts` → 201) and only the follow-up feed `GET` failed, yet the composer said *"Could not post that."* — so people posted the same thing twice. Both composers awaited `load()` inside the write's `try`. The reload now sits outside it and the confirmation fires first. Note `load()` swallows its own errors, so the visible change is toast *order*, not reachability: `tmp/p11-composer.mjs` (6 checks) drives the real composer with the feed forced to 500, asserts the post is genuinely saved and that the confirmation precedes any feed complaint, and is mutation-tested against the original ordering.

**Explicitly deferred** (architecture leaves room, no code now): travel mode, voice/video group calls, AI matching, group dates, events, friendship mode, translation, subscriptions, boosts.
