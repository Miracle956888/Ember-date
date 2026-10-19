-- Additive security, moderation, retention and audit capabilities.
-- Never edit an applied migration; append a new numbered migration instead.

ALTER TABLE users
  MODIFY COLUMN role ENUM('user','support_agent','analyst','moderator','auditor','admin','super_admin') NOT NULL DEFAULT 'user';

ALTER TABLE content_reports
  ADD COLUMN assigned_to BIGINT UNSIGNED NULL AFTER handled_by,
  ADD COLUMN assigned_at DATETIME NULL AFTER assigned_to,
  ADD KEY idx_report_assigned (assigned_to, status, created_at),
  ADD CONSTRAINT fk_creport_assignee FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL;

CREATE TABLE admin_report_notes (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id       BIGINT UNSIGNED NOT NULL,
  author_id       BIGINT UNSIGNED NULL,
  author_username VARCHAR(30) NOT NULL,
  note            VARCHAR(1000) NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_admin_report_notes (report_id, id),
  CONSTRAINT fk_admin_note_report FOREIGN KEY (report_id) REFERENCES content_reports (id) ON DELETE CASCADE,
  CONSTRAINT fk_admin_note_author FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE activity_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type      VARCHAR(80) NOT NULL,
  outcome         ENUM('success','failure','pending','info') NOT NULL DEFAULT 'info',
  actor_id        BIGINT UNSIGNED NULL,
  actor_username  VARCHAR(30) NULL,
  actor_role      VARCHAR(24) NULL,
  subject_user_id BIGINT UNSIGNED NULL,
  resource_type   VARCHAR(32) NULL,
  resource_id     BIGINT UNSIGNED NULL,
  source          ENUM('web','system','bootstrap') NOT NULL DEFAULT 'web',
  metadata        JSON NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_activity_time (created_at, id),
  KEY idx_activity_actor (actor_id, created_at),
  KEY idx_activity_subject (subject_user_id, created_at),
  KEY idx_activity_type (event_type, created_at),
  CONSTRAINT fk_activity_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_activity_subject FOREIGN KEY (subject_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE verification_challenges (
  challenge_id CHAR(36) NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  token_hash   CHAR(64) NOT NULL,
  gesture      VARCHAR(40) NOT NULL,
  expires_at   DATETIME NOT NULL,
  used_at      DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (challenge_id),
  KEY idx_verification_challenge_user (user_id, used_at, created_at),
  KEY idx_verification_challenge_expiry (expires_at),
  CONSTRAINT fk_verification_challenge_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE verifications
  MODIFY COLUMN file_path VARCHAR(255) NULL,
  ADD COLUMN challenge_id CHAR(36) NULL AFTER user_id,
  ADD UNIQUE KEY uniq_verification_challenge (challenge_id),
  ADD CONSTRAINT fk_verification_challenge_submission FOREIGN KEY (challenge_id) REFERENCES verification_challenges (challenge_id) ON DELETE SET NULL;

ALTER TABLE admin_audit_log
  ADD COLUMN actor_username VARCHAR(30) NULL AFTER actor_id;

ALTER TABLE admin_audit_log DROP FOREIGN KEY fk_audit_actor;
ALTER TABLE admin_audit_log MODIFY COLUMN actor_id BIGINT UNSIGNED NULL;
ALTER TABLE admin_audit_log
  ADD CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL;

CREATE TABLE media_deletion_queue (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  file_key         VARCHAR(255) NOT NULL,
  reason           ENUM('account_deleted','verification_reviewed') NOT NULL,
  attempts         INT UNSIGNED NOT NULL DEFAULT 0,
  last_attempt_at  DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_media_deletion_key_reason (file_key, reason),
  KEY idx_media_deletion_attempts (last_attempt_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE delivery_outbox (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind               ENUM('password_reset','email_verification','sms_verification') NOT NULL,
  status             ENUM('queued','processing','sent','failed') NOT NULL DEFAULT 'queued',
  payload_ciphertext MEDIUMTEXT NULL,
  payload_iv         CHAR(24) NULL,
  payload_tag        CHAR(24) NULL,
  attempts           TINYINT UNSIGNED NOT NULL DEFAULT 0,
  available_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempt_at    DATETIME NULL,
  last_error_code    VARCHAR(40) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at            DATETIME NULL,
  failed_at          DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_delivery_queue (status, available_at, id),
  KEY idx_delivery_lease (status, last_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Previous releases automatically granted the blue tick when a user uploaded
-- a pose selfie. That is not trusted verification: evidence was immediately
-- deleted and no reviewer checked the gesture. Revoke only those recorded
-- auto-approvals, leave profile photos and other account data untouched, and
-- expose the reason to the user so they may submit for manual review again.
INSERT INTO activity_events (event_type, outcome, subject_user_id, resource_type, resource_id, source, metadata)
SELECT 'verification.legacy_approval_revoked', 'info', u.id, 'profile', u.id, 'system',
       JSON_OBJECT('reason', 'legacy_auto_approval_replaced_by_manual_review')
  FROM users u
 WHERE u.is_verified = 1
   AND EXISTS (SELECT 1 FROM verifications v WHERE v.user_id = u.id AND v.status = 'approved');

UPDATE users u
   SET u.is_verified = 0, u.verified_at = NULL
 WHERE u.is_verified = 1
   AND EXISTS (SELECT 1 FROM verifications v WHERE v.user_id = u.id AND v.status = 'approved');

UPDATE verifications
   SET status = 'rejected',
       reviewed_at = COALESCE(reviewed_at, NOW()),
       note = 'Legacy automatic approval revoked; resubmit for manual review.'
 WHERE status = 'approved';

INSERT IGNORE INTO media_deletion_queue (file_key, reason)
SELECT file_path, 'verification_reviewed'
  FROM verifications
 WHERE status <> 'pending' AND file_path IS NOT NULL;

-- The durable queue now owns the deletion; do not retain evidence keys on closed
-- submissions after moving their files out of reviewer access.
UPDATE verifications
   SET file_path = NULL
 WHERE status <> 'pending' AND file_path IS NOT NULL;
