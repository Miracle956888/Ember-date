-- Preserve issuance history while allowing one current verification code per kind.
-- Old rows are pruned only after leaving the rolling rate-limit window.
ALTER TABLE verification_tokens
  ADD COLUMN revoked_at DATETIME NULL AFTER used_at,
  ADD KEY idx_vtoken_active (user_id, kind, revoked_at, expires_at, id),
  ADD KEY idx_vtoken_send_window (user_id, kind, created_at),
  ADD KEY idx_vtoken_history (created_at);
