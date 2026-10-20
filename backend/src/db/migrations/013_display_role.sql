-- P1: wall-display (kiosk) tokens are a read-only DISPLAY principal. They are stored as password-less users rows
-- with role 'DISPLAY', so the whole auth, RBAC and revocation machinery applies unchanged (writes are refused by
-- the permission matrix; revoking a display sets active = 0, which the auth middleware re-reads every request).
-- The role CHECK must allow DISPLAY, so the users table is rebuilt. defer_foreign_keys delays FK enforcement to
-- COMMIT, by when the renamed table holds the same ids, so children (batches.created_by, alerts.acknowledged_by,
-- relocations.decided_by, totp_recovery_codes.user_id) stay valid even on a populated database.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE users_new (
  id                   INTEGER PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('ADMIN', 'PHARMACIST', 'INSPECTOR', 'DISPLAY')),
  password_hash        TEXT NOT NULL,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  password_changed_at  INTEGER NOT NULL DEFAULT 0,
  totp_secret_enc      TEXT,
  totp_enabled         INTEGER NOT NULL DEFAULT 0,
  totp_last_step       INTEGER NOT NULL DEFAULT 0
);
INSERT INTO users_new
  SELECT id, email, name, role, password_hash, active, created_at, updated_at,
         must_change_password, password_changed_at, totp_secret_enc, totp_enabled, totp_last_step
  FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
