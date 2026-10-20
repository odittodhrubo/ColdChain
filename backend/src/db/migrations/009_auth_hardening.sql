-- Account hardening (S2, S3).
-- S2: users change their own password; a generated or admin-set password must be changed at first sign-in;
--     a password change ends every session issued before it.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0; -- unix s; older sessions refused

-- S3: TOTP (RFC 6238). The secret is encrypted like device secrets (AES-GCM under APP_SECRET_KEY). It is set at
-- setup and only counts once confirmed with a valid code. totp_last_step stops a code from being used twice.
ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;

-- One-time recovery codes for a lost phone, shown once. Stored as SHA-256: they are random (about 59 bits), so
-- a slow password hash adds nothing but seconds per sign-in.
CREATE TABLE totp_recovery_codes (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users (id),
  code_hash TEXT NOT NULL,
  used_at   INTEGER
);
CREATE INDEX idx_totp_recovery_user ON totp_recovery_codes (user_id);
