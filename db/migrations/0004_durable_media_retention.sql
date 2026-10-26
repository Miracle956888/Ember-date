-- Durable retries for every owned-media deletion path, and a short-lived
-- ownership record for social uploads until a post or moment claims them.
-- Never edit an applied migration; append a new numbered migration instead.

ALTER TABLE media_deletion_queue
  MODIFY COLUMN reason ENUM(
    'account_deleted',
    'verification_reviewed',
    'content_removed',
    'profile_photo_removed',
    'orphaned_upload'
  ) NOT NULL;

CREATE TABLE pending_social_uploads (
  upload_id   CHAR(36) NOT NULL,
  owner_id    BIGINT UNSIGNED NOT NULL,
  kind        ENUM('photo','video') NOT NULL,
  file_key    VARCHAR(255) NOT NULL,
  thumb_key   VARCHAR(255) NULL,
  media_url   VARCHAR(255) NOT NULL,
  thumb_url   VARCHAR(255) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  PRIMARY KEY (upload_id),
  UNIQUE KEY uniq_pending_social_file (file_key),
  KEY idx_pending_social_owner_expiry (owner_id, expires_at),
  KEY idx_pending_social_expiry (expires_at),
  CONSTRAINT fk_pending_social_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
