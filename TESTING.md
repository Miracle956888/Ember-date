# Testing guide

Two automated suites plus a manual checklist covering the acceptance criteria.

```bash
npm run lint                    # ESLint, must report zero problems
node scripts/smoke-socket.js    # 17 realtime assertions
node scripts/smoke-browser.js   # 114 end-to-end assertions in headless Chromium
```

The server must already be running (`npm run dev` or `npm start`) with the demo
data seeded (`npm run db:seed`) before either suite is started.

---

## 1. Automated: socket suite

```bash
node scripts/smoke-socket.js
```

Drives two authenticated `socket.io-client` connections through the real
event contract. It asserts:

* handshake rejects a missing or invalid cookie, accepts a valid one
* `ready` fires with the user payload; presence flips online/offline
* `chat:join` returns history, `otherUserId`, `ttlHours` and `serverTime`
* joining a conversation you are not part of is refused
* a message from A reaches B, and the ack carries the persisted row
* the same `clientUuid` sent twice yields one row (de-duplication)
* typing indicators, read receipts, and the 20 msg/10 s rate limit
* delivery latency is measured and printed

**Expected:** `17/17 pass`, latency in the low tens of milliseconds.

---

## 2. Automated: browser suite

```bash
node scripts/smoke-browser.js            # add --shots to save screenshots
```

Uses `playwright-core` with two contexts — Amara on a 390×844 mobile viewport
and Kelechi at 1440×900 — signed in simultaneously against the running server.
Amara's context is granted geolocation (Port Harcourt, 4.8156 / 7.0498) so the
location surfaces are exercised for real. 114 assertions covering:

| Group          | What it proves                                                             |
| -------------- | --------------------------------------------------------------------------- |
| auth (6)       | login works; `ec_at`/`ec_rt` are httpOnly; `ec_csrf` is readable; **localStorage stays empty** |
| deck (3)       | cards render, swiping advances, buttons and keyboard both work              |
| matches (2)    | list renders, links carry the right `conversationId`                        |
| chat (10)      | history loads, send works, **A→B delivery under 300 ms**, typing, receipts, TTL chips |
| profile (6)    | data loads, the form prefills, the `@handle` shows, photo grid and stats render |
| search (5)     | the sheet opens, a partial handle finds the right person, matched results offer **Message**, unknown handles show the empty state, no horizontal scroll |
| register (4)   | the username field exists, a taken handle is flagged live, input is lowercased as you type, a free handle reads `available` |
| share (7)      | **`/@username` serves 200 to a signed-out visitor** and renders the real profile (handle, sign-up path), leaks no email, does not scroll sideways at 390 px, and an unknown handle says "No user found" |
| 404 (2)        | unknown routes return HTTP 404 and render the friendly page                 |
| nearby (6)     | the gate clears once permission is granted, tiles carry a bucketed distance, **no raw coordinates leak**, bumped-into lists real encounters |
| likes (5)      | likes-you, visitors, taps, favourites and top picks all populate            |
| settings (3)   | three location modes render, a filter change survives a reload, passport switches city |
| profile+ (4)   | interest catalogue, pre-selected interests, prompts, dating intent          |
| chat location (4) | the share button exists, a shared place renders as a map card with a map link, and a risky message triggers the "are you sure" nudge |
| theme (12)     | the toggle flips light/dark, the body colour really changes, the choice persists in `ec_theme`, the **server stamps the theme at first paint (no FOUC)**, Settings offers light/dark/system with correct `aria-checked`, and **no white plate survives in dark mode** |
| responsive (33)| 11 routes × 320/768/1440 px with **no horizontal scroll**                   |
| console (1)    | no console errors, page errors, failed requests or unexpected 4xx/5xx       |

**Expected:** `ALL PASS — 114 passed, 0 failed`. Measured realtime delivery is
around **80 ms**, well inside the 300 ms budget.

> Requires a Chromium build. If Playwright's own installer fails, point it at an
> existing binary — the script accepts an explicit `executablePath` and runs
> with `--no-sandbox`.

---

## 3. Manual checklist

### 3.1 Registration and auth

1. `/register` — the wizard validates each step and refuses to advance while a
   field is invalid.
2. Register a new account → you land on the swipe deck, already signed in.
3. Reload → still signed in. Sign out → `/app` bounces you to `/login`.
4. DevTools ▸ Application ▸ Local Storage is **empty**; Cookies show `ec_at`
   and `ec_rt` flagged `HttpOnly`.
5. Delete the `ec_at` cookie by hand and reload — the client silently refreshes
   and stays signed in.

### 3.2 Usernames and search

1. `/register` step 1 — type `amara` in **Username**: the badge reads `taken`
   within a moment. Type `amara.2026`: it reads `available`.
2. Type `Amara..X` — it lowercases as you type and the badge explains the rule
   rather than silently failing.
3. Sign in and open **Search by username** from the sidebar, the mobile header
   icon, or by pressing `/`. The input focuses automatically.
4. Type `kel` → `@kelechi.shoots` appears with their photo, age and city.
5. As Amara (already matched with Kelechi) the row offers **Message** and it
   opens the existing conversation. As someone unmatched it offers **Like**.
6. Like someone from search who already liked you → the match modal fires
   exactly as it does from the deck, and the new conversation appears in
   Matches on both sides.
7. Type `zzzznobody` → a friendly empty state, not an error.
8. Block someone, then search for them — they no longer appear, and you no
   longer appear for them.
9. `/profile` — change your handle to one that is taken and save: the field
   shows `That handle is taken.` and nothing is written.

### 3.3 Nearby and live location

Chrome needs a secure context: use `http://localhost:3000` (localhost counts as
secure) or a real HTTPS origin. In DevTools → Sensors you can override the
geolocation to test distances without moving.

- [ ] `/nearby` on a fresh account shows the opt-in gate, **not** a grid.
- [ ] Choosing "Approximate" then "Turn on location" triggers the browser
      permission prompt exactly once, and the grid appears after granting.
- [ ] Denying permission shows a readable message, not a silent empty screen.
- [ ] Tiles show a bucketed distance ("under 1 km away", "4 km away") and never
      a raw coordinate.
- [ ] Set the mode to **Approximate** in `/settings`, then check the database:
      `SELECT lat, lng FROM user_locations WHERE user_id = 1;` — the values must
      be multiples of 0.01, i.e. already rounded before storage.
- [ ] Set the mode to **Off**: the row disappears from `user_locations` entirely.
- [ ] Passport to Lagos, reload `/nearby`: the header says you are browsing
      Lagos and the results change.
- [ ] Turn **Incognito** on, view another account's profile from a second
      browser, and confirm you do **not** appear in their `/likes` → Visitors.
- [ ] With two accounts placed within ~200 m of each other (Sensors override on
      both), each should appear in the other's "Bumped into" tab, and the one
      already online should get a live toast.

### 3.4 Location sharing in chat

- [ ] The pin button in the composer offers "Send once", "Live for 15 min" and
      "Live for 60 min".
- [ ] "Send once" posts a map card with a working "Open in maps" link.
- [ ] A live share shows a green LIVE badge, a countdown bar above the composer,
      and a working "Stop" button.
- [ ] While live, moving the simulated position updates the pin in the other
      user's window without a reload.
- [ ] A shared location still disappears with the rest of the chat after 24 h,
      and "Clear chat" removes it immediately.

### 3.5 Safety nudges

- [ ] Typing a message matching a flagged pattern (e.g. "send nudes") shows an
      "Are you sure?" dialog before it sends. Cancelling keeps the text in the
      composer.
- [ ] "Send anyway" delivers the message, and the **recipient** sees a "Does
      this message bother you?" bar with a Report link.
- [ ] An ordinary message shows neither prompt.

### 3.6 Interests, prompts and verification

- [ ] `/profile` shows the interest catalogue; selecting a 9th interest is
      refused with a toast.
- [ ] Interests persist across a reload.
- [ ] Adding a prompt, then removing it, both persist.
- [ ] Verification opens the camera, states a random pose, and awards the blue
      tick. The tick then appears on your cards elsewhere in the app.
- [ ] Turning on "Verified profiles only" hides unverified people from the deck
      and from Nearby.

### 3.7 Swipe deck

1. Drag a card: it rotates and follows the pointer; LIKE / NOPE stamps fade in.
2. Release past the threshold to commit; release short and it springs back.
3. Buttons and keys agree: `←` pass, `→` like, `↑` superlike, `Z` rewind.
4. Exhaust the deck → the empty state appears with a call to action.
5. Mutual likes pop the "It's a match!" modal on both sides in real time.

### 3.8 Realtime chat — target under 300 ms

1. Open the same match in two browsers, side by side.
2. Send a message — it appears on the other screen effectively instantly.
3. Typing in one shows the animated indicator in the other.
4. Read receipts turn double-ticked when the peer opens the thread.
5. Kill the network in one tab, send, restore it — the message reconciles with
   no duplicate bubble.

### 3.9 Media uploads

1. Attach a JPEG or PNG under 10 MB → thumbnail appears, then the full image.
2. Attach an MP4 under 50 MB → poster frame appears; playback works, and
   seeking works (range requests).
3. Rename `evil.exe` to `evil.jpg` and attach it → rejected by magic-byte
   validation, not by extension.
4. Copy a media URL and open it in a signed-out window → **denied**.

### 3.10 The 24-hour rule

Restart with a short TTL:

```bash
MESSAGE_TTL_HOURS=0.02 npm start    # about 72 seconds
```

1. Send a message. The chip counts down; it turns **amber** under an hour and
   **red** under ten minutes.
2. At zero the bubble fades and is removed from the DOM; screen readers
   announce *"A message expired and was deleted."*
3. The banner above the thread names the next message due to expire.
4. Within five minutes the cron pass logs
   `[cleanup] run complete {"deletedMessages":n,…}`.
5. Confirm in SQL that the row is gone, and that any attached file is gone from
   `uploads/`:

```sql
SELECT COUNT(*) FROM messages WHERE conversation_id = 1;
```

6. **Clear chat** from the thread menu → the thread empties for *both* users
   immediately, and the rows disappear on the next cleanup pass.

### 3.11 Calls

Follow *Testing video calls* in the README, then verify each edge case:

| Scenario                        | Expected                                                  |
| ------------------------------- | ---------------------------------------------------------- |
| Callee signed out               | "They are not online right now", logged as missed          |
| Callee already on a call        | "They are on another call"                                 |
| Nobody answers                  | Ringing stops after 35 s, logged as missed                 |
| Callee declines                 | Caller sees "Call declined"                                |
| Camera permission denied        | Clear recovery instructions, no dead-end                   |
| Peer closes the tab mid-call    | Other side ends with "They lost connection"                |
| Hang up after a real conversation | Both sides show the duration; `call_logs` records it     |

Confirm call metadata is **exempt** from the purge:

```sql
SELECT id, status, duration_secs, started_at FROM call_logs ORDER BY id DESC;
```

Rows persist past 24 hours by design — metadata only, never content.

### 3.12 Responsive and accessibility

1. Check 320, 375, 768, 1024 and 1440 px — no horizontal scroll at any width.
2. On mobile the bottom tab bar is visible and clears the home indicator; at
   ≥1024 px the layout becomes a centred shell with a ~380 px sidebar.
3. Tab through every page: focus rings are always visible, and modals trap
   focus and close on `Escape`.
4. Enable "reduce motion" in the OS — swipe and modal animations become
   near-instant instead of springy.
5. Run Lighthouse on `/app`: **Performance ≥ 85, Accessibility ≥ 95**.

### 3.12b Light and dark mode

1. Click the sun/moon button in the sidebar. The whole app repaints — surfaces,
   text, borders, shadows, the deck card chrome and the chat bubbles.
2. Reload. The page must arrive **already** in the chosen theme: there should be
   no white flash before the dark paint. (View source: `<html lang="en"
   class="dark">` is in the served HTML, not added by script.)
3. Sign out and visit `/`, `/login`, `/register` — the theme carries over, and
   those pages have their own toggle.
4. **Settings → Appearance** → choose **System**, then change the OS/browser
   colour scheme. The app follows immediately, without a reload.
5. In dark mode read a chat: the TTL countdown chips must still be legible at
   amber (<1 h) and red (<10 m), and the "messages disappear" banner too.
6. Check the deliberately fixed surfaces still look right: the call screen's
   video stage stays dark in both themes, and white text on brand gradients is
   unchanged.
7. Tab to the toggle: it is reachable, has a visible focus ring, and announces
   its state (`aria-pressed`) plus a "Switch to dark/light mode" label.
8. Enable "reduce motion" — the theme still switches, but without the colour
   cross-fade.

### 3.13 Security spot-checks

```bash
# CSRF: a mutation without the header must fail
curl -i -X POST http://localhost:3000/api/swipes \
  -H 'Content-Type: application/json' \
  -b 'ec_at=<paste>' -d '{"swipeeId":2,"direction":"like"}'
# expect 403

# Authorisation: a conversation you are not part of
curl -i http://localhost:3000/api/conversations/2/messages -b 'ec_at=<amara token>'
# expect 403

# Rate limiting
for i in $(seq 1 30); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST http://localhost:3000/api/auth/login \
    -H 'Content-Type: application/json' -d '{"email":"a@b.c","password":"x"}'
done
# expect 401s then 429s
```

Also confirm by inspection:

* `grep -rn "localStorage\|sessionStorage" public/js/` → no hits
* no secret appears in any file under `public/`
* every SQL statement uses `?` placeholders — no string concatenation

---

## Acceptance criteria status

| Criterion                                    | Status | Evidence                                        |
| -------------------------------------------- | ------ | ------------------------------------------------ |
| Realtime delivery < 300 ms                   | ✅     | ~80 ms measured in the browser suite             |
| Uploads: image + video, thumbs, posters      | ✅     | manual §3.5; magic-byte rejection verified       |
| TTL chips, auto-removal, announcement        | ✅     | verified in-browser at warn/urgent/zero          |
| Cleanup deletes both row and file            | ✅     | `{deletedMessages:4, deletedFiles:2}`            |
| Call flows incl. decline/busy/offline/timeout | ✅     | two-browser P2P call, connected in ~155 ms       |
| No horizontal scroll at 320/768/1440         | ✅     | 24 automated assertions                          |
| No secrets client-side, no localStorage      | ✅     | asserted in the browser suite + ESLint rule      |
| No SQL string concatenation                  | ✅     | every statement parameterised; search escapes `%`/`_` and passes `' OR 1=1 --` through unharmed |
| Username search finds and matches a person   | ✅     | 5 browser assertions + full search→like→match flow |
| People Nearby ranks by real distance         | ✅     | haversine output cross-checked against independently computed great-circle distances (PH→Owerri 74.3 km, PH→Enugu 190.8 km) |
| Approximate mode rounds before storage       | ✅     | `user_locations` holds only 0.01° multiples for those users |
| No coordinates exposed to other users        | ✅     | browser suite fails if a coordinate-shaped number appears in the Nearby grid |
| "Off" erases stored location                 | ✅     | `DELETE` issued on switch; row gone from `user_locations` |
| Live share expires and dies with the message | ✅     | `message_locations.expires_at` cascades with the parent message |
| Dark mode on every screen, no FOUC           | ✅     | 12 browser assertions; theme resolved server-side from the `ec_theme` cookie + `Sec-CH-Prefers-Color-Scheme` hint and stamped into `<html>` |
| Dark-mode contrast ≥ 4.5:1                   | ✅     | body ink on surface measures 14.1:1; brand lifts to `#C68DE8` for dark |
| Lighthouse Perf ≥ 85 / A11y ≥ 95             | ⚠️     | run manually — no Lighthouse in this environment |

---

## Phase 5 — private communication (E2EE + custom timers)

Two automated suites cover this area:

| Suite | Assertions | What it can prove |
| --- | ---: | --- |
| `tmp/phase5.mjs` | 68 | API + **raw SQL** invariants (connects with `mysql2` and reads the rows directly, rather than trusting the API's own view of itself) |
| `tmp/phase5-ui.mjs` | 37 | Real Chromium, **two browser contexts** — the only way to prove encryption works, since it happens entirely client-side |

Separate contexts matter: each gets its own IndexedDB, so amara and tunde hold
genuinely different device keys. A single context would have shared key
material and the test would pass without proving anything.

| Criterion | Status | Evidence |
| --- | --- | --- |
| Recipient can actually decrypt | ✅ | amara sends, tunde's DOM renders the plaintext — cross-context |
| Plaintext never reaches the server | ✅ | newest row: `body IS NULL`, `is_encrypted=1`; `COUNT(*) WHERE body LIKE '%secret%' OR ciphertext LIKE '%secret%'` → **0** |
| No private key is ever stored | ✅ | `SHOW COLUMNS FROM user_devices` has no `private`/`secret` column; no decrypt function exists server-side |
| Keys are wrapped per device | ✅ | one row per `device_id`; device A cannot fetch device B's copy even in the same account |
| Wrap addressed to a non-participant | ✅ | 400, and no row written |
| Outsider hitting keys/devices/timer | ✅ | 403 for zainab (not in conversation 1) |
| CSRF enforced on device registration | ✅ | POST without the token → 403 |
| Malformed ciphertext rejected | ✅ | base64 regex on `ciphertext` and `iv` → 400 (this was a real bug: `max()` alone accepted junk) |
| Timer offers exactly 6 durations, 24h default | ✅ | picker asserts count and `aria-checked` |
| Timer change is **not** retroactive | ✅ | older row stays 24h while the next message is stamped 1h, read from `messages` |
| Timer syncs to the peer live | ✅ | tunde's banner flips to 1h over the socket, no reload |
| Timer change is announced in-thread | ✅ | system message contains "new messages only" |
| Invalid TTL rejected | ✅ | anything off the menu → 400 |
| Honest claims | ✅ | details panel must mention screenshots **and** metadata, and must **not** contain "nobody can ever read" |
| Undecryptable history labelled truthfully | ✅ | distinguishes "encrypted before you signed in on this device" from a key that may still arrive |
| Sign-out wipes device keys | ✅ | `wipeKeys()` on logout, so a shared computer leaks nothing |
| Mobile 390px | ✅ | no horizontal overflow; encryption badge visible |

### Running the whole regression

```bash
node tmp/regress-all.mjs
```

It resets the database between suites. `tmp/phase4.mjs` unmatches amara and
tunde, which deletes conversation 1 — chaining the suites by hand made
`phase5.mjs` fail with a 404 that looked like a product bug but was pure
fixture ordering. Current state: **480 assertions green across 11 suites.**

### `tmp/bruteforce.mjs` — login throttle (4 assertions)

Running the suites back-to-back surfaced a genuine flaw: `authLimiter` counted
**successful** logins toward its 20-per-15-minute cap, so shared IPs and normal
multi-device sign-ins could lock themselves out while an attacker's failed
guesses were capped regardless. Fixed to `skipSuccessfulRequests: true`, and
re-proven — a guessing run still gets 429 at attempt 21, the block is
per-account, and 25 consecutive valid logins now all succeed.

## Phase 6 — Moments & 24-hour posts

`tmp/phase6.mjs` (101, API) · `tmp/phase6-media.mjs` (31, media security) ·
`tmp/phase6-ui.mjs` (45, real Chromium).

### `tmp/phase6-ui.mjs` — what the browser actually does

Two live sessions (amara desktop 1280px, zainab mobile 390px) drive the real
UI: navigate to Moments, publish a post, like it twice to prove the count
returns to 0 rather than inflating, reload to prove the like persisted,
comment, run a poll (vote, re-vote, confirm the total stays at 1), publish a
moment, open the full-screen viewer, then switch users to check what a
*non-owner* sees — no view count, a reply action, a working reaction, and the
match requirement explained in words when the reply is refused.

| Area | Assertions |
|---|---|
| navigation (sidebar, active tab, tray add-tile) | 4 |
| posting + visible expiry countdown | 3 |
| like idempotence (incl. survives reload) | 4 |
| commenting | 3 |
| polls (render, percentage, total, vote change) | 4 |
| sharing a moment | 2 |
| the viewer (text, lifetime, view count, delete, Escape) | 7 |
| a second user's view (incl. the 403 match gate) | 6 |
| mobile layout at 390px (5 tabs, no h-scroll) | 4 |
| reporting (taxonomy, NCII wording, confirmation) | 4 |
| owner deletion | 2 |
| console hygiene, both sessions | 2 |

The suite deletes its own leftovers through the app's own `api.js` before it
starts, so it is re-runnable without a DB reset — verified by running it twice
back-to-back.

### `tmp/phase6-media.mjs` — "private media must not be guessable by URL"

The audit's headline media requirement, tested from the attacker's side:

- stored filenames are random UUIDs that do not echo the uploaded name;
- an upload that is not yet attached to anything is **404 even for its own
  uploader** (fails closed);
- an unauthenticated request for a *known-good* URL is 401 — the URL is not
  authority;
- a guessed UUID is 404; three path-traversal payloads (`../../.env`,
  `../../db/schema.sql`, `/etc/passwd`) are refused;
- **blocking revokes access to an already-known URL** on the very next read,
  and unblocking restores it — authorisation is resolved per read through the
  owning content row, never cached into the link;
- deleting the moment kills the media URL immediately, for the owner too;
- responses carry `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`;
- an SVG (stored-XSS vector) and a `.php` payload are both rejected at upload.

### A UI bug that only a real browser could catch

Playwright reported the composer's Post button as "visible, enabled and stable"
*and* "outside of the viewport" for 30 seconds. That pairing means layout
overflow, not a flaky selector. Root cause: `.animate-pop-in` finishes on
`transform: scale(1)` with fill-mode `both`, which permanently overwrote the
`-translate-x/y-1/2` used to centre `.sheet` — so **every** desktop modal in
the app was hanging below and right of centre, and a tall one pushed its own
action row off-screen. Fixed by centring with `inset-0 + margin:auto` and
capping the sheet at `88dvh` with internal scrolling. curl, `node --check` and
lint were all green throughout; only the browser saw it.

## Phase 7 — notifications

### `tmp/phase7.mjs` — fan-out, coalescing, gating (50 assertions)

All twelve kinds are actually emitted (an earlier audit found four that were
defined but never fired). The suite asserts coalescing bumps a counter rather
than creating rows, that withdrawing the underlying action withdraws the
notification, that preference gating blocks the categories a user disabled
while verification/safety/system always arrive, that a message notification
never carries the message text, and that blocking purges notifications in both
directions without unblocking resurrecting them.

### `tmp/phase7-ui.mjs` — the bell, in a real browser (35 assertions)

Two bells per page (one mobile, one desktop) with exactly one visible at any
breakpoint; a live `notification:new` push reveals the badge with no reload;
the sheet fits both 1280×900 and 390×844; opening marks read and the server
agrees; deep links resolve to a **real chat composer** rather than merely
returning non-404; six preferences load, persist and survive a reload.

### Two bugs the assertions passed and the screenshots caught

Everything above was green while the notification centre displayed **"Tunde
and 21 others sent you a message"** — twenty-two messages from one person in a
1:1 conversation. Coalescing counts events, not actors, so "and N others" is
only ever truthful for kinds where an actor can contribute at most once. There
is now an explicit assertion that a burst is never described that way.

The second was invisible in the app and only showed up as an intermittent
console error: `requireAuth` runs behind a top-level `await bootPage(...)`, so
navigating away mid-boot aborted the in-flight fetch and produced an unhandled
`TypeError: Failed to fetch`. It reproduced roughly one run in five, which is
exactly the profile of a bug that gets dismissed as flakiness. Confirmed by
forcing the race (log in, navigate immediately) — 1/1 before the fix, 0/25
after.

### Three test-harness defects found while stabilising the suite

Worth recording, because each one had been quietly lying:

1. **`phase4-ui.mjs` and `regress-profile.mjs` never called `process.exit`**,
   so they always exited 0 and the runner printed PASS over a suite reporting
   real failures. Both now set an exit code, and the runner additionally
   greps the output for failure wording so a forgotten exit code cannot hide
   a red suite again.
2. **`bruteforce.mjs` poisoned whichever suite ran after it.** The auth
   limiter is keyed on IP+email and lives in memory, so a DB reset cannot
   clear it and a burned account stays 429 for the life of the server
   process. It now uses three accounts (`seyi`, `blessing`, `ibrahim`) that no
   other suite ever signs in as.
3. **The global 300 req/min limiter is per IP**, and all thirteen suites share
   one. A full run exhausted it partway through, so a *different* suite went
   red on each run — always on assertions expecting 401/403 but getting 429.
   Run the server with `RATE_LIMIT_GLOBAL_PER_MIN=100000`; every other control
   stays at production values, which is why `bruteforce.mjs` still passes.

With all three fixed, three consecutive full runs are green with no database
reset between them.

## Phase 8 — admin & moderation

### `tmp/phase8.mjs` — roles, queue, actions, audit (99 assertions)

Role gating first: a plain user gets **404, not 403**, on every admin route, and
the error body carries no hint that the surface exists. A moderator is refused
the audit log, bans and role changes; an admin is not.

The queue is asserted end to end — a real report filed by one fixture user about
another appears with its reporter, its subject, its reason and its **evidence
snapshot**, ordered by priority descending. Moving it to `reviewing` removes it
from the open queue; a takedown soft-deletes the content (`deleted_by` records
the acting moderator) while the row survives so the report stays reviewable, and
the public API 404s the removed post immediately.

Escalation defences get their own block: a moderator cannot suspend an admin
(403), nobody can action themselves (400 — a self-ban would lock the last admin
out), no admin can grant a role at their own level (403), and a moderator cannot
lift a ban an admin issued (403).

The audit assertions check not just that rows exist but that they carry the
actor, target, stated reason, IP and time, that the log filters by action and
actor, and — importantly — that a **rejected** action writes no row at all.

### `tmp/phase8-ui.mjs` — the dashboard, in a real browser (44 assertions)

Renders for a moderator; a plain user gets the denial card with no queue or
analytics text anywhere in the DOM. The admin-only Audit tab is asserted
**not visible** to a moderator and visible to an admin, and the Ban button is
absent from the account modal for a moderator and present for an admin. Actions
are driven by real clicks and then confirmed **in the database**, not in the UI
that issued them. Analytics is checked against a live `COUNT(*)`. At 390px the
suite asserts zero horizontal overflow and screenshots both breakpoints.

### The bug only the browser could catch

Every backend assertion passed while the suspend dialog was quietly broken.
`openModal` detaches its panel *before* resolving, so reading `#suspend-days`
and `#suspend-reason` after awaiting it queried a dead DOM — every suspension
posted the **7-day default with a null reason** regardless of what the moderator
chose. Nothing errored; the toast said success; the audit row was written with a
blank detail. The suite now asserts the stored `DATEDIFF`, not only the reason,
so the duration half of the bug cannot come back unnoticed.

### Mutation test

To prove the suite is not just agreeing with itself, the role gate was disabled
(`if (false && ...)`) and the suite re-run: **8 assertions went red**. Notably
`moderator cannot ban` still passed — the service-level rank check caught it
with the route gate off, which is the defence-in-depth working as intended.

### Ban enforcement

The probe that started this phase is preserved as assertions: a suspended user's
**existing session** is rejected (403) on `/api/auth/me` and on writes, and they
cannot sign in again. Before the fix, a banned account could still send messages
and like profiles with the cookie it already held.

## Phase 10 — account lifecycle (`tmp/phase10.mjs`, 59 assertions)

Phase 10 began as a coverage audit rather than a writing exercise. Grepping the
15 existing suites for each flow the V1 spec names turned up five that **no
test touched at all**, despite all five being shipped, working code:

| Flow | Route | Was covered? |
|---|---|---|
| Logout | `POST /api/auth/logout` | no |
| Password recovery | `POST /api/auth/forgot-password`, `/reset-password` | no |
| Email verification | `POST /api/users/me/verify/{start,confirm}` | no |
| Phone verification | same, `kind: 'phone'` | no |
| Username changes | `PATCH /api/users/me/username` | no |

Everything else the spec lists (matching, chat, moments, posts, safety,
notifications, admin, E2EE, TTLs) already had a suite, so Phase 10 targets the
gap instead of duplicating ~4,300 lines of existing coverage.

### Fixture safety

Every one of these flows mutates a credential, a handle or a verification tier.
Run against the seed users they would corrupt the shared fixture for all 16
suites — a changed password breaks every later login, a changed username breaks
the search assertions. The suite therefore **registers its own throwaway users**
(prefix `p10`, epoch-suffixed so a re-run cannot collide with rows left behind
by a crashed one) and deletes them at the end. It asserts `COUNT(*) = 12` on
exit to prove the seed fixture is untouched.

### What the assertions actually check

Not just happy paths — the security properties underneath them:

- **Logout** revokes server-side. The old cookie jar is *replayed* after logout;
  if logout only cleared the browser's cookies, `/api/auth/refresh` would still
  succeed. It must 401.
- **Recovery does not leak account existence.** Known and unknown addresses must
  return byte-identical messages, and no token may be minted for an unknown one.
- **Reset tokens are single-use and supersedable.** Issuing a new token kills the
  previous one; a consumed token cannot be replayed; a forged token is refused.
- **Verification codes** are 6 digits, wrong codes are refused, a used code
  cannot be reused, and the tiers are independent — verifying a phone must not
  light up the email tier.
- **Phone verification is international.** A `+44` number is accepted and stored
  verbatim, guarding the spec's "no Nigeria-only hard-coding" requirement.
- **Username changes** enforce reserved words, format, case-insensitive
  duplicates, the 30-day cooldown (with a machine-readable `USERNAME_COOLDOWN`
  code and `daysRemaining`), anti-impersonation parking of the released handle
  in `username_history`, and the original owner's right to reclaim it. Identity
  is proven to follow the rename: the new `/@handle` resolves, the old one 404s,
  and search finds the user under the new handle.

### A real vulnerability this suite caught

The assertion *"the pre-reset session was invalidated by the password change"*
failed against shipped code, and it was not a test bug.

`consumePasswordReset` calls `revokeAllUserTokens`, which updates
`refresh_tokens`. But **access tokens are stateless JWTs** — `requireAuth`
verifies the signature and loads the user, never consulting that table. So after
a password reset the attacker's existing access token kept working for the rest
of its 15-minute TTL: precisely the window a compromised-account reset exists to
close.

Fixed with a token epoch: `users.sessions_valid_from` is stamped on password
change, and `assertTokenNotStale` rejects any access token whose `iat` predates
it. The check rides the `assertNotSanctioned` hook that already runs in
`requireAuth`, `optionalAuth` **and** `socketAuth`, so it costs no extra query
and covers the socket handshake too. The epoch is set to `NOW() + 1 SECOND`
because JWT `iat` has one-second resolution — without the guard, a token minted
in the same second as the reset would satisfy `iat >= epoch` and survive.

**Mutation test:** disabling the check (`if (false) assertTokenNotStale(...)`)
turns that assertion red and restoring it turns it green, so the test genuinely
detects the vulnerability rather than agreeing with the implementation.

### Rate limits

`passwordResetLimiter` is 5 per 15 minutes per IP, in-memory, so exercising
recovery twice inside one window returns 429 and the failure *looks* like a
broken reset flow. Rather than weaken the control, it gained the same narrow
override the global ceiling has: `RATE_LIMIT_RESET_PER_15MIN`, used only by the
test runner. **The default is unchanged and was re-verified to bite at request
6.** The controls that actually protect recovery — single-use hashed tokens,
expiry, supersession, session revocation — are unconditional.

Run it with:

```bash
RATE_LIMIT_GLOBAL_PER_MIN=100000 RATE_LIMIT_RESET_PER_15MIN=1000 npm start
node tmp/phase10.mjs
```

---

## `tmp/p10-blockcheck.mjs` — block filters after the query rewrite (16 checks)

Added when the deck's block filter was rewritten from a single `NOT EXISTS` with
an `OR` into two `NOT EXISTS` clauses (~4x faster). That clause is a *safety*
control, and the same pattern appears ten times across four services, so a
faster query that leaked a blocked user would be a regression rather than an
optimisation. The suite blocks a user and asserts they disappear from nearby
discovery, top picks, the deck, likes-you and visitors, then checks the reverse
direction (the blocked user must not see the blocker either), then unblocks and
confirms the fixture is restored.

Three test bugs before it went green, all of them the usual tell — an invented
response shape:

- Posted `{userId}`; the schema wants `{blockedId}`. The 403 meant no block was
  ever created, so the "hidden after block" assertions were passing vacuously.
- Hand-rolled a `GET /api/auth/csrf` call. There is no such route: CSRF is
  double-submit, the `ec_csrf` cookie from login echoed in `x-csrf-token`.
- Unwrapped the deck response as `j.results`; the key is `j.deck`, so the deck
  read as empty and its assertions were vacuous too.

A fourth was a real API contract, not a bug: `/api/users/deck?limit=50` returns
400, because the deck caps `limit` at 30.

The final version asserts its own preconditions — that the target *was* visible
before the block — so a vacuous pass fails loudly instead of printing `ok`.

## `tmp/p10-nearbypage.mjs` — keyset pagination correctness (API)

Paging bugs are invisible to a single request: one page always looks right.
This suite walks the whole People Nearby list **two rows at a time** and
compares the union against one big page.

- paged walk equals the single-page result, in order
- no duplicates across pages
- no `nextCursor` when a page is short of `limit`
- a half-specified cursor (`cursorId` with no `cursorDistanceKm`) is ignored,
  not guessed at
- non-numeric and negative cursors are rejected `400` by validation

This caught a real `ER_BAD_FIELD_ERROR`: the keyset predicate referenced
`ul.lat` inside `HAVING`, where only select aliases are in scope.

## `tmp/p10-nearbyscroll.mjs` — infinite scroll (browser)

curl cannot see an `IntersectionObserver`. This drives the real page at a
390×780 viewport, rewriting the request to `limit=2` so the seed fixture is
enough to force several pages.

- the scroll walks the **complete** list for the page's radius (compared against
  a full-size API call — the route override is removed first, or the ground
  truth gets truncated too)
- no duplicate cards
- follow-up requests carry a cursor, and none still send `offset`
- the sentinel hides once the list is exhausted
- the header count is neither stale-zero nor out of step with the grid

The last two assertions exist because the first green run was still wrong: a
screenshot showed **"0 people within 150 km"** above a full grid, since each
appended page overwrote the header with its own page count. Green assertions
are not a substitute for looking at the page.

The two `401`s from `/api/auth/me` and `/api/auth/refresh` on the login page are
the app probing for an absent session, and are filtered out deliberately.

## `tmp/p10-momentsfeed.mjs` — feed windowing

Inserts 130 live moments (over the server's 100 cap) and checks the tray keeps
the **newest** ones.

- the newest moment is present (it was dropped before the fix)
- the oldest is the one the cap discards
- rails still play back oldest-first
- the cap holds, with no duplicates
- the fixture is deleted afterwards, leaving the shared DB pristine

Verified as a real guard by running it against the pre-fix file: it fails two
assertions on the old code and passes on the new.

## `tmp/p10-srcset.mjs` — photo renditions (API)

Uploads a real 2000px image and follows both renditions end to end.

- the API returns a `thumbUrl` distinct from `url`
- the original is capped at 1600px, the thumb is exactly 400px
- **a blocked viewer gets 404 on the thumb, not just the original** — the
  rendition must not become a second, unguarded URL for personal media
- deleting the photo removes both files, leaving no orphan

## `tmp/p10-srcsetui.mjs` — `srcset` selection (browser)

Uploads a photo, loads the profile grid at 390px, and asserts on
`img.currentSrc`, which is the authoritative record of the candidate the
browser chose.

- the tile carries a `400w` candidate and a `sizes` attribute
- the browser selects the 400w file and does **not** download the 1600px one

`naturalWidth` is deliberately not asserted: inside an `object-cover` grid tile
it reports a layout-derived value (175 at this viewport), not the file's
intrinsic width, which made an early version of this test fail against a
correct 400×400 file.

## `tmp/p10-nav.mjs` — navigation, the Matches/Chats split, badges (browser)

42 assertions. Covers the item 21 nav rework, which no earlier suite touched:
before this, the only nav assertions anywhere were two `[data-nav]` presence
checks in `phase6-ui` and `phase8-ui`.

- **Tab bar.** On all seven signed-in pages, the five tabs are Discover /
  Matches / Moments / Chats / Profile, in that order, pointing at `/app`,
  `/matches`, `/moments`, `/chats`, `/profile`. Labels are read from the tab's
  own text nodes — the first version of this test read `textContent` and
  failed against the badge counter nested inside the link.
- **Active tab.** `/chats` marks exactly one tab, and `/chat?c=1` marks none of
  them — a prefix match would have wrongly highlighted Chats inside a
  conversation.
- **Likes stays reachable.** Likes lost its tab, so the suite asserts the
  mobile header link exists and is visible at 390px. Without it the page would
  have been orphaned on phones.
- **The split is real.** Ground truth comes from `api.matches()`, not from the
  DOM: Chats must list exactly the conversations with a `lastMessage`, Matches
  must show exactly those without one in its "new matches" rail, and the two
  sets must not intersect. It also re-asserts `smoke-browser`'s expectation
  that `/matches` still links into `/chat?c=`.
- **Badge visibility.** Asserts `getComputedStyle().display`, not the `hidden`
  attribute, because the bug being guarded was precisely that the attribute
  said "visible" while the class said `display:none`. Also checks the zero
  state re-hides and sets `aria-hidden`, and that a 99+ count does not overflow
  its tab.
- **Mobile pass.** At 390/360/820px: the bottom nav is visible and inside the
  viewport, tap targets are ≥44px tall, and no page overflows horizontally.
- Screenshots to `tmp/p10-nav-chats.png` and `tmp/p10-nav-matches.png`.

**Three real bugs caught.**

1. **Unread badges had never been visible.** `setBadge` toggled the `hidden`
   property, but the markup ships Tailwind's `.hidden` class, which wins on
   specificity — every badge stayed `display:none` regardless of count. Now
   toggles class, property and `aria-hidden` together.
2. **Two unhandled rejections in `settings-page.js`.** `paintVerification` and
   the top-level boot both awaited fetches with no catch, so navigating away
   mid-load threw `TypeError: Failed to fetch` as a `pageerror` — a red console
   error in a real user's browser. Both now swallow aborts and toast only
   genuine failures. The suite's "no console errors" assertion is what exposed
   these; they were invisible to every other suite because no other suite
   navigates away from `/settings` while it is still loading.
3. **Matches duplicated Chats** (caught by reading the screenshot, not by an
   assertion — all 42 were green at the time). The seed fixture has no
   unmessaged matches, so the page rendered the same two conversation rows
   under a "Recent chats" heading, making the new tab pointless. Matches now
   renders a tile grid of the whole roster, visually distinct from the thread
   list. A duplicate heart icon on the adjacent Discover and Matches tabs was
   fixed in the same pass (Discover took a flame).

## `tmp/p10-i18n.mjs` — internationalisation readiness (node + browser)

63 assertions across the four spec points: string catalogue, intl phone,
timezone handling, no region hard-coding.

- **Timezone (the important one).** Asserts the app's own pool reports
  `@@session.time_zone = '+00:00'` and that `NOW() = UTC_TIMESTAMP()`, then
  **mutation-tests the guard**: a deliberately unpinned connection at `-08:00`
  must show a "24 hour" TTL landing 16 hours out. If that mutation ever stops
  skewing, the pin above is proving nothing and the suite says so.
- **Schema.** `users.timezone` / `users.locale` exist and are nullable,
  `country` is ISO-2, `languages` holds JSON. Engine-portable: MySQL 8 reports
  type `json`, MariaDB implements it as `longtext` + a `json_valid` CHECK, so
  the assertion accepts either.
- **Phone.** 8 international formats accepted (NG, US, GB, BR, CN, AU, plus
  spaced and punctuated variants), 5 malformed rejected.
- **Validation.** 5 IANA zones accepted, `Mars/Olympus` rejected; `pt-br`
  canonicalises to `pt-BR`; `!!!` rejected.
- **Round trip.** `PATCH /api/users/me` → DB row → `GET /api/auth/me`, plus a
  privacy check that the **public** profile never exposes the zone, plus a 400
  on an invalid zone.
- **Catalogue.** Key resolution, `{n}` interpolation, missing-key fallback to
  the key (never blank), and locale negotiation `en-GB → en`, `xx-YY → en`.
- **Formatting.** One UTC instant rendered in Kiritimati (UTC+14), Los Angeles
  (UTC-7) and Lagos must differ, and the date must roll over between them;
  "Today" must stay "Today" in every zone for a just-now message.
- Screenshot to `tmp/p10-i18n-chats.png`; restores `timezone`/`locale` to NULL
  on exit and asserts the fixture is clean.

**Two gotchas this suite encodes.** `nav.tabbar` is `lg:hidden`, so it is *not*
visible at desktop widths — assert on page content, not the mobile chrome. And
Chromium logs a failed fetch as the generic "Failed to load resource", so the
login page's benign `/api/auth/me` + `/api/auth/refresh` 401 probes can only be
filtered via `consoleMessage.location().url`, which carries the request URL.

## `tmp/p10-sweep.mjs` — final cross-device sweep (browser)

98 assertions. Not feature tests: a cross-cutting check that every primary
surface survives every target device after all of phases 1-10 have landed.

- 8 pages (`/app`, `/matches`, `/chats`, `/moments`, `/nearby`, `/likes`,
  `/profile`, `/settings`) x 5 viewports: iPhone SE (375), iPhone 14 (390),
  Android small (360), iPad (820), desktop (1280).
- Per page: content actually renders inside `<main>`, and
  `scrollWidth <= clientWidth` (no horizontal overflow).
- Mobile (<1024px): the tab bar has exactly 5 tabs, every tap target is
  >=44px tall, and none sit below the fold.
- Desktop: the sidebar is present with >=8 links (`nav.tabbar` is `lg:hidden`).
- Zero console/page errors per device, filtering only the login page's benign
  `/api/auth/me` + `/api/auth/refresh` 401 session probes.
- Screenshots to `tmp/p10-sweep-<device>.png`.

**This suite found two real bugs on `/profile`** that 24 green suites had
missed: no `<main>` landmark (the only such page of 9, breaking the skip link)
and a stale 3-tab nav left over from before the item-21 rename. Asserting
`<main>` content length is what surfaced the first; counting `nav.tabbar a`
surfaced the second.

### Deploy checks (run manually, not in the runner)

- **Schema drift:** build a scratch DB from `db/schema.sql` alone
  (`DB_NAME=schema_check node db/migrate.js`) and diff
  `information_schema.columns` against the live DB. Must be empty — this is
  what catches a column added by hand with `ALTER TABLE` but never written
  back to the canonical schema.
- **Cold rebuild:** `timeout 200 node db/migrate.js --fresh && node db/seed.js`
  then the full runner. Expect the cleanup job to delete exactly 1 message on
  boot: the seed plants one already-expired message on purpose.

## `tmp/p10-secretlog.mjs` — credentials must never reach the logs

23 assertions, three layers.

- **Redactor unit tests.** Secret-named keys (`code`, `token`, `link`, …) blank
  at top level and nested; `?token=` is stripped from a URL even under a
  *non-secret* key name; non-secret fields survive untouched; circular objects
  don't throw.
- **Live server.** Boots a real server on :3111, drives `forgot-password` and
  `verify/start`, and asserts the returned token/code — and the user's email —
  never appear in the captured stdout, while the audit lines themselves
  (`userId`, `kind`) still do.
- **Call-site hygiene (static).** Greps the two controllers to confirm the log
  calls pass no secret. This is the assertion that matters most: the runtime
  check above is satisfied by the redactor alone, so without this a developer
  could reintroduce the leak at the call site and stay green.

**Mutation-tested three ways.** Reinstating the leak under a misnamed key stays
green (proving the net works); disabling the redactor fails; passing `code`
back to the logger fails the static check. Note the middle mutation is what
exposed the pre-existing `JSON.stringify` crash-on-cycle bug.

**Regex scoping gotcha.** Matching the whole `logger.info(...)` call fails
spuriously because the *message string* `'[verify] code issued'` contains the
word "code". Capture only the meta object literal.

## tmp/p11-linkaudit.mjs

Static link audit — no browser, no DB, runs in ~200 ms. It exists because a
broken deep link is **three independent failures**, and a green UI suite can
miss all three:

1. **the route must exist** — every `href` in `public/*.html`, every
   runtime-built link in `public/js/*.js` (`location.href|assign|replace`,
   `href:`, `href="…"`), and every notification `href:` in
   `server/src/services/*.js` is resolved against the real `PAGES` list in
   `server/server.js`.
2. **the anchor id must be rendered** — `id="post-${…}"` and
   `id="comment-${…}"` must actually appear in `posts.js`.
3. **something must handle the hash** — both `posts.js` and `moments.js` must
   read `location.hash`, register a `hashchange` listener, and run the handler
   *after* the async feed resolves.

It also proves every `api.<method>()` called anywhere in `public/js` exists in
`public/js/api.js`, which is how the invented `api.commentContext` was caught
before it shipped.

**Parser gotcha.** `PAGES` in `server.js` is an **array of page names**
(`['app','matches',…]` → `/app`, `/matches`), *not* an object keyed by path.
The first version of this audit assumed an object map, found zero routes, and
reported ~200 false dead links. Read the source before writing the matcher.

**Mutation-tested** (all three go red, then were reverted):
reinstating `href: '/posts#post-…'` → 2 failures; deleting the `hashchange`
listener → 1 failure; deleting `id="comment-${c.id}"` → 1 failure.

## tmp/p11-deeplink.mjs

Browser suite (27 checks) driving the real notification journey: log in, create
a post, a comment and a moment over the API, then follow each deep link and
assert the target is present, visible, scrolled into view and highlighted.

Covers `GET /api/comments/:id/context` (200, correct `postId`, 404 for a
missing comment), the auto-opening of a collapsed comment thread, the moment
viewer opening from `#moment-<id>`, graceful handling of stale links to expired
content, and the no-hash regression (plain `/moments` must still open at the
top).

**Same-document navigation.** Two checks flip the hash with
`window.location.hash = …` while already on `/moments`. That is exactly what
clicking a *second* notification does, and it does not re-run the page module —
the bug that made the `hashchange` listener necessary.

**CSP gotcha.** `page.waitForFunction` evaluates a string and dies under
`script-src 'self'`. Wait on `#viewer:not(.hidden)` with a locator instead.

## tmp/p11-errorsweep.mjs

Full-folder error sweep over the eight pages `p10-sweep` never visited: `/`,
`/login`, `/register`, `/chat`, `/call`, `/admin`, `/@username` and a 404 URL,
logged out, logged in, and as an admin, at mobile and desktop widths. Fails on
any uncaught exception, console error, or failed request. 401s on the logged-out
pages, preload warnings and favicon misses are filtered as expected noise --
the filter is mutation-tested by injecting a real `TypeError` into
`likes-page.js` and confirming the suite goes red with that exact message.
Promotes roles for the admin leg and restores them in a `finally`. 51 checks.

**Count your matches.** `[id$="-tab"]` matched exactly one of the four admin
tabs and passed happily. The admin tabs are `[data-admin-tab]`, and the suite
now asserts `tabs.length === 4` so a selector that silently under-matches fails.

## tmp/p11-mediacleanup.mjs

Proves deleted media actually leaves the disk, not just the database. Uploads a
real photo as ngozi, asserts the original lands in `uploads/photos/` and the
400px rendition in `uploads/thumbs/` (explicitly asserting the thumb is *not*
in `photos/` -- that mismatch was the bug), deletes it, then asserts both files
are gone, the directory counts are back to their starting values, and both URLs
return 404. 13 checks.

**Why 404 was not enough.** `getPhotoForViewer` resolves a basename back to its
owning `user_photos` row, so an orphaned file already 404s. The API looked
correct from the outside while leaking a file per deletion. Assert against the
filesystem, not only the response.

**Stale server, false red.** This suite failed inside `regress-all` while
passing standalone, because a mutation test had been reverted in the source but
the running server still held the old module in memory. `start_process` must be
restarted after every server-side edit -- the suite was right, the process was
stale.

## tmp/p11-unblock.mjs

Browser suite (14 checks) covering the blocked-people list in Settings and the
unblock round trip. Signs in as ngozi, blocks chidi_dev over the API, then works
entirely through the rendered page: the row appears with avatar, display name
and `@username`, the button carries an `Unblock <name>` accessible label, the
confirmation dialog appears, **Cancel** leaves the block intact, and confirming
removes the row and swaps in the empty state.

The important assertions are the ones after the row disappears. A list that
merely stops rendering someone is indistinguishable from a real unblock, so the
suite re-queries the server: `GET /api/users/blocks` no longer lists them, they
are findable again in username search, and `GET /api/users/:id` returns 200
instead of the 404 a block produces. It also asserts a second `DELETE` returns
404 rather than throwing, and that the confirmation copy does **not** promise
the old match or chat comes back -- blocking unmatches permanently, and the
dialog must not imply otherwise.

A `finally` block always unblocks, so a mid-run failure cannot leave the seed
data dirty for the next suite.

**Two invented facts, caught by running it.** The first draft targeted user 4 as
`emeka` (user 4 is `chidi_dev`) and called `GET /api/users/:id/profile`, a route
that does not exist -- the real one is `GET /api/users/:id`. Both surfaced as
red on the first run. A test failure is not proof of an app bug; probe first.

**A mutation that landed in the wrong function.** Stubbing out `confirmDialog`
appeared to leave the suite green, suggesting vacuous assertions. The regex had
matched the *first* `confirmDialog` in `settings-page.js` (the erase-location
handler) rather than the unblock one further down. Re-anchored on the unique
``title: `Unblock ${name}?` ``, the mutant was caught immediately. When a
mutation test says a guard is dead, confirm the mutation actually hit the guard.

## tmp/p11-mysql8params.mjs

34 checks. Guards the MySQL 8.0.22+ prepared-statement regression: mysql2 sends
JS numbers as DOUBLE, and MySQL refuses to convert a double where `LIMIT` wants
an integer, so every feed 500s. **MariaDB coerces silently, so it cannot
reproduce the failure** — asserting on query results here would prove nothing.

The suite therefore spies on the driver itself, patching `execute` on both
`PromisePool` and `PromisePoolConnection`, and asserts on the parameter *types*
actually handed to mysql2: no integer may arrive as a JS number via `query()`,
`execute()`, a transaction connection, the post feed or the deck, while a float
bound alongside an integer must stay a number. Unit checks pin the coercion
rules (safe integers and bigint convert; floats, `null`, `Date`, `Buffer`,
booleans, unsafe integers and `NaN` do not; the caller's array is never
mutated). SQL checks confirm the strings still behave as integers — `LIMIT 0/1/3`
row counts, `WHERE id = ?`, `IN (?,?,?)`, arithmetic, float precision.

Mutation-tested four ways: coercion disabled, floats over-coerced, transaction
proxy removed, `query()` bypassing coercion. All caught — and the transaction
mutant is caught *only* by the type assertions.

## tmp/p11-composer.mjs

6 browser checks. The same bug report showed a saved post (`POST` → 201) being
reported as a failure because the follow-up feed `GET` 500'd. Logs in as amara,
opens the real "New post" composer on `/moments`, lets the write through and
forces every feed `GET` to 500, then asserts the post was genuinely written, no
toast claims it failed, and — the load-bearing check — the confirmation appears
*before* any feed complaint. `load()` swallows its own errors, so the fix
changes toast ordering rather than reachability; the suite is mutation-tested
against the original single-`try` shape, which it catches.
