-- ============================================================
--  Ephemeral Chat - MySQL 8 schema
--  Collation: utf8mb4_0900_ai_ci
--  All FKs cascade so unmatching / deleting a user wipes content.
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS message_locations;
DROP TABLE IF EXISTS profile_prompts;
DROP TABLE IF EXISTS user_interests;
DROP TABLE IF EXISTS interests;
DROP TABLE IF EXISTS encounters;
DROP TABLE IF EXISTS profile_views;
DROP TABLE IF EXISTS favorites;
DROP TABLE IF EXISTS taps;
DROP TABLE IF EXISTS boosts;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS user_locations;
DROP TABLE IF EXISTS user_settings;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS call_logs;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS matches;
DROP TABLE IF EXISTS swipes;
DROP TABLE IF EXISTS user_photos;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
CREATE TABLE users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(190) NOT NULL,
  username      VARCHAR(30)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(60)  NOT NULL,
  birthdate     DATE NULL,
  gender        ENUM('male','female','other') NULL,
  interested_in ENUM('male','female','everyone') NOT NULL DEFAULT 'everyone',
  bio           VARCHAR(500) NULL,
  city          VARCHAR(80)  NULL,
  avatar_url    VARCHAR(255) NULL,
  -- What they are here for. Mirrors Tinder's "relationship goals" / Badoo "intentions".
  intent        ENUM('long_term','short_term','friends','figuring_out') NULL,
  job_title     VARCHAR(80)  NULL,
  school        VARCHAR(80)  NULL,
  -- V1 profile depth. Stored as short comma-free JSON arrays so the shape is
  -- self-describing; neither is ever filtered on, so no index is warranted.
  languages     JSON NULL,
  hobbies       JSON NULL,
  country       VARCHAR(2)   NULL,          -- ISO 3166-1 alpha-2, international-ready
  -- i18n. Both are hints for RENDERING only: every timestamp is stored and
  -- compared in UTC (the pool pins each connection to '+00:00'), and the client
  -- falls back to the browser's own locale/zone when these are NULL. Kept as
  -- free text rather than an ENUM so a new region needs no migration.
  timezone      VARCHAR(64)  NULL,          -- IANA tz name, e.g. 'Africa/Lagos', 'America/Sao_Paulo'
  locale        VARCHAR(10)  NULL,          -- BCP-47 tag, e.g. 'en', 'en-GB', 'pt-BR'
  height_cm     SMALLINT UNSIGNED NULL,
  -- Trust: set once a selfie challenge is approved.
  is_verified   TINYINT(1) NOT NULL DEFAULT 0,
  verified_at   DATETIME NULL,
  -- Verification tiers. Each is independent; none of them is a safety promise.
  email_verified_at DATETIME NULL,
  phone         VARCHAR(24) NULL,          -- E.164, international by design
  phone_verified_at DATETIME NULL,
  -- Cached 0-100 completion score, recomputed whenever the profile is written.
  profile_completion TINYINT UNSIGNED NOT NULL DEFAULT 0,
  -- Moderation. `role` gates the admin surface; `status` gates sign-in.
  role          ENUM('user','moderator','admin') NOT NULL DEFAULT 'user',
  status        ENUM('active','suspended','banned') NOT NULL DEFAULT 'active',
  suspended_until DATETIME NULL,
  status_reason VARCHAR(255) NULL,
  username_changed_at DATETIME NULL,
  -- Everything issued before this instant is refused. Access tokens are
  -- stateless JWTs, so revoking refresh-token rows alone left a valid access
  -- token working for its full 15-minute TTL after a password reset -- exactly
  -- the window a reset is meant to close. Bumping this invalidates every live
  -- session for the user at once, with no per-request token lookup.
  sessions_valid_from DATETIME NULL,
  last_seen_at  DATETIME NULL,
  is_online     TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_users_email (email),
  UNIQUE KEY uniq_users_username (username),
  UNIQUE KEY uniq_users_phone (phone),
  KEY idx_users_online (is_online),
  KEY idx_users_city (city),
  KEY idx_users_verified (is_verified),
  KEY idx_users_status (status),
  KEY idx_users_role (role),
  KEY idx_users_created (created_at),
  -- Display-name search used `LIKE '%term%'`, which cannot use a BTREE index
  -- (the leading wildcard defeats it) and degraded into a full table scan --
  -- measured at 50,013 rows examined to return 10. FULLTEXT makes the
  -- display-name half indexable; the username half still uses the unique
  -- index above via an anchored prefix match.
  -- Supports the deck/discovery ORDER BY tail (is_online, last_seen_at, id).
  -- Presence columns are written on every connect/disconnect; the added
  -- write cost measured as ~1% against a ~4% read gain on 50k rows.
  KEY idx_users_deck_rank (is_online, last_seen_at, id),
  FULLTEXT KEY ft_users_display_name (display_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- refresh_tokens  (rotating refresh token store, jti allow-list)
-- ------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  jti        CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_rt_jti (jti),
  KEY idx_rt_user (user_id),
  KEY idx_rt_expires (expires_at),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- user_photos  (up to 6 profile photos for the card deck)
-- ------------------------------------------------------------
CREATE TABLE user_photos (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  url        VARCHAR(255) NOT NULL,
  -- 400px rendition. Always generated on upload; persisting it lets grids and
  -- avatars fetch ~400px instead of the 1600px original via srcset.
  thumb_url  VARCHAR(255) NULL,
  position   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_photos_user_pos (user_id, position),
  CONSTRAINT fk_photos_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- swipes
-- ------------------------------------------------------------
CREATE TABLE swipes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  swiper_id  BIGINT UNSIGNED NOT NULL,
  swipee_id  BIGINT UNSIGNED NOT NULL,
  direction  ENUM('like','pass','superlike') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_swipe (swiper_id, swipee_id),
  KEY idx_swipe_swipee (swipee_id, direction),
  CONSTRAINT fk_swipe_swiper FOREIGN KEY (swiper_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_swipe_swipee FOREIGN KEY (swipee_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- matches  (always stored with user_a_id < user_b_id)
-- ------------------------------------------------------------
CREATE TABLE matches (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_a_id  BIGINT UNSIGNED NOT NULL,
  user_b_id  BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_match (user_a_id, user_b_id),
  KEY idx_match_b (user_b_id),
  CONSTRAINT fk_match_a FOREIGN KEY (user_a_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_match_b FOREIGN KEY (user_b_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_match_order CHECK (user_a_id < user_b_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- conversations
-- ------------------------------------------------------------
CREATE TABLE conversations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  match_id        BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_message_at DATETIME NULL,
  -- Custom disappearing timer for THIS conversation. Applies to new messages
  -- only; changing it never retroactively extends the life of old ones.
  ttl_hours       SMALLINT UNSIGNED NOT NULL DEFAULT 24,
  ttl_set_by      BIGINT UNSIGNED NULL,
  ttl_set_at      DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_conv_match (match_id),
  KEY idx_conv_last_message (last_message_at),
  CONSTRAINT fk_conv_match FOREIGN KEY (match_id) REFERENCES matches (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- messages   (expires_at = created_at + MESSAGE_TTL_HOURS, set in app layer)
-- ------------------------------------------------------------
CREATE TABLE messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_id       BIGINT UNSIGNED NOT NULL,
  body            TEXT NULL,          -- plaintext: system messages + legacy only
  -- End-to-end encrypted payload. When `is_encrypted` is 1 the server holds
  -- ciphertext it cannot read; `body` stays NULL.
  ciphertext      MEDIUMTEXT NULL,
  iv              VARCHAR(32) NULL,
  sender_key_id   VARCHAR(64) NULL,
  is_encrypted    TINYINT(1) NOT NULL DEFAULT 0,
  type            ENUM('text','image','video','location','system') NOT NULL DEFAULT 'text',
  client_uuid     CHAR(36) NULL,
  read_at         DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_conv_created (conversation_id, created_at),
  KEY idx_expires (expires_at),
  KEY idx_msg_sender (sender_id),
  UNIQUE KEY uniq_msg_client_uuid (conversation_id, client_uuid),
  CONSTRAINT fk_msg_conv FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_msg_sender FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- attachments  (same 24h TTL as their parent message)
-- ------------------------------------------------------------
CREATE TABLE attachments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id    BIGINT UNSIGNED NULL,
  kind          ENUM('image','video') NOT NULL,
  file_path     VARCHAR(255) NOT NULL,
  thumb_path    VARCHAR(255) NULL,
  mime          VARCHAR(100) NOT NULL,
  size_bytes    INT UNSIGNED NOT NULL,
  width         INT NULL,
  height        INT NULL,
  duration_secs INT NULL,
  owner_id      BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_att_message (message_id),
  KEY idx_expires (expires_at),
  KEY idx_att_owner (owner_id),
  CONSTRAINT fk_att_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_att_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- call_logs   (metadata only - NOT subject to the 24h purge)
-- ------------------------------------------------------------
CREATE TABLE call_logs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  caller_id       BIGINT UNSIGNED NOT NULL,
  callee_id       BIGINT UNSIGNED NOT NULL,
  status          ENUM('missed','declined','completed','failed') NOT NULL,
  started_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at        DATETIME NULL,
  duration_secs   INT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY idx_call_conv (conversation_id, started_at),
  KEY idx_call_caller (caller_id),
  KEY idx_call_callee (callee_id),
  CONSTRAINT fk_call_conv FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_call_caller FOREIGN KEY (caller_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_call_callee FOREIGN KEY (callee_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- blocks
-- ------------------------------------------------------------
CREATE TABLE blocks (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  blocker_id BIGINT UNSIGNED NOT NULL,
  blocked_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_block (blocker_id, blocked_id),
  KEY idx_block_blocked (blocked_id),
  CONSTRAINT fk_block_blocker FOREIGN KEY (blocker_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_block_blocked FOREIGN KEY (blocked_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- reports
-- ------------------------------------------------------------
CREATE TABLE reports (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reporter_id BIGINT UNSIGNED NOT NULL,
  reported_id BIGINT UNSIGNED NOT NULL,
  reason      VARCHAR(255) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_report_reported (reported_id),
  CONSTRAINT fk_report_reporter FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_report_reported FOREIGN KEY (reported_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- user_settings  (discovery preferences + privacy switches)
-- ------------------------------------------------------------
CREATE TABLE user_settings (
  user_id          BIGINT UNSIGNED NOT NULL,
  -- Discovery filters
  min_age          TINYINT UNSIGNED NOT NULL DEFAULT 18,
  max_age          TINYINT UNSIGNED NOT NULL DEFAULT 55,
  max_distance_km  SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  verified_only    TINYINT(1) NOT NULL DEFAULT 0,
  online_only      TINYINT(1) NOT NULL DEFAULT 0,
  show_me_globally TINYINT(1) NOT NULL DEFAULT 1,
  -- Privacy
  incognito        TINYINT(1) NOT NULL DEFAULT 0,
  location_mode    ENUM('precise','approximate','hidden') NOT NULL DEFAULT 'approximate',
  show_distance    TINYINT(1) NOT NULL DEFAULT 1,
  show_online      TINYINT(1) NOT NULL DEFAULT 1,
  allow_bumped_into TINYINT(1) NOT NULL DEFAULT 1,
  -- Passport: when set, discovery pretends you are here instead.
  passport_lat     DECIMAL(9,6) NULL,
  passport_lng     DECIMAL(9,6) NULL,
  passport_label   VARCHAR(80) NULL,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_age_range CHECK (min_age <= max_age)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- user_locations  (one current position per user; opt-in)
--   lat/lng are stored as written by the app layer: exact for 'precise',
--   already snapped to a ~1.1km grid for 'approximate'. 'hidden' stores nothing.
-- ------------------------------------------------------------
CREATE TABLE user_locations (
  user_id     BIGINT UNSIGNED NOT NULL,
  lat         DECIMAL(9,6) NOT NULL,
  lng         DECIMAL(9,6) NOT NULL,
  accuracy_m  INT UNSIGNED NULL,
  -- Coarse cell key for cheap proximity pre-filtering (see geo.js).
  geohash     VARCHAR(12) NOT NULL,
  city        VARCHAR(80) NULL,
  source      ENUM('gps','manual','passport') NOT NULL DEFAULT 'gps',
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_loc_geohash (geohash),
  KEY idx_loc_updated (updated_at),
  CONSTRAINT fk_loc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- encounters  ("Bumped into") - two users physically near each other
--   Stored once per pair per day with user_a_id < user_b_id.
-- ------------------------------------------------------------
CREATE TABLE encounters (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_a_id   BIGINT UNSIGNED NOT NULL,
  user_b_id   BIGINT UNSIGNED NOT NULL,
  met_on      DATE NOT NULL,
  distance_m  INT UNSIGNED NOT NULL,
  place_label VARCHAR(80) NULL,
  times_met   INT UNSIGNED NOT NULL DEFAULT 1,
  last_met_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_encounter_day (user_a_id, user_b_id, met_on),
  KEY idx_enc_b (user_b_id, last_met_at),
  KEY idx_enc_recent (last_met_at),
  CONSTRAINT fk_enc_a FOREIGN KEY (user_a_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_enc_b FOREIGN KEY (user_b_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_enc_order CHECK (user_a_id < user_b_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- profile_views  ("Visitors")
-- ------------------------------------------------------------
CREATE TABLE profile_views (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  viewer_id   BIGINT UNSIGNED NOT NULL,
  viewed_id   BIGINT UNSIGNED NOT NULL,
  source      ENUM('deck','search','nearby','bumped','likes','visitors','favorites','direct') NOT NULL DEFAULT 'direct',
  view_count  INT UNSIGNED NOT NULL DEFAULT 1,
  first_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_view_pair (viewer_id, viewed_id),
  KEY idx_view_viewed (viewed_id, last_at),
  CONSTRAINT fk_view_viewer FOREIGN KEY (viewer_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_view_viewed FOREIGN KEY (viewed_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- favorites  (private bookmark list, Badoo-style)
-- ------------------------------------------------------------
CREATE TABLE favorites (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id    BIGINT UNSIGNED NOT NULL,
  target_id   BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_favorite (owner_id, target_id),
  KEY idx_fav_target (target_id),
  CONSTRAINT fk_fav_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fav_target FOREIGN KEY (target_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- taps  (lightweight nudge - Badoo "Crush" / Tinder "Tap")
-- ------------------------------------------------------------
CREATE TABLE taps (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sender_id   BIGINT UNSIGNED NOT NULL,
  target_id   BIGINT UNSIGNED NOT NULL,
  kind        ENUM('wave','crush','fire') NOT NULL DEFAULT 'wave',
  seen_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_tap (sender_id, target_id),
  KEY idx_tap_target (target_id, created_at),
  CONSTRAINT fk_tap_sender FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_tap_target FOREIGN KEY (target_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- boosts  (30 minutes at the top of the deck)
-- ------------------------------------------------------------
CREATE TABLE boosts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  started_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  views_gained INT UNSIGNED NOT NULL DEFAULT 0,
  likes_gained INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_boost_active (user_id, expires_at),
  CONSTRAINT fk_boost_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- verifications  (gesture-selfie photo verification)
-- ------------------------------------------------------------
CREATE TABLE verifications (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  gesture      VARCHAR(40) NOT NULL,
  file_path    VARCHAR(255) NOT NULL,
  status       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_at  DATETIME NULL,
  note         VARCHAR(255) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_verif_user (user_id, status),
  CONSTRAINT fk_verif_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- interests  (shared vocabulary - Tinder "Passions" / Badoo interests)
-- ------------------------------------------------------------
CREATE TABLE interests (
  id       SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug     VARCHAR(40) NOT NULL,
  label    VARCHAR(40) NOT NULL,
  emoji    VARCHAR(8)  NULL,
  category VARCHAR(30) NOT NULL DEFAULT 'general',
  PRIMARY KEY (id),
  UNIQUE KEY uniq_interest_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_interests (
  user_id     BIGINT UNSIGNED NOT NULL,
  interest_id SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, interest_id),
  KEY idx_ui_interest (interest_id),
  CONSTRAINT fk_ui_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ui_interest FOREIGN KEY (interest_id) REFERENCES interests (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- profile_prompts  (up to 3 Q&A cards)
-- ------------------------------------------------------------
CREATE TABLE profile_prompts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  prompt_key VARCHAR(40) NOT NULL,
  answer     VARCHAR(200) NOT NULL,
  position   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_prompt (user_id, prompt_key),
  KEY idx_prompt_user_pos (user_id, position),
  CONSTRAINT fk_prompt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- message_locations  (a place shared in chat; dies with its message)
--   live shares keep updating until live_until passes.
-- ------------------------------------------------------------
CREATE TABLE message_locations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id  BIGINT UNSIGNED NOT NULL,
  sender_id   BIGINT UNSIGNED NOT NULL,
  lat         DECIMAL(9,6) NOT NULL,
  lng         DECIMAL(9,6) NOT NULL,
  accuracy_m  INT UNSIGNED NULL,
  label       VARCHAR(120) NULL,
  is_live     TINYINT(1) NOT NULL DEFAULT 0,
  live_until  DATETIME NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_msgloc_message (message_id),
  KEY idx_msgloc_live (is_live, live_until),
  KEY idx_msgloc_expires (expires_at),
  CONSTRAINT fk_msgloc_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_msgloc_sender FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- V1 UPGRADE — social, safety, notifications, moderation, E2EE
--
-- Conventions used by every ephemeral table below:
--   * created_at + expires_at columns
--   * KEY idx_<table>_expires (expires_at)
--   * every read filters `expires_at > NOW()`
--   * registered in server/src/jobs/cleanup.js so rows AND files are purged
-- ============================================================

-- ------------------------------------------------------------
-- password_resets — single-use, short-lived recovery tokens.
-- Only the SHA-256 of the token is stored, so a DB read cannot
-- be replayed to take over an account.
-- ------------------------------------------------------------
CREATE TABLE password_resets (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  used_at    DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_reset_token (token_hash),
  KEY idx_reset_user (user_id),
  KEY idx_password_resets_expires (expires_at),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- verification_tokens — email + phone tier proofs (hashed codes).
-- ------------------------------------------------------------
CREATE TABLE verification_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  kind       ENUM('email','phone') NOT NULL,
  target     VARCHAR(190) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  attempts   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  used_at    DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_vtoken_user_kind (user_id, kind),
  KEY idx_verification_tokens_expires (expires_at),
  CONSTRAINT fk_vtoken_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- login_attempts — failed sign-in audit + per-account throttling.
-- ------------------------------------------------------------
CREATE TABLE login_attempts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email      VARCHAR(190) NOT NULL,
  ip         VARCHAR(64) NULL,
  ok         TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_login_email_time (email, created_at),
  KEY idx_login_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- username_history — anti-impersonation. Old handles stay claimed
-- for a cooling-off window so a freed name cannot be grabbed to
-- impersonate the person who just released it.
-- ------------------------------------------------------------
CREATE TABLE username_history (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  username   VARCHAR(30) NOT NULL,
  released_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimable_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_uhist_username (username, claimable_at),
  KEY idx_uhist_user (user_id),
  CONSTRAINT fk_uhist_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- user_devices — E2EE public keys. The server stores ONLY public
-- keys; private keys never leave the browser (IndexedDB).
-- ------------------------------------------------------------
CREATE TABLE user_devices (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  device_id   CHAR(36) NOT NULL,
  public_key  VARCHAR(255) NOT NULL,        -- base64 raw X25519/ECDH public key
  algorithm   VARCHAR(32) NOT NULL DEFAULT 'ECDH-P256',
  label       VARCHAR(80) NULL,
  last_used_at DATETIME NULL,
  revoked_at  DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_device (user_id, device_id),
  KEY idx_device_user (user_id, revoked_at),
  CONSTRAINT fk_device_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- conversation_keys — E2EE key agreement material.
--
-- Each participant device publishes ONE wrapped copy of the shared
-- conversation key, sealed to its own device public key. The server stores
-- only opaque wrapped blobs: it never sees an unwrapped key, and it cannot
-- derive one, because the private halves never leave the browser (IndexedDB).
--
-- `key_id` versions the conversation key. Rotating it (new device, revoked
-- device) inserts a new generation rather than mutating the old one, so
-- messages sealed under an earlier key stay decryptable until they expire.
-- ------------------------------------------------------------
CREATE TABLE conversation_keys (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  key_id          VARCHAR(64) NOT NULL,       -- generation id, echoed by messages.sender_key_id
  user_id         BIGINT UNSIGNED NOT NULL,   -- whose device can unwrap this copy
  device_id       CHAR(36) NOT NULL,
  wrapped_key     TEXT NOT NULL,              -- base64 AES-GCM-wrapped conversation key
  wrap_iv         VARCHAR(32) NOT NULL,
  sender_pub_key  VARCHAR(255) NOT NULL,      -- ephemeral ECDH public key used to wrap
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_conv_key_device (conversation_id, key_id, user_id, device_id),
  KEY idx_convkey_lookup (conversation_id, user_id, device_id),
  CONSTRAINT fk_convkey_conv FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_convkey_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- moments — 24h stories. Photo, video or text.
-- ------------------------------------------------------------
CREATE TABLE moments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  kind        ENUM('photo','video','text') NOT NULL,
  body        VARCHAR(500) NULL,
  media_url   VARCHAR(255) NULL,
  thumb_url   VARCHAR(255) NULL,
  media_key   VARCHAR(255) NULL,            -- storage key, for hard deletion
  thumb_key   VARCHAR(255) NULL,
  background  VARCHAR(24) NULL,             -- text moments: palette id
  view_count  INT UNSIGNED NOT NULL DEFAULT 0,
  deleted_at  DATETIME NULL,
  deleted_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_moments_user_time (user_id, expires_at, created_at),
  KEY idx_moments_expires (expires_at),
  KEY idx_moments_feed (expires_at, created_at),
  CONSTRAINT fk_moment_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE moment_views (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  moment_id  BIGINT UNSIGNED NOT NULL,
  viewer_id  BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_moment_view (moment_id, viewer_id),
  KEY idx_mview_viewer (viewer_id),
  CONSTRAINT fk_mview_moment FOREIGN KEY (moment_id) REFERENCES moments (id) ON DELETE CASCADE,
  CONSTRAINT fk_mview_user FOREIGN KEY (viewer_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE moment_reactions (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  moment_id  BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  emoji      VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_moment_reaction (moment_id, user_id),
  KEY idx_mreact_user (user_id),
  CONSTRAINT fk_mreact_moment FOREIGN KEY (moment_id) REFERENCES moments (id) ON DELETE CASCADE,
  CONSTRAINT fk_mreact_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- posts — 24h feed posts with optional media and polls.
-- ------------------------------------------------------------
CREATE TABLE posts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  body          VARCHAR(1000) NULL,
  like_count    INT UNSIGNED NOT NULL DEFAULT 0,
  comment_count INT UNSIGNED NOT NULL DEFAULT 0,
  deleted_at    DATETIME NULL,
  deleted_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_posts_user_time (user_id, expires_at, created_at),
  KEY idx_posts_expires (expires_at),
  KEY idx_posts_feed (expires_at, created_at),
  CONSTRAINT fk_post_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE post_media (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id    BIGINT UNSIGNED NOT NULL,
  kind       ENUM('photo','video') NOT NULL,
  url        VARCHAR(255) NOT NULL,
  thumb_url  VARCHAR(255) NULL,
  media_key  VARCHAR(255) NOT NULL,
  thumb_key  VARCHAR(255) NULL,
  position   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_postmedia_post (post_id, position),
  CONSTRAINT fk_postmedia_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE poll_options (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id    BIGINT UNSIGNED NOT NULL,
  label      VARCHAR(80) NOT NULL,
  position   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  vote_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_pollopt_post (post_id, position),
  CONSTRAINT fk_pollopt_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE poll_votes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id    BIGINT UNSIGNED NOT NULL,
  option_id  BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_poll_vote (post_id, user_id),
  KEY idx_pollvote_option (option_id),
  CONSTRAINT fk_pollvote_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_pollvote_option FOREIGN KEY (option_id) REFERENCES poll_options (id) ON DELETE CASCADE,
  CONSTRAINT fk_pollvote_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- comments — threaded one level deep (comment -> reply).
-- Inherit their parent post's expiry.
-- ------------------------------------------------------------
CREATE TABLE comments (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id    BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  parent_id  BIGINT UNSIGNED NULL,
  body       VARCHAR(500) NOT NULL,
  like_count INT UNSIGNED NOT NULL DEFAULT 0,
  deleted_at DATETIME NULL,
  deleted_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_comments_post (post_id, created_at),
  KEY idx_comments_parent (parent_id),
  KEY idx_comments_user (user_id),
  KEY idx_comments_expires (expires_at),
  CONSTRAINT fk_comment_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_comment_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_comment_parent FOREIGN KEY (parent_id) REFERENCES comments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- content_likes — ONE polymorphic like primitive for every
-- likeable surface. The UNIQUE key is what makes liking
-- idempotent: a double tap can never inflate a count.
-- ------------------------------------------------------------
CREATE TABLE content_likes (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  target_type ENUM('profile','photo','post','moment','comment') NOT NULL,
  target_id   BIGINT UNSIGNED NOT NULL,
  owner_id    BIGINT UNSIGNED NOT NULL,     -- denormalised: who receives the like
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_content_like (user_id, target_type, target_id),
  KEY idx_clike_target (target_type, target_id),
  KEY idx_clike_owner (owner_id, created_at),
  CONSTRAINT fk_clike_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_clike_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- content_reports — reporting for every surface, fixed taxonomy.
-- ------------------------------------------------------------
CREATE TABLE content_reports (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reporter_id  BIGINT UNSIGNED NOT NULL,
  target_type  ENUM('profile','message','photo','post','moment','comment') NOT NULL,
  target_id    BIGINT UNSIGNED NOT NULL,
  reported_user_id BIGINT UNSIGNED NULL,
  reason       ENUM('scam','fake','impersonation','harassment','spam','threats','inappropriate','ncii','other') NOT NULL,
  details      VARCHAR(1000) NULL,
  status       ENUM('open','reviewing','actioned','dismissed') NOT NULL DEFAULT 'open',
  priority     TINYINT UNSIGNED NOT NULL DEFAULT 0,   -- ncii/threats jump the queue
  handled_by   BIGINT UNSIGNED NULL,
  handled_at   DATETIME NULL,
  resolution   VARCHAR(255) NULL,
  snapshot     TEXT NULL,                   -- copy of the content, survives expiry
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_report_once (reporter_id, target_type, target_id),
  KEY idx_report_queue (status, priority, created_at),
  KEY idx_report_target (target_type, target_id),
  KEY idx_report_user (reported_user_id),
  CONSTRAINT fk_creport_reporter FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_creport_reported FOREIGN KEY (reported_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- notifications — persisted, deep-linkable, preference-gated.
-- ------------------------------------------------------------
CREATE TABLE notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  actor_id    BIGINT UNSIGNED NULL,
  kind        ENUM('match','message','profile_like','photo_like','post_like','post_comment',
                   'comment_reply','moment_reaction','moment_reply','verification','safety','system') NOT NULL,
  target_type VARCHAR(24) NULL,
  target_id   BIGINT UNSIGNED NULL,
  href        VARCHAR(255) NULL,            -- deep link
  body        VARCHAR(255) NULL,
  group_key   VARCHAR(120) NULL,            -- coalescing key, kills notification spam
  -- Two different questions, two different counters. `count` is how many
  -- events currently stand behind this row (a like that is withdrawn
  -- decrements it, and the row dies at zero). `unseen_count` is how many
  -- arrived since the user last read it, and resets to zero on read. Using
  -- one column for both made "mark read" silently withdraw likes.
  count        INT UNSIGNED NOT NULL DEFAULT 1,
  unseen_count INT UNSIGNED NOT NULL DEFAULT 1,
  read_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notif_user_time (user_id, created_at),
  KEY idx_notif_unread (user_id, read_at),
  UNIQUE KEY uniq_notif_group (user_id, group_key),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE notification_prefs (
  user_id          BIGINT UNSIGNED NOT NULL,
  matches          TINYINT(1) NOT NULL DEFAULT 1,
  messages         TINYINT(1) NOT NULL DEFAULT 1,
  likes            TINYINT(1) NOT NULL DEFAULT 1,
  comments         TINYINT(1) NOT NULL DEFAULT 1,
  moments          TINYINT(1) NOT NULL DEFAULT 1,
  posts            TINYINT(1) NOT NULL DEFAULT 1,
  safety           TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_notifpref_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- admin_audit_log — every privileged action, append-only.
-- ------------------------------------------------------------
CREATE TABLE admin_audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id    BIGINT UNSIGNED NOT NULL,
  action      VARCHAR(60) NOT NULL,
  target_type VARCHAR(24) NULL,
  target_id   BIGINT UNSIGNED NULL,
  detail      VARCHAR(500) NULL,
  ip          VARCHAR(64) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_actor (actor_id, created_at),
  KEY idx_audit_target (target_type, target_id),
  KEY idx_audit_time (created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
